import { Bot, Context, InlineKeyboard, InputFile } from 'grammy';
import { hydrateFiles } from '@grammyjs/files';
import { VideoTransformService } from '../services/VideoTransformService';
import { logger } from '../utils/logger';
import { createTempDir, getTempFilePath, cleanupFile } from '../utils/fileManager';
import { writeFile } from 'fs/promises';

const videoService = new VideoTransformService();

// Store user states for custom size input
const userStates = new Map<number, { type: string; videoPath: string }>();

/**
 * Register video transformation handlers
 */
export function registerVideoHandlers(bot: Bot): void {
  // Enable file plugin
  bot.api.config.use(hydrateFiles(bot.token));

  // Handle video uploads
  bot.on('message:video', handleVideoUpload);

  // Handle callback queries for transformations
  bot.on('callback_query:data', async (ctx, next) => {
    const data = ctx.callbackQuery?.data;
    if (data?.startsWith('video:')) {
      await handleCallbackQuery(ctx);
    } else {
      await next();
    }
  });

  // Handle custom size input
  bot.on('message:text', handleCustomSizeInput);

  logger.info('Video handlers registered');
}

/**
 * Handle video file uploads
 */
async function handleVideoUpload(ctx: Context): Promise<void> {
  try {
    if (!ctx.message?.video) return;

    const video = ctx.message.video;
    const fileSize = video.file_size || 0;
    const fileSizeMB = fileSize / (1024 * 1024);

    logger.info({ fileSize, fileSizeMB, userId: ctx.from?.id }, 'Received video upload');

    // Check file size limit (50MB)
    if (fileSizeMB > 50) {
      await ctx.reply('⚠️ Video is too large. Maximum supported size is 50MB.');
      return;
    }

    // Download video
    const statusMsg = await ctx.reply('📥 Downloading video...');

    await createTempDir();
    const videoPath = getTempFilePath('input_video.mp4');

    try {
      const file = await ctx.getFile();
      const fileUrl = file.getUrl();

      // Download file
      const response = await fetch(fileUrl);
      const buffer = await response.arrayBuffer();
      await writeFile(videoPath, new Uint8Array(buffer));

      logger.info({ videoPath }, 'Video downloaded');

      // Get video info
      const videoInfo = await videoService.getVideoInfo(videoPath);
      const duration = Math.floor(videoInfo.duration);
      const minutes = Math.floor(duration / 60);
      const seconds = duration % 60;

      // Estimate resolutions for optimization options
      const [res10MB, res5MB] = await Promise.all([
        videoService.estimateOptimizedResolution(videoPath, 10).catch(() => videoInfo.height),
        videoService.estimateOptimizedResolution(videoPath, 5).catch(() => videoInfo.height),
      ]);

      // Build transformation options keyboard
      const keyboard = new InlineKeyboard()
        .text(`🎬 Best quality, ${videoInfo.height}p - ${fileSizeMB.toFixed(1)}MB`, `video:best:${videoPath}`)
        .row()
        .text(`📉 ${res10MB}p - 10MB`, `video:optimize:10:${videoPath}`)
        .row()
        .text(`📉 ${res5MB}p - 5MB`, `video:optimize:5:${videoPath}`)
        .row()
        .text('🎵 Audio only', `video:extract_audio:${videoPath}`)
        .row()
        .text('📉 Custom Size...', `video:custom:${videoPath}`);

      const infoMessage = `
📹 Video Info:
⏱️ Duration: ${minutes}m ${seconds}s
📦 Size: ${fileSizeMB.toFixed(2)}MB
📐 Resolution: ${videoInfo.width}x${videoInfo.height}
🎬 Codec: ${videoInfo.codec}

Select transformation:
      `.trim();

      await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, infoMessage, {
        reply_markup: keyboard,
      });
    } catch (error) {
      logger.error({ error, videoPath }, 'Failed to process video');
      await ctx.api.editMessageText(
        statusMsg.chat.id,
        statusMsg.message_id,
        '❌ Failed to process video. Please try again.'
      );
      await cleanupFile(videoPath);
    }
  } catch (error) {
    logger.error({ error }, 'Error in video upload handler');
    await ctx.reply('❌ An error occurred while processing your video.');
  }
}

/**
 * Handle callback queries for video transformations
 */
async function handleCallbackQuery(ctx: Context): Promise<void> {
  try {
    if (!ctx.callbackQuery?.data) return;

    const data = ctx.callbackQuery.data;

    // Only handle video-related callbacks
    if (!data.startsWith('video:')) return;

    await ctx.answerCallbackQuery();

    const parts = data.split(':');
    const action = parts[1];
    const videoPath = parts[parts.length - 1];

    logger.info({ action, videoPath, userId: ctx.from?.id }, 'Processing video transformation');

    if (action === 'best') {
      // Send original video without optimization
      await handleSendBestQuality(ctx, videoPath);
    } else if (action === 'extract_audio') {
      await handleExtractAudio(ctx, videoPath);
    } else if (action === 'optimize') {
      const targetSizeMB = parseInt(parts[2]);
      await handleOptimizeVideo(ctx, videoPath, targetSizeMB);
    } else if (action === 'custom') {
      await handleCustomSizeRequest(ctx, videoPath);
    }
  } catch (error) {
    logger.error({ error }, 'Error in callback query handler');
    await ctx.reply('❌ An error occurred while processing your request.');
  }
}

/**
 * Handle sending best quality (original video)
 */
