import { Bot, Context } from 'grammy';
import { InputFile } from 'grammy';
import { spawn } from 'bun';
import { readdir } from 'fs/promises';
import { join } from 'path';
import { DownloadService } from '../services/DownloadService';
import { DownloadProgress } from '../utils/progress';
import { RateLimiter } from '../utils/rateLimiter';
import { buildFormatSelectionKeyboard } from '../utils/keyboardBuilder';
import { getTempFilePath, cleanupFile, createTempDir } from '../utils/fileManager';
import { isValidUrl } from '../utils/validation';
import { logger } from '../utils/logger';
import { config } from '../config';
import { VideoTransformService } from '../services/VideoTransformService';

// Global rate limiter instance
const rateLimiter = new RateLimiter(config.maxConcurrentDownloads);

// Track active downloads for progress updates
const activeDownloads = new Map<string, DownloadProgress>();

// Store URLs temporarily for callback handling (messageId -> url)
// In production, use a proper session storage with expiration
const urlCache = new Map<number, string>();

/**
 * Registers download-related handlers on the bot
 */
export function registerDownloadHandlers(bot: Bot): void {
  // Handle URL messages
  bot.on('message:text', async (ctx, next) => {
    const text = ctx.message.text;

    // Check if message contains a URL
    if (!isValidUrl(text)) {
      return next(); // Not a URL, pass to next handler
    }

    await handleUrlMessage(ctx, text);
  });

  // Handle format selection callbacks
  bot.on('callback_query:data', async (ctx, next) => {
    const data = ctx.callbackQuery.data;

    if (data.startsWith('download:')) {
      await handleFormatSelection(ctx, data);
    } else {
      await next();
    }
  });
}

/**
 * Handles incoming URL messages
 */
async function handleUrlMessage(ctx: Context, url: string): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply('❌ Unable to identify user');
    return;
  }

  const downloadService = new DownloadService();

  // Detect platform
  const platform = downloadService.detectPlatform(url);
  if (!platform) {
    await ctx.reply(
      '❌ Sorry, this URL is not supported.\n\n' +
      'Supported platforms:\n' +
      '• YouTube\n' +
      '• Twitter/X\n' +
      '• Instagram\n' +
      '• Reddit\n' +
      '• TikTok'
    );
    return;
  }

  logger.info({ userId, url, platform }, 'Processing download request');

  // Show analyzing message
  const analyzingMsg = await ctx.reply('🔍 Analyzing content...');

  try {
    // Fetch available formats
    const formats = await downloadService.fetchAvailableFormats(url);

    if (formats.length === 0) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        analyzingMsg.message_id,
        '❌ No downloadable formats found for this URL'
      );
      return;
    }

    // Build format selection keyboard
    const keyboard = buildFormatSelectionKeyboard(formats);

    // Get content info for better UX
    let contentInfo;
    try {
      contentInfo = await downloadService.getContentInfo(url);
    } catch (error) {
      logger.warn({ error }, 'Failed to fetch content info, continuing without it');
    }

    // Update message with format selection
    let selectionMessage = '📥 Select format to download:\n\n';
    if (contentInfo) {
      selectionMessage += `📺 **${contentInfo.title}**\n`;
      if (contentInfo.uploader) {
        selectionMessage += `👤 ${contentInfo.uploader}\n`;
      }
      if (contentInfo.duration) {
        const minutes = Math.floor(contentInfo.duration / 60);
        const seconds = Math.floor(contentInfo.duration % 60);
        selectionMessage += `⏱️ ${minutes}:${seconds.toString().padStart(2, '0')}\n`;
      }
      selectionMessage += '\n';
    }
    selectionMessage += 'Choose your preferred format:';

    await ctx.api.editMessageText(
      ctx.chat.id,
      analyzingMsg.message_id,
      selectionMessage,
      { reply_markup: keyboard }
    );

    // Store URL for callback handling
    urlCache.set(analyzingMsg.message_id, url);

    // Auto-cleanup URL from cache after 10 minutes
    setTimeout(() => {
      urlCache.delete(analyzingMsg.message_id);
    }, 10 * 60 * 1000);

  } catch (error) {
    logger.error({ error, url, userId }, 'Error fetching formats');

    let errorMessage = '❌ Failed to analyze content. ';
    if (error instanceof Error) {
      if (error.message.includes('private') || error.message.includes('not available')) {
        errorMessage += 'This content may be private or has been deleted.';
      } else {
        errorMessage += 'Please try again later.';
      }
    }

    await ctx.api.editMessageText(
      ctx.chat.id,
      analyzingMsg.message_id,
      errorMessage
    );
  }
}

