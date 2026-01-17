import sharp from 'sharp';
import { removeBackground } from '@imgly/background-removal-node';
import { stat, readFile } from 'fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { ImageInfo } from '../types';
import { logger } from '../utils/logger';
import { getTempFilePath, cleanupFile, createTempDir } from '../utils/fileManager';

export class ImageTransformService {
  /**
   * Remove background from an image using AI
   */
  async removeBackground(imagePath: string): Promise<string> {
    try {
      await createTempDir();
      const outputPath = getTempFilePath('nobg.png');

      logger.info({ imagePath, outputPath }, 'Removing background from image');

      // Read image file into a Buffer
      const imageBuffer = await readFile(imagePath);
      
      // Determine file extension and MIME type
      const ext = imagePath.split('.').pop()?.toLowerCase() || 'jpg';
      const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
      
      // Create Blob from Buffer (required by @imgly/background-removal-node)
      const inputBlob = new Blob([imageBuffer], { type: mimeType });

      // Configure publicPath for model files
      const distDir = join(process.cwd(), 'node_modules', '@imgly', 'background-removal-node', 'dist');
      const publicPath = pathToFileURL(distDir).toString() + '/';

      const config = {
        publicPath,
        output: {
          format: 'image/png', // PNG for transparency
        },
      };

      // Remove background
      const resultBlob = await removeBackground(inputBlob, config);

      // Convert Blob to Buffer
      const arrayBuffer = await resultBlob.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // Save as PNG to preserve transparency
      await sharp(buffer)
        .png({ compressionLevel: 9 })
        .toFile(outputPath);

      logger.info({ outputPath }, 'Background removed successfully');
      return outputPath;
    } catch (error) {
      logger.error({ error, imagePath }, 'Failed to remove background');
      throw new Error('Failed to remove background from image');
    }
  }

  /**
   * Estimate the file size after optimization without saving the file
   */
  async estimateOptimizedSize(
    imagePath: string,
    quality: 'high' | 'medium' | 'low'
  ): Promise<number> {
    try {
      await createTempDir();
      const imageInfo = await this.getImageInfo(imagePath);
      const tempPath = getTempFilePath(`estimate_${quality}.${imageInfo.format}`);

      logger.info({ imagePath, quality, format: imageInfo.format }, 'Estimating optimized size');

      let sharpInstance = sharp(imagePath);

      // Apply quality presets based on format
      switch (quality) {
        case 'high':
          if (imageInfo.format === 'jpeg' || imageInfo.format === 'jpg') {
            sharpInstance = sharpInstance.jpeg({ quality: 90, progressive: true });
          } else if (imageInfo.format === 'png') {
            sharpInstance = sharpInstance.png({ compressionLevel: 6, quality: 90 });
          } else if (imageInfo.format === 'webp') {
            sharpInstance = sharpInstance.webp({ quality: 90, effort: 6 });
          }
          break;

        case 'medium':
          if (imageInfo.format === 'jpeg' || imageInfo.format === 'jpg') {
            sharpInstance = sharpInstance.jpeg({ quality: 75, progressive: true });
          } else if (imageInfo.format === 'png') {
            sharpInstance = sharpInstance.png({ compressionLevel: 8, quality: 75 });
          } else if (imageInfo.format === 'webp') {
            sharpInstance = sharpInstance.webp({ quality: 75, effort: 6 });
          }
          break;

        case 'low':
          if (imageInfo.format === 'jpeg' || imageInfo.format === 'jpg') {
            sharpInstance = sharpInstance.jpeg({ quality: 55, progressive: true });
          } else if (imageInfo.format === 'png') {
            sharpInstance = sharpInstance.png({ compressionLevel: 9, quality: 55 });
          } else if (imageInfo.format === 'webp') {
            sharpInstance = sharpInstance.webp({ quality: 55, effort: 6 });
          }
          break;
      }

      await sharpInstance.toFile(tempPath);
      
      // Get file size
      const fileStat = await stat(tempPath);
      const fileSize = fileStat.size;

      // Cleanup temp file
      await cleanupFile(tempPath);

      logger.info({ fileSize, quality }, 'Estimated optimized size');
      return fileSize;
    } catch (error) {
      logger.error({ error, imagePath, quality }, 'Failed to estimate optimized size');
      throw new Error('Failed to estimate optimized size');
    }
  }

