/**
 * Analytics tracking for KreftBot operations
 */

import { logger } from './logger';
import { Platform } from '../types';

export interface DownloadStats {
  platform: string;
  format: string;
  success: boolean;
  duration: number;
  timestamp: number;
}

export interface TransformStats {
  type: 'extract_audio' | 'compress_video' | 'remove_background' | 'optimize_image';
  inputSize: number;
  outputSize: number;
  duration: number;
  success: boolean;
  timestamp: number;
}

export interface ErrorStats {
  type: string;
  context: any;
  timestamp: number;
}

export interface DailyStats {
  date: string;
  downloads: {
    total: number;
    successful: number;
    failed: number;
    byPlatform: Record<string, number>;
  };
  transformations: {
    total: number;
    successful: number;
    failed: number;
    byType: Record<string, number>;
    totalSizeSaved: number; // bytes
  };
  errors: {
    total: number;
    byType: Record<string, number>;
  };
  activeUsers: Set<number>;
  avgProcessingTime: number;
}

/**
 * Analytics tracker for bot operations
 */
export class Analytics {
  private downloads: DownloadStats[] = [];
  private transformations: TransformStats[] = [];
  private errors: ErrorStats[] = [];
  private activeUsers = new Set<number>();

  // Keep only last 7 days of data in memory
  private readonly RETENTION_DAYS = 7;
  private readonly RETENTION_MS = this.RETENTION_DAYS * 24 * 60 * 60 * 1000;

  /**
   * Track a download operation
   */
  trackDownload(platform: string, format: string, success: boolean, duration: number): void {
    const stat: DownloadStats = {
      platform,
      format,
      success,
      duration,
      timestamp: Date.now(),
    };

    this.downloads.push(stat);
    this.cleanup();

    logger.debug({ stat }, 'Download tracked');
  }

  /**
   * Track a transformation operation
   */
  trackTransformation(
    type: TransformStats['type'],
    inputSize: number,
    outputSize: number,
    duration: number,
    success: boolean
  ): void {
    const stat: TransformStats = {
      type,
      inputSize,
      outputSize,
      duration,
      success,
      timestamp: Date.now(),
    };

    this.transformations.push(stat);
    this.cleanup();

    logger.debug({ stat }, 'Transformation tracked');
  }

  /**
   * Track an error
   */
  trackError(errorType: string, context: any): void {
    const stat: ErrorStats = {
      type: errorType,
      context,
      timestamp: Date.now(),
    };

    this.errors.push(stat);
    this.cleanup();

    logger.debug({ stat }, 'Error tracked');
  }

  /**
   * Track active user
   */
  trackUser(userId: number): void {
    this.activeUsers.add(userId);
  }

  /**
   * Get daily statistics
   */
  getDailyStats(date?: Date): DailyStats {
    const targetDate = date || new Date();
    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);

    const startTime = startOfDay.getTime();
    const endTime = endOfDay.getTime();

    // Filter data for the target day
    const dayDownloads = this.downloads.filter(
      d => d.timestamp >= startTime && d.timestamp <= endTime
    );
    const dayTransformations = this.transformations.filter(
      t => t.timestamp >= startTime && t.timestamp <= endTime
    );
    const dayErrors = this.errors.filter(
      e => e.timestamp >= startTime && e.timestamp <= endTime
    );

    // Calculate download stats
    const downloadsByPlatform: Record<string, number> = {};
    let successfulDownloads = 0;
    let totalDownloadTime = 0;

    for (const download of dayDownloads) {
      downloadsByPlatform[download.platform] = (downloadsByPlatform[download.platform] || 0) + 1;
      if (download.success) successfulDownloads++;
      totalDownloadTime += download.duration;
    }

    // Calculate transformation stats
    const transformationsByType: Record<string, number> = {};
    let successfulTransformations = 0;
    let totalSizeSaved = 0;
    let totalTransformTime = 0;

    for (const transform of dayTransformations) {
      transformationsByType[transform.type] = (transformationsByType[transform.type] || 0) + 1;
      if (transform.success) {
        successfulTransformations++;
        totalSizeSaved += transform.inputSize - transform.outputSize;
      }
      totalTransformTime += transform.duration;
    }

