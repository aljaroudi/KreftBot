/**
 * Health check endpoint for monitoring KreftBot
 */

import { logger } from './logger';
import { RequestQueue } from './rateLimiter';
import { ResourceMonitor } from './resourceMonitor';
import { Analytics } from './analytics';

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number; // seconds
  timestamp: number;
  system: {
    diskAvailable: number; // GB
    diskPercentUsed: number;
    memoryPercentUsed: number;
  };
  queue: {
    active: number;
    queued: number;
  };
  analytics: {
    totalDownloads: number;
    totalErrors: number;
    activeUsers: number;
  };
  lastError?: {
    type: string;
    timestamp: number;
  };
  warnings: string[];
}

let lastError: { type: string; timestamp: number } | undefined;

/**
 * Record the last error for health status
 */
export function recordLastError(errorType: string): void {
  lastError = {
    type: errorType,
    timestamp: Date.now(),
  };
}

/**
 * Get comprehensive health status
 */
export async function getHealthStatus(
  requestQueue?: RequestQueue,
  resourceMonitor?: ResourceMonitor,
  analytics?: Analytics
): Promise<HealthStatus> {
  const warnings: string[] = [];
  let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';

  // Get system resources
  let diskAvailable = 0;
  let diskPercentUsed = 0;
  let memoryPercentUsed = 0;

  if (resourceMonitor) {
    try {
      const systemStatus = await resourceMonitor.getSystemStatus();

      diskAvailable = Math.round(systemStatus.disk.available / (1024 * 1024 * 1024) * 10) / 10;
      diskPercentUsed = Math.round(systemStatus.disk.percentUsed);
      memoryPercentUsed = Math.round(systemStatus.memory.percentUsed);

      if (!systemStatus.healthy) {
        status = 'degraded';
        warnings.push(...systemStatus.warnings);
      }
    } catch (error) {
      logger.error({ error }, 'Failed to get system status for health check');
      status = 'degraded';
      warnings.push('System resource check failed');
    }
  }

  // Get queue statistics
  let queueActive = 0;
  let queueQueued = 0;

  if (requestQueue) {
    const queueStats = requestQueue.getStats();
    queueActive = queueStats.totalActive;
    queueQueued = queueStats.totalQueued;

    // Warn if queue is getting large
    if (queueQueued > 10) {
      warnings.push(`Large queue size: ${queueQueued} pending requests`);
      status = 'degraded';
    }
  }

  // Get analytics
  let totalDownloads = 0;
  let totalErrors = 0;
  let activeUsers = 0;

  if (analytics) {
    const summary = analytics.getSummary();
    totalDownloads = summary.totalDownloads;
    totalErrors = summary.totalErrors;
    activeUsers = summary.activeUsers;

    // Check error rate
    if (totalDownloads > 0) {
      const errorRate = totalErrors / (totalDownloads + totalErrors);
      if (errorRate > 0.3) {
        warnings.push(`High error rate: ${Math.round(errorRate * 100)}%`);
        status = 'unhealthy';
      } else if (errorRate > 0.1) {
        warnings.push(`Elevated error rate: ${Math.round(errorRate * 100)}%`);
        if (status === 'healthy') status = 'degraded';
      }
    }
  }

  // Check if there are recent errors
  if (lastError) {
    const timeSinceError = Date.now() - lastError.timestamp;
    // If error occurred in last 5 minutes, include it
    if (timeSinceError < 5 * 60 * 1000) {
      warnings.push(`Recent error: ${lastError.type}`);
      if (status === 'healthy') status = 'degraded';
    }
  }

  return {
    status,
    uptime: process.uptime(),
    timestamp: Date.now(),
    system: {
      diskAvailable,
      diskPercentUsed,
      memoryPercentUsed,
    },
    queue: {
      active: queueActive,
      queued: queueQueued,
    },
    analytics: {
      totalDownloads,
      totalErrors,
      activeUsers,
    },
    lastError,
    warnings,
  };
}

/**
 * Format health status as human-readable string
 */
export function formatHealthStatus(health: HealthStatus): string {
  const lines: string[] = [];

  lines.push(`Status: ${health.status.toUpperCase()}`);
  lines.push(`Uptime: ${Math.round(health.uptime / 60)} minutes`);
  lines.push('');
  lines.push('System:');
  lines.push(`  Disk: ${health.system.diskAvailable} GB available (${health.system.diskPercentUsed}% used)`);
  lines.push(`  Memory: ${health.system.memoryPercentUsed}% used`);
  lines.push('');
  lines.push('Queue:');
  lines.push(`  Active: ${health.queue.active}`);
  lines.push(`  Queued: ${health.queue.queued}`);
  lines.push('');
  lines.push('Analytics:');
  lines.push(`  Total Downloads: ${health.analytics.totalDownloads}`);
  lines.push(`  Total Errors: ${health.analytics.totalErrors}`);
  lines.push(`  Active Users: ${health.analytics.activeUsers}`);

  if (health.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const warning of health.warnings) {
      lines.push(`  ⚠️ ${warning}`);
    }
  }

  if (health.lastError) {
    const timeSinceError = Date.now() - health.lastError.timestamp;
    const minutesAgo = Math.round(timeSinceError / 60000);
    lines.push('');
    lines.push(`Last Error: ${health.lastError.type} (${minutesAgo}m ago)`);
  }

  return lines.join('\n');
}

/**
 * Log health status
 */
export async function logHealthStatus(
  requestQueue?: RequestQueue,
  resourceMonitor?: ResourceMonitor,
  analytics?: Analytics
): Promise<void> {
  const health = await getHealthStatus(requestQueue, resourceMonitor, analytics);

  if (health.status === 'unhealthy') {
    logger.error({ health }, 'System health check: UNHEALTHY');
  } else if (health.status === 'degraded') {
    logger.warn({ health }, 'System health check: DEGRADED');
  } else {
    logger.info({ health }, 'System health check: HEALTHY');
  }
}