async function handleSendBestQuality(ctx: Context, videoPath: string): Promise<void> {
  const statusMsg = await ctx.reply('📤 Sending video...');

  try {
    // Send original video
    await ctx.replyWithVideo(new InputFile(videoPath), {
      caption: '✅ Best quality video',
    });

    await ctx.api.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      '✅ Video sent!'
    );

    // Cleanup
    await cleanupFile(videoPath);
  } catch (error: any) {
    logger.error({ error, videoPath }, 'Failed to send video');
    await ctx.api.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      `❌ Failed to send video: ${error.message}`
    );
    await cleanupFile(videoPath);
  }
}

/**
 * Handle audio extraction
 */
async function handleExtractAudio(ctx: Context, videoPath: string): Promise<void> {
  const statusMsg = await ctx.reply('⚙️ Extracting audio...\nProgress: 0%');

  try {
    const audioPath = await videoService.extractAudio(videoPath, 'mp3');

    await ctx.api.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      '✅ Audio extracted! Uploading...'
    );

    // Send audio file
    await ctx.replyWithAudio(new InputFile(audioPath));

    await ctx.api.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      '✅ Audio extraction complete!'
    );

    // Cleanup
    await cleanupFile(videoPath);
    await cleanupFile(audioPath);
  } catch (error: any) {
    logger.error({ error, videoPath }, 'Failed to extract audio');
    await ctx.api.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      `❌ Failed to extract audio: ${error.message}`
    );
    await cleanupFile(videoPath);
  }
}

/**
 * Handle video optimization
 */
async function handleOptimizeVideo(
  ctx: Context,
  videoPath: string,
  targetSizeMB: number
): Promise<void> {
  const statusMsg = await ctx.reply('⚙️ Processing video...\nProgress: 0%\n[░░░░░░░░░░░░░░░░░░░░] 0%');

  try {
    let lastUpdate = 0;

    const outputPath = await videoService.compressWithProgress(
      videoPath,
      targetSizeMB,
      async (percent) => {
        const now = Date.now();
        // Update every 5% or every 2 seconds
        if (percent - lastUpdate >= 5 || now - lastUpdate > 2000) {
          lastUpdate = percent;
          const progressBar = createProgressBar(percent);
          const eta = estimateETA(percent, now);

          await ctx.api
            .editMessageText(
              statusMsg.chat.id,
              statusMsg.message_id,
              `⚙️ Processing video...\nProgress: ${Math.floor(percent)}%\n${progressBar}\nETA: ${eta}`
            )
            .catch(() => {
              // Ignore edit errors (too many requests)
            });
        }
      }
    );

    await ctx.api.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      '✅ Video optimized! Uploading...'
    );

    // Send optimized video
    await ctx.replyWithVideo(new InputFile(outputPath));

    await ctx.api.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      '✅ Video optimization complete!'
    );

    // Cleanup
    await cleanupFile(videoPath);
    await cleanupFile(outputPath);
  } catch (error: any) {
    logger.error({ error, videoPath, targetSizeMB }, 'Failed to optimize video');

    let errorMessage = '❌ Failed to optimize video.';
    if (error.message.includes('already smaller')) {
      errorMessage = `✅ ${error.message}`;
    } else if (error.message.includes('too small')) {
      errorMessage = `⚠️ ${error.message}`;
    } else {
      errorMessage = `❌ Processing failed: ${error.message}`;
    }

    await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, errorMessage);
    await cleanupFile(videoPath);
  }
}

/**
 * Handle custom size request
 */
async function handleCustomSizeRequest(ctx: Context, videoPath: string): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  // Store user state
  userStates.set(userId, { type: 'custom_size', videoPath });

  await ctx.reply(
    '📝 Please enter your desired file size in MB (1-100):\n\nExample: 15',
    { reply_markup: { force_reply: true } }
  );
}

/**
 * Handle custom size input
 */
async function handleCustomSizeInput(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId || !ctx.message?.text) return;

  const userState = userStates.get(userId);
  if (!userState || userState.type !== 'custom_size') return;

  // Clear user state
  userStates.delete(userId);

  const targetSizeMB = parseFloat(ctx.message.text);

  if (isNaN(targetSizeMB) || targetSizeMB < 1 || targetSizeMB > 100) {
    await ctx.reply('⚠️ Invalid size. Please enter a number between 1 and 100 MB.');
    await cleanupFile(userState.videoPath);
    return;
  }

  await handleOptimizeVideo(ctx, userState.videoPath, targetSizeMB);
}

/**
 * Create a progress bar string
 */
function createProgressBar(percent: number): string {
  const total = 20;
  const filled = Math.floor((percent / 100) * total);
  const empty = total - filled;
  return '[' + '█'.repeat(filled) + '░'.repeat(empty) + '] ' + Math.floor(percent) + '%';
}

/**
 * Estimate time remaining
 */
let startTime = Date.now();
function estimateETA(percent: number, currentTime: number): string {
  if (percent < 5) {
    startTime = currentTime;
    return 'Calculating...';
  }

  const elapsed = (currentTime - startTime) / 1000; // seconds
  const rate = percent / elapsed;
  const remaining = (100 - percent) / rate;

  if (remaining < 60) {
    return `~${Math.ceil(remaining)}s`;
  } else {
    const minutes = Math.floor(remaining / 60);
    const seconds = Math.ceil(remaining % 60);
    return `~${minutes}m ${seconds}s`;
  }
}