/**
 * Handles format selection callback
 */
async function handleFormatSelection(ctx: Context, callbackData: string): Promise<void> {
  await ctx.answerCallbackQuery();

  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply('❌ Unable to identify user');
    return;
  }

  // Extract format ID from callback data
  const formatId = callbackData.replace('download:', '');

  // Get original message ID to retrieve URL
  const messageId = ctx.callbackQuery?.message?.message_id;
  if (!messageId) {
    await ctx.reply('❌ Unable to find original message');
    return;
  }

  // Retrieve URL from cache
  const url = urlCache.get(messageId);
  if (!url) {
    await ctx.editMessageText('❌ Session expired. Please send the URL again.');
    return;
  }

  // Edit message to show we're starting download
  await ctx.editMessageText('⏳ Preparing download...');

  // Check rate limit
  const activeCount = rateLimiter.getActiveCount(userId);

  if (activeCount >= config.maxConcurrentDownloads) {
    const queuePosition = rateLimiter.getQueuePosition(userId);
    await ctx.editMessageText(
      `⏳ You have ${activeCount} active download(s).\n` +
      `You're #${queuePosition} in queue. Please wait...`
    );
  }

  let release: (() => void) | null = null;

  try {
    // Acquire download slot (this will wait if user is at limit)
    release = await rateLimiter.acquire(userId);

    // Start download
    await downloadContent(ctx, url, formatId, userId);

  } catch (error) {
    logger.error({ error, userId, formatId, url }, 'Error during download');

    let errorMessage = '❌ Download failed.';
    if (error instanceof Error) {
      if (error.message.includes('Request cancelled')) {
        errorMessage = '❌ Download was cancelled.';
      }
    }

    try {
      await ctx.editMessageText(errorMessage);
    } catch {
      await ctx.reply(errorMessage);
    }
  } finally {
    // Release download slot
    if (release) {
      release();
    }

    // Clean up URL from cache
    urlCache.delete(messageId);
  }
}

/**
 * Downloads content with progress tracking
 */
