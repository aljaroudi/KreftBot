import { spawn } from 'bun';
import { join } from 'path';
import { stat } from 'fs/promises';
import { VideoInfo } from '../types';
import { logger } from '../utils/logger';
import { getTempFilePath, cleanupFile, createTempDir } from '../utils/fileManager';

export class VideoTransformService {
  /**
   * Get video metadata using FFprobe
   */
  async getVideoInfo(videoPath: string): Promise<VideoInfo> {
    try {
      const proc = spawn([
        'ffprobe',
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        videoPath
      ]);

      const output = await new Response(proc.stdout).text();
      const data = JSON.parse(output);

      const videoStream = data.streams?.find((s: any) => s.codec_type === 'video');
      const audioStream = data.streams?.find((s: any) => s.codec_type === 'audio');

      if (!videoStream) {
        throw new Error('No video stream found');
      }

      const duration = parseFloat(data.format?.duration || '0');
      const fileStat = await stat(videoPath);
      const bitrate = parseInt(data.format?.bit_rate || '0') / 1000; // Convert to kbps
      const audioBitrate = audioStream ? parseInt(audioStream.bit_rate || '128000') / 1000 : 0;

      return {
        duration,
        fileSize: fileStat.size,
        width: videoStream.width || 0,
        height: videoStream.height || 0,
        codec: videoStream.codec_name || 'unknown',
        bitrate,
        audioBitrate,
        hasAudio: !!audioStream,
      };
    } catch (error) {
      logger.error({ error, videoPath }, 'Failed to get video info');
      throw new Error('Failed to get video information');
    }
  }

  /**
   * Extract audio from video
   */
  async extractAudio(
    videoPath: string,
    outputFormat: 'mp3' | 'm4a' = 'mp3'
  ): Promise<string> {
    await createTempDir();
    const outputPath = getTempFilePath(`audio.${outputFormat}`);

    try {
      const args = [
        '-i', videoPath,
        '-vn', // No video
        '-acodec', outputFormat === 'mp3' ? 'libmp3lame' : 'aac',
        '-q:a', '2', // High quality
        outputPath
      ];

      logger.info({ videoPath, outputPath, format: outputFormat }, 'Extracting audio');

      const proc = spawn(['ffmpeg', '-y', ...args], {
        stderr: 'pipe',
      });

      const stderr = await new Response(proc.stderr).text();
      await proc.exited;

      if (proc.exitCode !== 0) {
        logger.error({ stderr, exitCode: proc.exitCode }, 'FFmpeg audio extraction failed');
        throw new Error('Audio extraction failed');
      }

      logger.info({ outputPath }, 'Audio extracted successfully');
      return outputPath;
    } catch (error) {
      logger.error({ error, videoPath }, 'Failed to extract audio');
      await cleanupFile(outputPath);
      throw new Error('Failed to extract audio from video');
    }
  }

  /**
   * Calculate target bitrate for video compression
   */
  private calculateTargetBitrate(
    targetSizeMB: number,
    durationSeconds: number,
    audioBitrate: number = 128
  ): number {
    const targetSizeKb = targetSizeMB * 8192; // Convert MB to kilobits
    const totalBitrate = targetSizeKb / durationSeconds;
    const videoBitrate = totalBitrate - audioBitrate;
    return Math.max(videoBitrate, 100); // Minimum 100kbps
  }