    // Calculate error stats
    const errorsByType: Record<string, number> = {};
    for (const error of dayErrors) {
      errorsByType[error.type] = (errorsByType[error.type] || 0) + 1;
    }

    // Calculate average processing time
    const totalOps = dayDownloads.length + dayTransformations.length;
    const avgProcessingTime =
      totalOps > 0 ? (totalDownloadTime + totalTransformTime) / totalOps : 0;

    return {
      date: targetDate.toISOString().split('T')[0],
      downloads: {
        total: dayDownloads.length,
        successful: successfulDownloads,
        failed: dayDownloads.length - successfulDownloads,
        byPlatform: downloadsByPlatform,
      },
      transformations: {
        total: dayTransformations.length,
        successful: successfulTransformations,
        failed: dayTransformations.length - successfulTransformations,
        byType: transformationsByType,
        totalSizeSaved,
      },
      errors: {
        total: dayErrors.length,
        byType: errorsByType,
      },
      activeUsers: new Set(this.activeUsers),
      avgProcessingTime,
    };
  }

  /**
   * Get summary statistics
   */
  getSummary(): {
    totalDownloads: number;
    totalTransformations: number;
    totalErrors: number;
    activeUsers: number;
    topPlatforms: Array<{ platform: string; count: number }>;
    topTransformations: Array<{ type: string; count: number }>;
  } {
    const platformCounts: Record<string, number> = {};
    for (const download of this.downloads) {
      platformCounts[download.platform] = (platformCounts[download.platform] || 0) + 1;
    }

    const transformCounts: Record<string, number> = {};
    for (const transform of this.transformations) {
      transformCounts[transform.type] = (transformCounts[transform.type] || 0) + 1;
    }

    const topPlatforms = Object.entries(platformCounts)
      .map(([platform, count]) => ({ platform, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const topTransformations = Object.entries(transformCounts)
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return {
      totalDownloads: this.downloads.length,
      totalTransformations: this.transformations.length,
      totalErrors: this.errors.length,
      activeUsers: this.activeUsers.size,
      topPlatforms,
      topTransformations,
    };
  }

  /**
   * Log daily stats summary
   */
  logDailySummary(): void {
    const stats = this.getDailyStats();
    logger.info({ stats }, 'Daily statistics summary');
  }

  /**
   * Cleanup old data beyond retention period
   */
  private cleanup(): void {
    const cutoffTime = Date.now() - this.RETENTION_MS;

    const beforeDownloads = this.downloads.length;
    const beforeTransformations = this.transformations.length;
    const beforeErrors = this.errors.length;

    this.downloads = this.downloads.filter(d => d.timestamp >= cutoffTime);
    this.transformations = this.transformations.filter(t => t.timestamp >= cutoffTime);
    this.errors = this.errors.filter(e => e.timestamp >= cutoffTime);

    const cleanedDownloads = beforeDownloads - this.downloads.length;
    const cleanedTransformations = beforeTransformations - this.transformations.length;
    const cleanedErrors = beforeErrors - this.errors.length;

    if (cleanedDownloads + cleanedTransformations + cleanedErrors > 0) {
      logger.debug(
        {
          downloads: cleanedDownloads,
          transformations: cleanedTransformations,
          errors: cleanedErrors,
        },
        'Analytics data cleaned up'
      );
    }
  }

  /**
   * Reset all statistics (useful for testing)
   */
  reset(): void {
    this.downloads = [];
    this.transformations = [];
    this.errors = [];
    this.activeUsers.clear();
    logger.info('Analytics data reset');
  }

  /**
   * Export statistics as JSON
   */
  export(): {
    downloads: DownloadStats[];
    transformations: TransformStats[];
    errors: ErrorStats[];
    summary: ReturnType<typeof this.getSummary>;
  } {
    return {
      downloads: [...this.downloads],
      transformations: [...this.transformations],
      errors: [...this.errors],
      summary: this.getSummary(),
    };
  }
}

// Global singleton instance
let analytics: Analytics | null = null;

/**
 * Get or create the global analytics instance
 */
export function getAnalytics(): Analytics {
  if (!analytics) {
    analytics = new Analytics();
  }
  return analytics;
}
