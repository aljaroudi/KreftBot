import { mkdir, rm, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { config } from '../config';
import { logger } from './logger';
import { sanitizeFilename } from './validation';

/**
 * Creates the temporary directory if it doesn't exist
 */
export async function createTempDir(): Promise<string> {
  try {
    await mkdir(config.tempDir, { recursive: true });
    logger.info({ path: config.tempDir }, 'Temp directory created/verified');
    return config.tempDir;
  } catch (error) {
    logger.error({ error, path: config.tempDir }, 'Failed to create temp directory');
    throw new Error(`Failed to create temp directory: ${error}`);
  }
}

/**
 * Generates a unique temporary file path with sanitized filename
 */
export function getTempFilePath(filename: string): string {
  const sanitized = sanitizeFilename(filename);
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  const uniqueFilename = `${timestamp}-${random}-${sanitized}`;
  return join(config.tempDir, uniqueFilename);
}

/**
 * Deletes a file from the filesystem
 */
export async function cleanupFile(filePath: string): Promise<void> {
  try {
    await rm(filePath, { force: true });
    logger.info({ filePath }, 'File cleaned up');
  } catch (error) {
    logger.warn({ error, filePath }, 'Failed to cleanup file');
  }
}

/**
 * Deletes files older than specified age in minutes
 */
export async function cleanupOldFiles(maxAgeMinutes: number): Promise<void> {
  try {
    const files = await readdir(config.tempDir);
    const now = Date.now();
    const maxAgeMs = maxAgeMinutes * 60 * 1000;

    let cleanedCount = 0;

    for (const file of files) {
      const filePath = join(config.tempDir, file);
      try {
        const stats = await stat(filePath);
        const age = now - stats.mtimeMs;

        if (age > maxAgeMs) {
          await rm(filePath, { force: true });
          cleanedCount++;
        }
      } catch (error) {
        logger.warn({ error, file }, 'Failed to check/cleanup old file');
      }
    }

    if (cleanedCount > 0) {
      logger.info({ cleanedCount, maxAgeMinutes }, 'Cleaned up old files');
    }
  } catch (error) {
    logger.error({ error }, 'Failed to cleanup old files');
  }
}