async function downloadContent(
  ctx: Context,
  url: string,
  formatId: string,
  userId: number
): Promise<void> {
  const progress = new DownloadProgress(ctx);
  const downloadKey = `${userId}-${Date.now()}`;
  activeDownloads.set(downloadKey, progress);

  let downloadedFile: string | null = null;

  try {
    // Ensure temp directory exists
    await createTempDir();

    // Generate unique filename prefix
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    const prefix = `${timestamp}-${random}`;
    const outputTemplate = join(config.tempDir, `${prefix}-%(title)s.%(ext)s`);

    // Start progress tracking
    await progress.start();

    // Use special format selector for audio extraction (smallest video + best audio)
    const actualFormatId = formatId === 'extract_audio' ? 'worstvideo+bestaudio' : formatId;

    // Spawn yt-dlp with progress reporting
    const args = [
      'yt-dlp',
      '-f', actualFormatId,
      '-o', outputTemplate,
      '--newline',
      '--progress',
      '--no-playlist',
      '--max-filesize', `${config.maxFileSizeMB}m`,
      url
    ];

    logger.info({ args }, 'Starting yt-dlp');

    const proc = spawn(args, {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Track progress and capture output
    const decoder = new TextDecoder();
    let stdoutBuffer = '';
    let stderrBuffer = '';

    // Read stdout for destination info
    const stdoutPromise = (async () => {
      if (proc.stdout) {
        for await (const chunk of proc.stdout) {
          const text = decoder.decode(chunk);
          stdoutBuffer += text;

          // Look for destination line to get actual filename
          const destMatch = text.match(/\[download\] Destination: (.+)/);
          if (destMatch) {
            downloadedFile = destMatch[1].trim();
            logger.info({ downloadedFile }, 'Found download destination');
          }
        }
      }
    })();

    // Read stderr for progress updates
    const stderrPromise = (async () => {
      if (proc.stderr) {
        for await (const chunk of proc.stderr) {
          const text = decoder.decode(chunk);
          stderrBuffer += text;

          // Process line by line
          const lines = stderrBuffer.split('\n');
          stderrBuffer = lines.pop() || ''; // Keep incomplete line

          for (const line of lines) {
            const progressInfo = progress.parseProgress(line);
            if (progressInfo) {
              await progress.update(progressInfo);
            }
          }
        }
      }
    })();

    // Wait for all streams to complete
    await Promise.all([stdoutPromise, stderrPromise]);

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      logger.error({ stdoutBuffer, stderrBuffer, exitCode }, 'yt-dlp download failed');

      let errorMessage = 'Download failed.';
      const combinedOutput = stdoutBuffer + stderrBuffer;

      if (combinedOutput.includes('private') || combinedOutput.includes('not available')) {
        errorMessage = 'This content is private or has been deleted.';
      } else if (combinedOutput.includes('timeout') || combinedOutput.includes('timed out')) {
        errorMessage = 'Download timed out. Try a different format.';
      } else if (combinedOutput.includes('File is larger than max-filesize')) {
        errorMessage = `File is larger than ${config.maxFileSizeMB}MB limit.`;
      } else if (combinedOutput.includes('Unsupported URL')) {
        errorMessage = 'This URL format is not supported.';
      }

      await progress.error(errorMessage);
      return;
    }

    // Find the downloaded file if we didn't capture it from output
    if (!downloadedFile) {
      const files = await readdir(config.tempDir);
      const matchingFiles = files.filter(f => f.startsWith(prefix));

      if (matchingFiles.length > 0) {
        downloadedFile = join(config.tempDir, matchingFiles[0]);
        logger.info({ downloadedFile }, 'Found download file by prefix');
      }
    }

    if (!downloadedFile) {
      logger.error({ stdoutBuffer }, 'Could not determine downloaded file path');
      await progress.error('Download completed but file not found.');
      return;
    }

    // Mark as complete
    await progress.complete();

    // Handle audio extraction if formatId is 'extract_audio'
    if (formatId === 'extract_audio') {
      logger.info({ downloadedFile, userId }, 'Extracting audio from video');

      try {
        const videoService = new VideoTransformService();
        const audioPath = await videoService.extractAudio(downloadedFile, 'mp3');

        // Send audio file to user
        logger.info({ audioPath, userId }, 'Sending extracted audio to user');
        await ctx.replyWithAudio(new InputFile(audioPath));

        // Cleanup both video and audio files
        await cleanupFile(downloadedFile);
        await cleanupFile(audioPath);
      } catch (error) {
        logger.error({ error, downloadedFile }, 'Failed to extract audio');
        await ctx.reply('❌ Failed to extract audio from video. Please try again.');
        await cleanupFile(downloadedFile);
      }
      return;
    }

    // Send file to user
    logger.info({ downloadedFile, userId }, 'Sending file to user');

    try {
      await ctx.replyWithDocument(new InputFile(downloadedFile));
    } catch (sendError) {
      logger.error({ error: sendError, downloadedFile }, 'Failed to send file');

      // Check if file is too large for Telegram
      if (sendError instanceof Error && sendError.message.includes('too large')) {
        await ctx.reply(
          '❌ File is too large for Telegram (max 50MB for regular bots).\n' +
          'Try selecting a lower quality format or use /extract_audio to get just the audio.'
        );
      } else {
        await ctx.reply('❌ Failed to send file. Please try again.');
      }
    }

    // Cleanup downloaded file
    await cleanupFile(downloadedFile);

  } catch (error) {
    logger.error({ error, url, formatId, userId }, 'Unexpected error during download');
    await progress.error('An unexpected error occurred.');

    // Cleanup if file was created
    if (downloadedFile) {
      await cleanupFile(downloadedFile);
    }
  } finally {
    activeDownloads.delete(downloadKey);
  }
}
