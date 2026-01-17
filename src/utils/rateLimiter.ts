import { logger } from './logger';

interface QueuedRequest {
  userId: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

/**
 * Manages concurrent downloads per user with queueing
 */
export class RateLimiter {
  private activeDownloads = new Map<number, number>(); // userId -> count
  private queue: QueuedRequest[] = [];
  private maxConcurrentPerUser: number;

  constructor(maxConcurrentPerUser: number) {
    this.maxConcurrentPerUser = maxConcurrentPerUser;
  }

  /**
   * Acquires a download slot for the user
   * Returns a promise that resolves when a slot is available
   */
  async acquire(userId: number): Promise<() => void> {
    const currentCount = this.activeDownloads.get(userId) || 0;

    if (currentCount >= this.maxConcurrentPerUser) {
      // User has reached limit, queue the request
      logger.info({ userId, currentCount }, 'User reached download limit, queueing request');

      const position = this.getQueuePosition(userId);

      return new Promise<() => void>((resolve, reject) => {
        this.queue.push({ userId, resolve: () => resolve(this.createReleaser(userId)), reject });
      });
    }

    // Increment active downloads
    this.activeDownloads.set(userId, currentCount + 1);
    logger.info({ userId, activeCount: currentCount + 1 }, 'Download slot acquired');

    return this.createReleaser(userId);
  }

  /**
   * Creates a release function that decrements the user's active downloads
   */
  private createReleaser(userId: number): () => void {
    return () => {
      const currentCount = this.activeDownloads.get(userId) || 0;
      const newCount = Math.max(0, currentCount - 1);

      if (newCount === 0) {
        this.activeDownloads.delete(userId);
      } else {
        this.activeDownloads.set(userId, newCount);
      }

      logger.info({ userId, activeCount: newCount }, 'Download slot released');

      // Process next queued request for this user
      this.processQueue(userId);
    };
  }

  /**
   * Processes the next queued request for a user if slots are available
   */
  private processQueue(userId: number): void {
    const currentCount = this.activeDownloads.get(userId) || 0;

    if (currentCount >= this.maxConcurrentPerUser) {
      return; // User still at limit
    }

    // Find next request for this user
    const index = this.queue.findIndex(req => req.userId === userId);
    if (index === -1) {
      return; // No queued requests for this user
    }

    const request = this.queue.splice(index, 1)[0];

    // Increment active downloads
    this.activeDownloads.set(userId, currentCount + 1);
    logger.info({ userId, activeCount: currentCount + 1 }, 'Processing queued download');

    // Resolve the promise
    request.resolve();
  }

  /**
   * Gets the queue position for a user (1-indexed)
   */
  getQueuePosition(userId: number): number {
    const sameUserRequests = this.queue.filter(req => req.userId === userId).length;
    return sameUserRequests + 1;
  }

  /**
   * Gets the number of active downloads for a user
   */
  getActiveCount(userId: number): number {
    return this.activeDownloads.get(userId) || 0;
  }

  /**
   * Clears all queued requests (useful for shutdown)
   */
  clearQueue(): void {
    const queuedCount = this.queue.length;

    for (const request of this.queue) {
      request.reject(new Error('Request cancelled'));
    }

    this.queue = [];
    logger.info({ queuedCount }, 'Cleared download queue');
  }

  /**
   * Gets statistics about the rate limiter
   */
  getStats(): { totalActive: number; totalQueued: number; activeByUser: Map<number, number> } {
    let totalActive = 0;
    for (const count of this.activeDownloads.values()) {
      totalActive += count;
    }

    return {
      totalActive,
      totalQueued: this.queue.length,
      activeByUser: new Map(this.activeDownloads),
    };
  }
}
