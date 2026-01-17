import { Bot, Context, InlineKeyboard, InputFile } from 'grammy';
import { hydrateFiles } from '@grammyjs/files';
import { ImageTransformService } from '../services/ImageTransformService';
import { logger } from '../utils/logger';
import { createTempDir, getTempFilePath, cleanupFile } from '../utils/fileManager';
import { writeFile } from 'fs/promises';
import { getFileCache } from '../utils/fileCache';

const imageService = new ImageTransformService();

// Supported image formats
const SUPPORTED_FORMATS = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_SIZE_MB = 20;

/**
 * Register image transformation handlers
 */
export function registerImageHandlers(bot: Bot): void {
  // Enable file plugin
  bot.api.config.use(hydrateFiles(bot.token));

  // Handle photo uploads (compressed by Telegram)
  bot.on('message:photo', handlePhotoUpload);

  // Handle document uploads (images sent as files)
  bot.on('message:document', handleDocumentUpload);

  // Handle callback queries for transformations
  bot.on('callback_query:data', async (ctx, next) => {
    const data = ctx.callbackQuery?.data;
    if (data?.startsWith('image:')) {
      await handleCallbackQuery(ctx);
    } else {
      await next();
    }
  });

  logger.info('Image handlers registered');
}

/**
 * Handle photo uploads (compressed)
 */
async function handlePhotoUpload(ctx: Context): Promise<void> {
  try {
    if (!ctx.message?.photo) return;

    // Get the largest photo size
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const fileSize = photo.file_size || 0;
    const fileSizeMB = fileSize / (1024 * 1024);

    logger.info({ fileSize, fileSizeMB, userId: ctx.from?.id }, 'Received photo upload');

    if (fileSizeMB > MAX_IMAGE_SIZE_MB) {
      await ctx.reply(`⚠️ Image is too large. Maximum supported size is ${MAX_IMAGE_SIZE_MB}MB.`);
      return;
    }

    await processImageUpload(ctx, photo.file_id);
  } catch (error) {
    logger.error({ error }, 'Error in photo upload handler');
    await ctx.reply('❌ An error occurred while processing your image.');
  }
}

/**
 * Handle document uploads (check if it's an image)
 */
async function handleDocumentUpload(ctx: Context): Promise<void> {
  try {
    if (!ctx.message?.document) return;

    const document = ctx.message.document;
    const mimeType = document.mime_type || '';

    // Only process if it's an image
    if (!SUPPORTED_FORMATS.includes(mimeType)) {
      return; // Silently ignore non-image documents
    }

    const fileSize = document.file_size || 0;
    const fileSizeMB = fileSize / (1024 * 1024);

    logger.info({ fileSize, fileSizeMB, mimeType, userId: ctx.from?.id }, 'Received image document upload');

    if (fileSizeMB > MAX_IMAGE_SIZE_MB) {
      await ctx.reply(`⚠️ Image is too large. Maximum supported size is ${MAX_IMAGE_SIZE_MB}MB.`);
      return;
    }

    await processImageUpload(ctx, document.file_id);
  } catch (error) {
    logger.error({ error }, 'Error in document upload handler');
    await ctx.reply('❌ An error occurred while processing your image.');
  }
}

/**
 * Process image upload and show transformation options
 */
