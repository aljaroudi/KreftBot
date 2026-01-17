import { spawn } from 'bun';
import { Platform, Format, ContentInfo } from '../types';
import { isValidUrl } from '../utils/validation';
import { logger } from '../utils/logger';
import { withRetry, isRetryableError, BotError, ErrorType, parseFileSize } from '../utils/errors';
import { config } from '../config';

export class DownloadService {
  private static readonly PLATFORM_PATTERNS: Record<string, RegExp[]> = {
    [Platform.YouTube]: [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)/i,
    ],
    [Platform.Twitter]: [
      /(?:twitter\.com|x\.com)\/.+\/status\//i,
    ],
    [Platform.Instagram]: [
      /instagram\.com\/(?:p|reel)\//i,
    ],
    [Platform.Reddit]: [
      /(?:reddit\.com\/r\/|v\.redd\.it)/i,
    ],
    [Platform.TikTok]: [
      /(?:tiktok\.com|vm\.tiktok\.com)/i,
    ],
  };

  /**
   * Detects the platform from a URL
   */
  detectPlatform(url: string): Platform | null {
    if (!isValidUrl(url)) {
      return null;
    }

    for (const [platform, patterns] of Object.entries(DownloadService.PLATFORM_PATTERNS)) {
      for (const pattern of patterns) {
        if (pattern.test(url)) {
          return platform as Platform;
        }
      }
    }

    return null;
  }

  /**
   * Fetches available formats for a URL using yt-dlp with retry
   */
  async fetchAvailableFormats(url: string): Promise<Format[]> {
    logger.info({ url }, 'Fetching available formats');

    return withRetry(
      async () => {
        const proc = spawn(['yt-dlp', '-F', url], {
          stdout: 'pipe',
          stderr: 'pipe',
        });

        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;

        if (exitCode !== 0) {
          logger.error({ stderr, exitCode }, 'yt-dlp format fetch failed');
          const error = new Error(`Failed to fetch formats: ${stderr}`);

          // Only retry if error is network-related
          if (!isRetryableError(error)) {
            throw new BotError(ErrorType.DOWNLOAD_FAILED, error.message, { url }, error);
          }
          throw error;
        }

        logger.debug({ output: stdout }, 'yt-dlp format output');
        return this.parseFormats(stdout);
      },
      { maxAttempts: 2 }, // Only retry once for format fetching
      (attempt, error) => {
        logger.warn({ attempt, error, url }, 'Retrying format fetch');
      }
    );
  }

  /**
   * Validate file size before download
   */
  validateFileSize(fileSize: number | undefined): void {
    if (!fileSize) {
      // Can't validate unknown file size
      return;
    }

    const maxSizeBytes = config.maxFileSizeMB * 1024 * 1024;
    const fileSizeMB = Math.round((fileSize / (1024 * 1024)) * 10) / 10;

    if (fileSize > maxSizeBytes) {
      throw new BotError(
        ErrorType.FILE_TOO_LARGE,
        'File size exceeds limit',
        { size: fileSizeMB, limit: config.maxFileSizeMB }
      );
    }
  }

  /**
   * Downloads content using yt-dlp with retry and size validation
   */
  async downloadContent(url: string, formatId: string, outputPath: string, expectedSize?: number): Promise<string> {
    logger.info({ url, formatId, outputPath, expectedSize }, 'Starting download');

    // Validate file size if known
    if (expectedSize) {
      this.validateFileSize(expectedSize);
    }

    return withRetry(
      async () => {
        const proc = spawn(['yt-dlp', '-f', formatId, '-o', outputPath, url], {
          stdout: 'pipe',
          stderr: 'pipe',
        });

        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;

        if (exitCode !== 0) {
          logger.error({ stderr, exitCode }, 'yt-dlp download failed');
          const error = new Error(`Download failed: ${stderr}`);

          // Check if error is retryable
          if (!isRetryableError(error)) {
            throw new BotError(ErrorType.DOWNLOAD_FAILED, error.message, { url, formatId }, error);
          }
          throw error;
        }

        logger.info({ outputPath }, 'Download completed');
        return outputPath;
      },
      { maxAttempts: 3 }, // Retry up to 3 times for downloads
      (attempt, error) => {
        logger.warn({ attempt, error, url, formatId }, 'Retrying download');
      }
    );
  }

  /**
   * Gets content information using yt-dlp
   */
  async getContentInfo(url: string): Promise<ContentInfo> {
    logger.info({ url }, 'Fetching content info');

    try {
      const proc = spawn(['yt-dlp', '--dump-json', '--no-playlist', url], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        logger.error({ stderr, exitCode }, 'yt-dlp info fetch failed');
        throw new Error(`Failed to fetch info: ${stderr}`);
      }

      const info = JSON.parse(stdout);

      return {
        title: info.title || 'Unknown',
        duration: info.duration,
        thumbnail: info.thumbnail,
        uploader: info.uploader || info.channel,
        url,
      };
    } catch (error) {
      logger.error({ error, url }, 'Error fetching content info');
      throw new Error(`Failed to fetch content info: ${error}`);
    }
  }

  /**
   * Parses yt-dlp format output into structured Format objects
   */
  private parseFormats(output: string): Format[] {
    const formats: Format[] = [];
    const lines = output.split('\n');

    // Skip header lines and find where format data starts
    let formatSectionStarted = false;

    for (const line of lines) {
      // Format lines typically start with format ID
      if (!formatSectionStarted) {
        if (line.includes('ID') && line.includes('EXT')) {
          formatSectionStarted = true;
        }
        continue;
      }

      // Skip empty lines, warnings, and separators
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('WARNING') || trimmed.startsWith('player') || trimmed.includes('----')) {
        continue;
      }

      // Parse format line - new format: ID EXT RESOLUTION FPS | FILESIZE TBR PROTO | VCODEC VBR ACODEC MORE_INFO
      const parts = trimmed.split(/\s+/);
      if (parts.length < 3) {
        continue;
      }

      const formatId = parts[0];
      const extension = parts[1];
      const resolution = parts[2];

      // Skip if format ID looks like a header
      if (formatId === 'ID' || !formatId.match(/^\d+$/)) {
        continue;
      }

      // Determine if audio only or video only
      const isAudioOnly = resolution.toLowerCase().includes('audio');
      const isVideoOnly = line.toLowerCase().includes('video only');

      // Extract quality info
      let quality = 'unknown';
      if (isAudioOnly) {
        quality = 'audio only';
      } else {
        // Extract resolution from format like "320x240"
        const resolutionMatch = resolution.match(/(\d{3,4})x(\d{3,4})/);
        if (resolutionMatch) {
          quality = `${resolutionMatch[2]}p`;
        }
      }

      // Try to extract file size (appears after | in format like "~323.70KiB")
      let fileSize: number | undefined;
      const sizeMatch = line.match(/~?\s*(\d+(?:\.\d+)?)(KiB|MiB|GiB)/);
      if (sizeMatch) {
        const size = parseFloat(sizeMatch[1]);
        const unit = sizeMatch[2];
        fileSize = unit === 'GiB' ? size * 1024 * 1024 * 1024 :
                   unit === 'MiB' ? size * 1024 * 1024 :
                   size * 1024;
      }

      // Build description
      let emoji = '📹';
      if (isAudioOnly) {
        emoji = '🎵';
      } else if (quality.includes('1080') || quality.includes('2160') || quality.includes('4320')) {
        emoji = '🎬';
      }

      const sizeStr = fileSize ? ` - ${this.formatFileSize(fileSize)}` : '';
      const description = `${emoji} ${quality} (${extension})${sizeStr}`;

      formats.push({
        formatId,
        quality,
        extension,
        fileSize,
        description,
        isAudioOnly,
        isVideoOnly,
      });
    }

    logger.info({ count: formats.length }, 'Parsed formats');
    return formats;
  }

  /**
   * Formats file size in human-readable format
   */
  private formatFileSize(bytes: number): string {
    if (bytes >= 1024 * 1024 * 1024) {
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
    }
    if (bytes >= 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    }
    if (bytes >= 1024) {
      return `${(bytes / 1024).toFixed(1)}KB`;
    }
    return `${bytes}B`;
  }
}
