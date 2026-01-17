import { logger } from './logger';

interface QueuedRequest {
  id: string;
  userId: number;
  resolve: () => void;
  reject: (error: Error) => void;
  timestamp: number;
  timeoutId?: NodeJS.Timeout;
}

/**
 * Manages concurrent operations per user with global limits and queueing
 */
export class RequestQueue {
  private activeOperations = new Map<number, number>(); // userId -> count
  private queue: QueuedRequest[] = [];
  private maxConcurrentPerUser: number;
  private maxGlobalConcurrent: number;
  private queueTimeout: number; // milliseconds
  private totalActive: number = 0;

  constructor(
    maxConcurrentPerUser: number = 2,
    maxGlobalConcurrent: number = 5,
    queueTimeout: number = 10 * 60 * 1000 // 10 minutes
  ) {
    this.maxConcurrentPerUser = maxConcurrentPerUser;
    this.maxGlobalConcurrent = maxGlobalConcurrent;
    this.queueTimeout = queueTimeout;
  }

  /**
   * Acquires an operation slot for the user
   * Returns a promise that resolves when a slot is available
   */
  async acquire(userId: number): Promise<() => void> {
    const currentCount = this.activeOperations.get(userId) || 0;

    // Check if user has reached per-user limit OR global limit reached
    if (currentCount >= this.maxConcurrentPerUser || this.totalActive >= this.maxGlobalConcurrent) {
      logger.info({ userId, currentCount, totalActive: this.totalActive }, 'Queueing request');

      return new Promise<() => void>((resolve, reject) => {
        const requestId = `${userId}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

        // Set timeout to auto-cancel if not started
        const timeoutId = setTimeout(() => {
          this.cancelRequest(requestId, new Error('Request timed out in queue'));
        }, this.queueTimeout);

        this.queue.push({
          id: requestId,
          userId,
          resolve: () => resolve(this.createReleaser(userId)),
          reject,
          timestamp: Date.now(),
          timeoutId,
        });
      });
    }

    // Increment active operations
    this.activeOperations.set(userId, currentCount + 1);
    this.totalActive++;
    logger.info({ userId, activeCount: currentCount + 1, totalActive: this.totalActive }, 'Operation slot acquired');

    return this.createReleaser(userId);
  }

  /**
   * Creates a release function that decrements the user's active operations
   */
  private createReleaser(userId: number): () => void {
    return () => {
      const currentCount = this.activeOperations.get(userId) || 0;
      const newCount = Math.max(0, currentCount - 1);

      if (newCount === 0) {
        this.activeOperations.delete(userId);
      } else {
        this.activeOperations.set(userId, newCount);
      }

      this.totalActive = Math.max(0, this.totalActive - 1);

      logger.info({ userId, activeCount: newCount, totalActive: this.totalActive }, 'Operation slot released');

      // Process next queued request
      this.processQueue();
    };
  }

  /**
   * Processes the next queued request if slots are available
   */
  private processQueue(): void {
    if (this.queue.length === 0) {
      return;
    }

    // Check if global limit allows processing
    if (this.totalActive >= this.maxGlobalConcurrent) {
      return;
    }

    // Find next request that can be processed
    for (let i = 0; i < this.queue.length; i++) {
      const request = this.queue[i];
      const currentCount = this.activeOperations.get(request.userId) || 0;

      // Check if this user can start a new operation
      if (currentCount < this.maxConcurrentPerUser) {
        // Remove from queue
        this.queue.splice(i, 1);

        // Clear timeout
        if (request.timeoutId) {
          clearTimeout(request.timeoutId);
        }

        // Increment active operations
        this.activeOperations.set(request.userId, currentCount + 1);
        this.totalActive++;

        logger.info(
          { userId: request.userId, activeCount: currentCount + 1, totalActive: this.totalActive },
          'Processing queued operation'
        );

        // Resolve the promise
        request.resolve();
        return; // Process one at a time
      }
    }
  }

  /**
   * Cancel a specific request by ID
   */
  private cancelRequest(requestId: string, error: Error): void {
    const index = this.queue.findIndex(req => req.id === requestId);
    if (index === -1) {
      return; // Already processed or cancelled
    }

    const request = this.queue.splice(index, 1)[0];

    if (request.timeoutId) {
      clearTimeout(request.timeoutId);
    }

    request.reject(error);
    logger.info({ requestId, userId: request.userId }, 'Request cancelled');
  }

  /**
   * Gets the queue position for a user (1-indexed)
   */
  getQueuePosition(userId: number): number {
    let position = 0;
    for (const request of this.queue) {
      if (request.userId === userId) {
        position++;
        if (position === 1) {
          // Return position in overall queue for first user request
          return this.queue.indexOf(request) + 1;
        }
      }
    }
    return position;
  }

  /**
   * Gets the number of active operations for a user
   */
  getActiveCount(userId: number): number {
    return this.activeOperations.get(userId) || 0;
  }

  /**
   * Cancel all requests for a specific user
   */
  cancelUserRequests(userId: number): number {
    let cancelledCount = 0;

    // Find and cancel all requests for this user
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].userId === userId) {
        const request = this.queue.splice(i, 1)[0];

        if (request.timeoutId) {
          clearTimeout(request.timeoutId);
        }

        request.reject(new Error('Cancelled by user'));
        cancelledCount++;
      }
    }

    if (cancelledCount > 0) {
      logger.info({ userId, cancelledCount }, 'Cancelled user requests');
    }

    return cancelledCount;
  }

  /**
   * Clears all queued requests (useful for shutdown)
   */
  clearQueue(): void {
    const queuedCount = this.queue.length;

    for (const request of this.queue) {
      if (request.timeoutId) {
        clearTimeout(request.timeoutId);
      }
      request.reject(new Error('System shutdown'));
    }

    this.queue = [];
    logger.info({ queuedCount }, 'Cleared request queue');
  }

  /**
   * Gets statistics about the request queue
   */
  getStats(): { totalActive: number; totalQueued: number; activeByUser: Map<number, number> } {
    return {
      totalActive: this.totalActive,
      totalQueued: this.queue.length,
      activeByUser: new Map(this.activeOperations),
    };
  }

  /**
   * Wait for all active operations to complete (with timeout)
   */
  async waitForCompletion(timeoutMs: number = 30000): Promise<boolean> {
    const startTime = Date.now();

    while (this.totalActive > 0) {
      if (Date.now() - startTime > timeoutMs) {
        logger.warn({ totalActive: this.totalActive }, 'Timeout waiting for operations to complete');
        return false;
      }

      // Wait 100ms before checking again
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    logger.info('All operations completed');
    return true;
  }
}

// For backward compatibility, export RateLimiter as alias
export const RateLimiter = RequestQueue;