  /**
   * Estimate the resolution after optimization to target size
   * Returns the estimated height (e.g., 1080, 720, 480)
   */
  async estimateOptimizedResolution(
    videoPath: string,
    targetSizeMB: number
  ): Promise<number> {
    try {
      const videoInfo = await this.getVideoInfo(videoPath);
      const currentSizeMB = videoInfo.fileSize / (1024 * 1024);

      // If target is larger than current, no resolution change needed
      if (targetSizeMB >= currentSizeMB) {
        return videoInfo.height;
      }

      // Calculate compression ratio
      const compressionRatio = targetSizeMB / currentSizeMB;

      // Estimate resolution based on compression ratio
      // Since bitrate correlates roughly with pixel count, we can estimate:
      // new_pixels = old_pixels * sqrt(compressionRatio)
      const estimatedHeight = Math.round(videoInfo.height * Math.sqrt(compressionRatio));

      // Common video resolutions
      const commonResolutions = [2160, 1440, 1080, 720, 480, 360, 240];

      // Find the closest common resolution
      let closestResolution = estimatedHeight;
      let minDiff = Infinity;

      for (const res of commonResolutions) {
        const diff = Math.abs(res - estimatedHeight);
        if (diff < minDiff && res <= videoInfo.height) {
          minDiff = diff;
          closestResolution = res;
        }
      }

      logger.info({ 
        originalHeight: videoInfo.height, 
        targetSizeMB, 
        estimatedHeight: closestResolution 
      }, 'Estimated optimized resolution');

      return closestResolution;
    } catch (error) {
      logger.error({ error, videoPath, targetSizeMB }, 'Failed to estimate optimized resolution');
      throw new Error('Failed to estimate optimized resolution');
    }
  }

  /**
   * Optimize video to target file size using two-pass encoding
   */
  async optimizeVideo(
    videoPath: string,
    targetSizeMB: number
  ): Promise<string> {
    try {
      await createTempDir();
      const videoInfo = await this.getVideoInfo(videoPath);
      const currentSizeMB = videoInfo.fileSize / (1024 * 1024);

      // Check if video is already smaller than target
      if (currentSizeMB <= targetSizeMB) {
        throw new Error(`Video is already smaller than target size (${currentSizeMB.toFixed(2)}MB)`);
      }

      // Check if target is reasonable
      if (targetSizeMB < 1) {
        throw new Error('Target size too small. Minimum recommended: 1MB');
      }

      const targetBitrate = this.calculateTargetBitrate(
        targetSizeMB,
        videoInfo.duration,
        videoInfo.audioBitrate || 128
      );

      logger.info(
        { videoPath, targetSizeMB, targetBitrate, duration: videoInfo.duration },
        'Starting video optimization'
      );

      const outputPath = getTempFilePath('optimized.mp4');
      const logFile = getTempFilePath('ffmpeg2pass');

      // Pass 1: Analysis
      const pass1Args = [
        '-i', videoPath,
        '-c:v', 'libx264',
        '-b:v', `${targetBitrate}k`,
        '-pass', '1',
        '-preset', 'medium',
        '-an', // No audio in first pass
        '-f', 'null',
        '/dev/null'
      ];

      logger.info('Running two-pass encoding - Pass 1');
      const proc1 = spawn(['ffmpeg', '-y', '-passlogfile', logFile, ...pass1Args], {
        stderr: 'pipe',
      });

      await proc1.exited;

      if (proc1.exitCode !== 0) {
        const stderr = await new Response(proc1.stderr).text();
        logger.error({ stderr, exitCode: proc1.exitCode }, 'FFmpeg pass 1 failed');
        throw new Error('Video optimization pass 1 failed');
      }

      // Pass 2: Encoding
      const pass2Args = [
        '-i', videoPath,
        '-c:v', 'libx264',
        '-b:v', `${targetBitrate}k`,
        '-pass', '2',
        '-preset', 'medium',
        '-c:a', 'aac',
        '-b:a', `${videoInfo.audioBitrate || 128}k`,
        outputPath
      ];

      logger.info('Running two-pass encoding - Pass 2');
      const proc2 = spawn(['ffmpeg', '-y', '-passlogfile', logFile, ...pass2Args], {
        stderr: 'pipe',
      });

      await proc2.exited;

      if (proc2.exitCode !== 0) {
        const stderr = await new Response(proc2.stderr).text();
        logger.error({ stderr, exitCode: proc2.exitCode }, 'FFmpeg pass 2 failed');
        throw new Error('Video optimization pass 2 failed');
      }

      // Cleanup log files
      await cleanupFile(`${logFile}-0.log`);
      await cleanupFile(`${logFile}-0.log.mbtree`);

      const outputStat = await stat(outputPath);
      const outputSizeMB = outputStat.size / (1024 * 1024);

      logger.info(
        { outputPath, outputSizeMB, targetSizeMB },
        'Video optimized successfully'
      );

      return outputPath;
    } catch (error) {
      logger.error({ error, videoPath, targetSizeMB }, 'Failed to optimize video');
      throw error;
    }
  }

