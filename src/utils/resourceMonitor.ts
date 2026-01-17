/**
 * Resource monitoring for disk space and memory
 */

import { stat } from 'fs/promises';
import { spawn } from 'bun';
import { logger } from './logger';
import { cleanupOldFiles } from './fileManager';
import { config } from '../config';

export interface DiskInfo {
  available: number; // bytes
  total: number; // bytes
  used: number; // bytes
  percentUsed: number;
}

export interface MemoryInfo {
  heapUsed: number; // bytes
  heapTotal: number; // bytes
  rss: number; // bytes (resident set size)
  external: number; // bytes
  percentUsed: number;
}

export interface SystemStatus {
  disk: DiskInfo;
  memory: MemoryInfo;
  healthy: boolean;
  warnings: string[];
}

/**
 * Resource monitor for disk space and memory
 */
export class ResourceMonitor {
  private cleanupIntervalId?: NodeJS.Timeout;
  private monitorIntervalId?: NodeJS.Timeout;
  private readonly DISK_WARNING_THRESHOLD = 1 * 1024 * 1024 * 1024; // 1GB in bytes
  private readonly MEMORY_WARNING_THRESHOLD = 0.8; // 80%
  private readonly CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour
  private readonly MONITOR_INTERVAL = 5 * 60 * 1000; // 5 minutes
  private readonly MAX_FILE_AGE_HOURS = 1;

  /**
   * Start automated monitoring and cleanup
   */
  start(): void {
    logger.info('Starting resource monitor');

    // Initial system check
    this.checkSystem().catch(error => {
      logger.error({ error }, 'Initial system check failed');
    });

    // Schedule periodic cleanup
    this.cleanupIntervalId = setInterval(() => {
      this.performCleanup().catch(error => {
        logger.error({ error }, 'Scheduled cleanup failed');
      });
    }, this.CLEANUP_INTERVAL);

    // Schedule periodic monitoring
    this.monitorIntervalId = setInterval(() => {
      this.checkSystem().catch(error => {
        logger.error({ error }, 'Periodic system check failed');
      });
    }, this.MONITOR_INTERVAL);
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
    }
    if (this.monitorIntervalId) {
      clearInterval(this.monitorIntervalId);
    }
    logger.info('Resource monitor stopped');
  }

  /**
   * Check disk space available
   */
  async checkDiskSpace(): Promise<DiskInfo> {
    try {
      // Use df command to check disk space for temp directory
      const proc = spawn(['df', '-k', config.tempDir], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        throw new Error('df command failed');
      }

      // Parse df output (second line contains the data)
      const lines = stdout.trim().split('\n');
      if (lines.length < 2) {
        throw new Error('Invalid df output');
      }

      const parts = lines[1].split(/\s+/);
      const total = parseInt(parts[1]) * 1024; // Convert from KB to bytes
      const used = parseInt(parts[2]) * 1024;
      const available = parseInt(parts[3]) * 1024;

      const diskInfo: DiskInfo = {
        total,
        used,
        available,
        percentUsed: (used / total) * 100,
      };

      // Log warning if disk space is low
      if (available < this.DISK_WARNING_THRESHOLD) {
        logger.warn(
          {
            available: Math.round(available / (1024 * 1024 * 1024) * 10) / 10,
            threshold: Math.round(this.DISK_WARNING_THRESHOLD / (1024 * 1024 * 1024) * 10) / 10,
          },
          'Low disk space warning'
        );
      }

      return diskInfo;
    } catch (error) {
      logger.error({ error }, 'Failed to check disk space');
      throw error;
    }
  }

  /**
   * Get current memory usage
   */
  getMemoryUsage(): MemoryInfo {
    const mem = process.memoryUsage();
    const percentUsed = mem.heapUsed / mem.heapTotal;

    const memoryInfo: MemoryInfo = {
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      rss: mem.rss,
      external: mem.external,
      percentUsed: percentUsed * 100,
    };

    // Log warning if memory usage is high
    if (percentUsed > this.MEMORY_WARNING_THRESHOLD) {
      logger.warn(
        {
          heapUsed: Math.round(mem.heapUsed / (1024 * 1024)),
          heapTotal: Math.round(mem.heapTotal / (1024 * 1024)),
          percentUsed: Math.round(percentUsed * 100),
        },
        'High memory usage warning'
      );
    }

    return memoryInfo;
  }

  /**
   * Perform cleanup of old temporary files
   */
  async performCleanup(): Promise<number> {
    try {
      const maxAgeMinutes = this.MAX_FILE_AGE_HOURS * 60;
      logger.info({ maxAgeMinutes }, 'Starting scheduled cleanup');

      await cleanupOldFiles(maxAgeMinutes);

      return 0;
    } catch (error) {
      logger.error({ error }, 'Cleanup failed');
      throw error;
    }
  }

  /**
   * Get comprehensive system status
   */
  async getSystemStatus(): Promise<SystemStatus> {
    const disk = await this.checkDiskSpace();
    const memory = this.getMemoryUsage();

    const warnings: string[] = [];
    let healthy = true;

    // Check disk space
    if (disk.available < this.DISK_WARNING_THRESHOLD) {
      warnings.push(`Low disk space: ${Math.round(disk.available / (1024 * 1024 * 1024) * 10) / 10} GB remaining`);
      healthy = false;
    }

    // Check memory usage
    if (memory.percentUsed > this.MEMORY_WARNING_THRESHOLD * 100) {
      warnings.push(`High memory usage: ${Math.round(memory.percentUsed)}%`);
      healthy = false;
    }

    return {
      disk,
      memory,
      healthy,
      warnings,
    };
  }

  /**
   * Check system and log warnings
   */
  private async checkSystem(): Promise<void> {
    const status = await this.getSystemStatus();

    if (!status.healthy) {
      logger.warn({ status }, 'System health check warnings');
    } else {
      logger.debug({ status }, 'System health check passed');
    }
  }

  /**
   * Check if system has enough resources for operation
   */
  async hasEnoughResources(): Promise<boolean> {
    try {
      const disk = await this.checkDiskSpace();
      const memory = this.getMemoryUsage();

      return (
        disk.available > this.DISK_WARNING_THRESHOLD &&
        memory.percentUsed < this.MEMORY_WARNING_THRESHOLD * 100
      );
    } catch (error) {
      logger.error({ error }, 'Resource check failed');
      return false; // Assume not enough resources if check fails
    }
  }
}

// Global singleton instance
let resourceMonitor: ResourceMonitor | null = null;

/**
 * Get or create the global resource monitor instance
 */
export function getResourceMonitor(): ResourceMonitor {
  if (!resourceMonitor) {
    resourceMonitor = new ResourceMonitor();
  }
  return resourceMonitor;
}