  /**
   * Optimize image with quality presets
   */
  async optimizeImage(
    imagePath: string,
    quality: 'high' | 'medium' | 'low'
  ): Promise<string> {
    try {
      await createTempDir();
      const imageInfo = await this.getImageInfo(imagePath);
      const outputPath = getTempFilePath(`optimized.${imageInfo.format}`);

      logger.info({ imagePath, quality, format: imageInfo.format }, 'Optimizing image');

      let sharpInstance = sharp(imagePath);

      // Apply quality presets based on format
      switch (quality) {
        case 'high':
          if (imageInfo.format === 'jpeg' || imageInfo.format === 'jpg') {
            sharpInstance = sharpInstance.jpeg({ quality: 90, progressive: true });
          } else if (imageInfo.format === 'png') {
            sharpInstance = sharpInstance.png({ compressionLevel: 6, quality: 90 });
          } else if (imageInfo.format === 'webp') {
            sharpInstance = sharpInstance.webp({ quality: 90, effort: 6 });
          }
          break;

        case 'medium':
          if (imageInfo.format === 'jpeg' || imageInfo.format === 'jpg') {
            sharpInstance = sharpInstance.jpeg({ quality: 75, progressive: true });
          } else if (imageInfo.format === 'png') {
            sharpInstance = sharpInstance.png({ compressionLevel: 8, quality: 75 });
          } else if (imageInfo.format === 'webp') {
            sharpInstance = sharpInstance.webp({ quality: 75, effort: 6 });
          }
          break;

        case 'low':
          if (imageInfo.format === 'jpeg' || imageInfo.format === 'jpg') {
            sharpInstance = sharpInstance.jpeg({ quality: 55, progressive: true });
          } else if (imageInfo.format === 'png') {
            sharpInstance = sharpInstance.png({ compressionLevel: 9, quality: 55 });
          } else if (imageInfo.format === 'webp') {
            sharpInstance = sharpInstance.webp({ quality: 55, effort: 6 });
          }
          break;
      }

      await sharpInstance.toFile(outputPath);

      logger.info({ outputPath }, 'Image optimized successfully');
      return outputPath;
    } catch (error) {
      logger.error({ error, imagePath, quality }, 'Failed to optimize image');
      throw new Error('Failed to optimize image');
    }
  }

  /**
   * Get image metadata
   */
  async getImageInfo(imagePath: string): Promise<ImageInfo> {
    try {
      const metadata = await sharp(imagePath).metadata();
      const fileStat = await stat(imagePath);

      return {
        width: metadata.width || 0,
        height: metadata.height || 0,
        format: metadata.format || 'unknown',
        fileSize: fileStat.size,
        hasAlpha: metadata.hasAlpha || false,
        colorSpace: metadata.space || 'unknown',
      };
    } catch (error) {
      logger.error({ error, imagePath }, 'Failed to get image info');
      throw new Error('Failed to get image information');
    }
  }

  /**
   * Convert image to target format
   */
  async convertFormat(
    imagePath: string,
    targetFormat: 'jpeg' | 'png' | 'webp'
  ): Promise<string> {
    try {
      await createTempDir();
      const outputPath = getTempFilePath(`converted.${targetFormat}`);

      logger.info({ imagePath, targetFormat, outputPath }, 'Converting image format');

      let sharpInstance = sharp(imagePath);

      switch (targetFormat) {
        case 'jpeg':
          sharpInstance = sharpInstance.jpeg({ quality: 85, progressive: true });
          break;
        case 'png':
          sharpInstance = sharpInstance.png({ compressionLevel: 9, quality: 80 });
          break;
        case 'webp':
          sharpInstance = sharpInstance.webp({ quality: 80, effort: 6 });
          break;
      }

      await sharpInstance.toFile(outputPath);

      logger.info({ outputPath }, 'Image format converted successfully');
      return outputPath;
    } catch (error) {
      logger.error({ error, imagePath, targetFormat }, 'Failed to convert image format');
      throw new Error('Failed to convert image format');
    }
  }
}