  /**
   * Compress video with progress callback
   */
  async compressWithProgress(
    videoPath: string,
    targetSizeMB: number,
    onProgress: (percent: number) => void
  ): Promise<string> {
    try {
      await createTempDir();
      const videoInfo = await this.getVideoInfo(videoPath);
      const currentSizeMB = videoInfo.fileSize / (1024 * 1024);

      if (currentSizeMB <= targetSizeMB) {
        throw new Error(`Video is already smaller than target size (${currentSizeMB.toFixed(2)}MB)`);
      }

      if (targetSizeMB < 1) {
        throw new Error('Target size too small. Minimum recommended: 1MB');
      }

      const targetBitrate = this.calculateTargetBitrate(
        targetSizeMB,
        videoInfo.duration,
        videoInfo.audioBitrate || 128
      );

      const outputPath = getTempFilePath('optimized.mp4');
      const logFile = getTempFilePath('ffmpeg2pass');

      // Pass 1 with progress
      logger.info('Running two-pass encoding with progress - Pass 1');
      await this.runFFmpegWithProgress(
        [
          '-i', videoPath,
          '-c:v', 'libx264',
          '-b:v', `${targetBitrate}k`,
          '-pass', '1',
          '-preset', 'medium',
          '-passlogfile', logFile,
          '-an',
          '-f', 'null',
          '/dev/null'
        ],
        videoInfo.duration,
        (percent) => onProgress(percent * 0.5) // First pass is 0-50%
      );

      // Pass 2 with progress
      logger.info('Running two-pass encoding with progress - Pass 2');
      await this.runFFmpegWithProgress(
        [
          '-i', videoPath,
          '-c:v', 'libx264',
          '-b:v', `${targetBitrate}k`,
          '-pass', '2',
          '-preset', 'medium',
          '-passlogfile', logFile,
          '-c:a', 'aac',
          '-b:a', `${videoInfo.audioBitrate || 128}k`,
          outputPath
        ],
        videoInfo.duration,
        (percent) => onProgress(50 + percent * 0.5) // Second pass is 50-100%
      );

      // Cleanup log files
      await cleanupFile(`${logFile}-0.log`);
      await cleanupFile(`${logFile}-0.log.mbtree`);

      const outputStat = await stat(outputPath);
      const outputSizeMB = outputStat.size / (1024 * 1024);

      logger.info(
        { outputPath, outputSizeMB, targetSizeMB },
        'Video compressed successfully with progress tracking'
      );

      return outputPath;
    } catch (error) {
      logger.error({ error, videoPath, targetSizeMB }, 'Failed to compress video with progress');
      throw error;
    }
  }

  /**
   * Run FFmpeg with progress tracking
   */
  private async runFFmpegWithProgress(
    args: string[],
    totalDuration: number,
    onProgress: (percent: number) => void
  ): Promise<void> {
    const proc = spawn(['ffmpeg', '-y', '-progress', 'pipe:2', ...args], {
      stderr: 'pipe',
    });

    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          // Parse time from FFmpeg progress output
          const timeMatch = line.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/);
          if (timeMatch) {
            const hours = parseInt(timeMatch[1]);
            const minutes = parseInt(timeMatch[2]);
            const seconds = parseFloat(timeMatch[3]);
            const currentTime = hours * 3600 + minutes * 60 + seconds;
            const percent = Math.min((currentTime / totalDuration) * 100, 100);
            onProgress(percent);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    await proc.exited;

    if (proc.exitCode !== 0) {
      throw new Error(`FFmpeg process failed with exit code ${proc.exitCode}`);
    }
  }
}