async function processImageUpload(ctx: Context, fileId: string): Promise<void> {
  const statusMsg = await ctx.reply('📥 Downloading image...');

  await createTempDir();
  const imagePath = getTempFilePath('input_image.jpg');

  try {
    const file = await ctx.api.getFile(fileId);
    const fileUrl = file.getUrl();

    // Download file
    const response = await fetch(fileUrl);
    const buffer = await response.arrayBuffer();
    await writeFile(imagePath, new Uint8Array(buffer));

    logger.info({ imagePath }, 'Image downloaded');

    // Get image info
    const imageInfo = await imageService.getImageInfo(imagePath);
    const fileSizeMB = imageInfo.fileSize / (1024 * 1024);

    // Store file path in cache and get short ID
    const userId = ctx.from?.id || 0;
    const fileCache = getFileCache();
    const cacheId = fileCache.set(imagePath, userId);

    // Estimate optimization sizes
    const [highSize, mediumSize, lowSize] = await Promise.all([
      imageService.estimateOptimizedSize(imagePath, 'high'),
      imageService.estimateOptimizedSize(imagePath, 'medium'),
      imageService.estimateOptimizedSize(imagePath, 'low'),
    ]);

    const highSizeMB = (highSize / (1024 * 1024)).toFixed(1);
    const mediumSizeMB = (mediumSize / (1024 * 1024)).toFixed(1);
    const lowSizeMB = (lowSize / (1024 * 1024)).toFixed(1);

    // Build transformation options keyboard with short IDs
    const keyboard = new InlineKeyboard()
      .text('🖼️ Remove Background', `image:remove_bg:${cacheId}`)
      .row()
      .text(`📉 Optimize (~${highSizeMB}MB)`, `image:optimize:high:${cacheId}`)
      .row()
      .text(`📉 Optimize (~${mediumSizeMB}MB)`, `image:optimize:medium:${cacheId}`)
      .row()
      .text(`📉 Optimize (~${lowSizeMB}MB)`, `image:optimize:low:${cacheId}`)
      .row()
      .text('🔄 Convert to WebP', `image:convert:webp:${cacheId}`);

    const infoMessage = `
🖼️ Image Info:
📐 Resolution: ${imageInfo.width}x${imageInfo.height}
📦 Size: ${fileSizeMB.toFixed(2)}MB
🎨 Format: ${imageInfo.format.toUpperCase()}
${imageInfo.hasAlpha ? '✨ Has transparency' : ''}

Select transformation:
    `.trim();

    await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, infoMessage, {
      reply_markup: keyboard,
    });
  } catch (error) {
    logger.error({ error, imagePath }, 'Failed to process image');
    await ctx.api.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      '❌ Failed to process image. Please try again.'
    );
    await cleanupFile(imagePath);
  }
}

/**
 * Handle callback queries for image transformations
 */
async function handleCallbackQuery(ctx: Context): Promise<void> {
  try {
    if (!ctx.callbackQuery?.data) return;

    const data = ctx.callbackQuery.data;

    // Only handle image-related callbacks
    if (!data.startsWith('image:')) return;

    await ctx.answerCallbackQuery();

    const parts = data.split(':');
    const action = parts[1];
    const cacheId = parts[parts.length - 1];

    // Retrieve file path from cache
    const userId = ctx.from?.id || 0;
    const fileCache = getFileCache();
    const imagePath = fileCache.get(cacheId, userId);

    if (!imagePath) {
      await ctx.reply('❌ File not found or expired. Please upload the image again.');
      logger.warn({ cacheId, userId }, 'File not found in cache');
      return;
    }

    logger.info({ action, imagePath, userId: ctx.from?.id }, 'Processing image transformation');

    if (action === 'remove_bg') {
      await handleRemoveBackground(ctx, imagePath);
    } else if (action === 'optimize') {
      const quality = parts[2] as 'high' | 'medium' | 'low';
      await handleOptimizeImage(ctx, imagePath, quality);
    } else if (action === 'convert') {
      const format = parts[2] as 'webp';
      await handleConvertFormat(ctx, imagePath, format);
    }
  } catch (error) {
    logger.error({ error }, 'Error in callback query handler');
    await ctx.reply('❌ An error occurred while processing your request.');
  }
}

/**
 * Handle background removal
 */
async function handleRemoveBackground(ctx: Context, imagePath: string): Promise<void> {
  const statusMsg = await ctx.reply('⚙️ Removing background...\n🤖 Loading AI model (first time may take 5-15s)...');

  try {
    const outputPath = await imageService.removeBackground(imagePath);

    await ctx.api.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      '✅ Background removed! Uploading...'
    );

    // Get file sizes for comparison
    const originalInfo = await imageService.getImageInfo(imagePath);
    const outputInfo = await imageService.getImageInfo(outputPath);
    const originalSizeMB = originalInfo.fileSize / (1024 * 1024);
    const outputSizeMB = outputInfo.fileSize / (1024 * 1024);

    // Always send as document to preserve quality
    await ctx.replyWithDocument(new InputFile(outputPath), {
      caption: `✅ Background removed!\n📦 Original: ${originalSizeMB.toFixed(2)}MB → Result: ${outputSizeMB.toFixed(2)}MB`,
    });

    await ctx.api.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      '✅ Background removal complete!'
    );

    // Cleanup files
    await cleanupFile(imagePath);
    await cleanupFile(outputPath);
  } catch (error: any) {
    logger.error({ error, imagePath }, 'Failed to remove background');

    let errorMessage = '❌ Background removal failed.';
    if (error.message.includes('subject')) {
      errorMessage = '❌ Could not detect subject in image. Try a different photo with a clear subject.';
    } else if (error.message.includes('model')) {
      errorMessage = '❌ AI model failed to load. Please try again later.';
    }

    await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, errorMessage);
    await cleanupFile(imagePath);
  }
}

