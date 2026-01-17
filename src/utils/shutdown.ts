/**
 * Graceful shutdown handling for KreftBot
 */

import { Bot } from 'grammy';
import { logger } from './logger';
import { RequestQueue } from './rateLimiter';
import { ResourceMonitor } from './resourceMonitor';
import { readdir, rm } from 'fs/promises';
import { join } from 'path';
import { config } from '../config';

interface ShutdownHandlers {
  bot?: Bot;
  requestQueue?: RequestQueue;
  resourceMonitor?: ResourceMonitor;
  additionalCleanup?: () => Promise<void>;
}

let isShuttingDown = false;
let shutdownHandlers: ShutdownHandlers = {};

/**
 * Register handlers for graceful shutdown
 */
export function registerShutdownHandlers(handlers: ShutdownHandlers): void {
  shutdownHandlers = handlers;
  logger.info('Shutdown handlers registered');
}

/**
 * Cleanup all temporary files
 */
async function cleanupAllTempFiles(): Promise<void> {
  try {
    logger.info({ tempDir: config.tempDir }, 'Cleaning up all temporary files');

    const files = await readdir(config.tempDir);
    let cleanedCount = 0;

    for (const file of files) {
      try {
        const filePath = join(config.tempDir, file);
        await rm(filePath, { force: true });
        cleanedCount++;
      } catch (error) {
        logger.warn({ error, file }, 'Failed to cleanup temp file during shutdown');
      }
    }

    logger.info({ cleanedCount }, 'Temporary files cleaned up');
  } catch (error) {
    logger.error({ error }, 'Failed to cleanup temp files');
  }
}

/**
 * Perform graceful shutdown
 */
async function gracefulShutdown(signal: string): Promise<void> {
  // Prevent multiple shutdown attempts
  if (isShuttingDown) {
    logger.warn({ signal }, 'Shutdown already in progress, ignoring signal');
    return;
  }

  isShuttingDown = true;
  logger.info({ signal }, 'Starting graceful shutdown');

  const startTime = Date.now();

  try {
    // Step 1: Stop accepting new requests
    if (shutdownHandlers.bot) {
      logger.info('Stopping bot from accepting new requests');
      await shutdownHandlers.bot.stop();
    }

    // Step 2: Stop resource monitor
    if (shutdownHandlers.resourceMonitor) {
      logger.info('Stopping resource monitor');
      shutdownHandlers.resourceMonitor.stop();
    }

    // Step 3: Clear request queue
    if (shutdownHandlers.requestQueue) {
      logger.info('Clearing request queue');
      shutdownHandlers.requestQueue.clearQueue();

      // Wait for active operations to complete (max 30s)
      logger.info('Waiting for active operations to complete (max 30s)');
      const completed = await shutdownHandlers.requestQueue.waitForCompletion(30000);

      if (!completed) {
        logger.warn('Some operations did not complete within timeout');
      }
    }

    // Step 4: Run additional cleanup if provided
    if (shutdownHandlers.additionalCleanup) {
      logger.info('Running additional cleanup');
      await shutdownHandlers.additionalCleanup();
    }

    // Step 5: Cleanup all temp files
    await cleanupAllTempFiles();

    const duration = Date.now() - startTime;
    logger.info({ duration, signal }, 'Graceful shutdown completed');

    // Exit with success
    process.exit(0);
  } catch (error) {
    logger.error({ error, signal }, 'Error during graceful shutdown');

    // Exit with error code
    process.exit(1);
  }
}

/**
 * Setup signal handlers for graceful shutdown
 */
export function setupGracefulShutdown(): void {
  // Handle SIGTERM (kill command, docker stop, etc.)
  process.once('SIGTERM', () => {
    gracefulShutdown('SIGTERM').catch(error => {
      logger.error({ error }, 'Fatal error during SIGTERM shutdown');
      process.exit(1);
    });
  });

  // Handle SIGINT (Ctrl+C)
  process.once('SIGINT', () => {
    gracefulShutdown('SIGINT').catch(error => {
      logger.error({ error }, 'Fatal error during SIGINT shutdown');
      process.exit(1);
    });
  });

  // Handle uncaught exceptions
  process.on('uncaughtException', (error) => {
    logger.error({ error }, 'Uncaught exception');
    gracefulShutdown('UNCAUGHT_EXCEPTION').catch(shutdownError => {
      logger.error({ shutdownError }, 'Fatal error during exception shutdown');
      process.exit(1);
    });
  });

  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason, promise) => {
    logger.error({ reason, promise }, 'Unhandled promise rejection');
    // Don't shut down on unhandled rejection, just log it
    // In production, you might want to shut down depending on the error
  });

  logger.info('Graceful shutdown handlers registered');
}

/**
 * Check if shutdown is in progress
 */
export function isShutdownInProgress(): boolean {
  return isShuttingDown;
}