/**
 * Handle image optimization
 */
async function handleOptimizeImage(
  ctx: Context,
  imagePath: string,
  quality: 'high' | 'medium' | 'low'
): Promise<void> {
  const qualityLabels = {
    high: 'High Quality (90%)',
    medium: 'Medium Quality (75%)',
    low: 'Small Size (55%)',
  };

  const statusMsg = await ctx.reply(`⚙️ Optimizing image to ${qualityLabels[quality]}...`);

  try {
    const originalInfo = await imageService.getImageInfo(imagePath);
    const originalSizeMB = originalInfo.fileSize / (1024 * 1024);

    const outputPath = await imageService.optimizeImage(imagePath, quality);
    const outputInfo = await imageService.getImageInfo(outputPath);
    const outputSizeMB = outputInfo.fileSize / (1024 * 1024);

    const reduction = ((1 - outputSizeMB / originalSizeMB) * 100).toFixed(0);

    await ctx.api.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      '✅ Image optimized! Uploading...'
    );

    const caption = `✅ Optimized! ${originalSizeMB.toFixed(2)}MB → ${outputSizeMB.toFixed(2)}MB (${reduction}% smaller)`;

    // Always send as document to preserve quality
    await ctx.replyWithDocument(new InputFile(outputPath), { caption });

    await ctx.api.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      '✅ Image optimization complete!'
    );

    // Cleanup
    await cleanupFile(imagePath);
    await cleanupFile(outputPath);
  } catch (error: any) {
    logger.error({ error, imagePath, quality }, 'Failed to optimize image');
    await ctx.api.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      `❌ Image optimization failed: ${error.message}`
    );
    await cleanupFile(imagePath);
  }
}

/**
 * Handle format conversion
 */
async function handleConvertFormat(
  ctx: Context,
  imagePath: string,
  targetFormat: 'webp' | 'jpeg' | 'png'
): Promise<void> {
  const statusMsg = await ctx.reply(`⚙️ Converting to ${targetFormat.toUpperCase()}...`);

  try {
    const originalInfo = await imageService.getImageInfo(imagePath);
    const originalSizeMB = originalInfo.fileSize / (1024 * 1024);

    const outputPath = await imageService.convertFormat(imagePath, targetFormat);
    const outputInfo = await imageService.getImageInfo(outputPath);
    const outputSizeMB = outputInfo.fileSize / (1024 * 1024);

    const reduction = ((1 - outputSizeMB / originalSizeMB) * 100).toFixed(0);
    const changeText = outputSizeMB < originalSizeMB
      ? `${reduction}% smaller`
      : `${Math.abs(parseFloat(reduction))}% larger`;

    await ctx.api.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      '✅ Format converted! Uploading...'
    );

    const caption = `✅ Converted to ${targetFormat.toUpperCase()}! ${originalSizeMB.toFixed(2)}MB → ${outputSizeMB.toFixed(2)}MB (${changeText})`;

    // Always send as document to preserve quality
    await ctx.replyWithDocument(new InputFile(outputPath), { caption });

    await ctx.api.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      '✅ Format conversion complete!'
    );

    // Cleanup
    await cleanupFile(imagePath);
    await cleanupFile(outputPath);
  } catch (error: any) {
    logger.error({ error, imagePath, targetFormat }, 'Failed to convert format');
    await ctx.api.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      `❌ Format conversion failed: ${error.message}`
    );
    await cleanupFile(imagePath);
  }
}
