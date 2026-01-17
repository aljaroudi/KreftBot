/**
 * Rate limiting middleware for preventing abuse
 */

import { Context, NextFunction } from 'grammy';
import { logger } from '../utils/logger';

interface UserRateLimit {
  requestCount: number;
  firstRequestTime: number;
  windowResets: {
    minute: number;
    hour: number;
    day: number;
  };
}

/**
 * Time-window based rate limiter
 */
export class RateLimitMiddleware {
  private userLimits = new Map<number, UserRateLimit>();
  private readonly limits = {
    perMinute: 10,
    perHour: 50,
    perDay: 200,
  };

  /**
   * Check if user is rate limited
   */
  private isRateLimited(userId: number): { limited: boolean; timeRemaining?: number; window?: string } {
    const now = Date.now();
    const userLimit = this.userLimits.get(userId);

    if (!userLimit) {
      // New user, initialize
      this.userLimits.set(userId, {
        requestCount: 1,
        firstRequestTime: now,
        windowResets: {
          minute: now + 60 * 1000,
          hour: now + 60 * 60 * 1000,
          day: now + 24 * 60 * 60 * 1000,
        },
      });
      return { limited: false };
    }

    // Check and reset windows
    if (now >= userLimit.windowResets.minute) {
      // Reset minute window
      userLimit.windowResets.minute = now + 60 * 1000;
      userLimit.requestCount = 0;
    }

    if (now >= userLimit.windowResets.hour) {
      // Reset hour window
      userLimit.windowResets.hour = now + 60 * 60 * 1000;
    }

    if (now >= userLimit.windowResets.day) {
      // Reset day window
      userLimit.windowResets.day = now + 24 * 60 * 60 * 1000;
    }

    // Count requests in current minute
    const minuteRequests = userLimit.requestCount + 1;

    // Check limits (simplified - tracking only current window)
    if (minuteRequests > this.limits.perMinute) {
      const timeRemaining = Math.ceil((userLimit.windowResets.minute - now) / 1000);
      return { limited: true, timeRemaining, window: 'minute' };
    }

    // Update counter
    userLimit.requestCount = minuteRequests;
    return { limited: false };
  }

  /**
   * Format time remaining as human-readable string
   */
  private formatTimeRemaining(seconds: number): string {
    if (seconds < 60) {
      return `${seconds} second${seconds !== 1 ? 's' : ''}`;
    } else if (seconds < 3600) {
      const minutes = Math.ceil(seconds / 60);
      return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
    } else {
      const hours = Math.ceil(seconds / 3600);
      return `${hours} hour${hours !== 1 ? 's' : ''}`;
    }
  }

  /**
   * Middleware function to apply rate limiting
   */
  middleware() {
    return async (ctx: Context, next: NextFunction) => {
      const userId = ctx.from?.id;

      if (!userId) {
        // If no user ID, allow the request (shouldn't happen in normal operation)
        return next();
      }

      const { limited, timeRemaining, window } = this.isRateLimited(userId);

      if (limited && timeRemaining) {
        logger.warn({ userId, timeRemaining, window }, 'User rate limited');

        await ctx.reply(
          `⏳ Slow down! You've made too many requests.\n\n` +
          `Try again in ${this.formatTimeRemaining(timeRemaining)}.`
        );

        return; // Don't proceed to next handler
      }

      // User is not rate limited, proceed
      await next();
    };
  }

  /**
   * Cleanup old entries to prevent memory leak
   */
  cleanup(): void {
    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60 * 1000;

    for (const [userId, limit] of this.userLimits.entries()) {
      // Remove entries older than a day with no recent activity
      if (limit.windowResets.day < dayAgo) {
        this.userLimits.delete(userId);
      }
    }

    logger.debug({ remainingUsers: this.userLimits.size }, 'Rate limiter cleanup complete');
  }

  /**
   * Get statistics about rate limiting
   */
  getStats(): { totalUsers: number; rateLimitedUsers: number } {
    let rateLimitedUsers = 0;
    const now = Date.now();

    for (const limit of this.userLimits.values()) {
      // Check if user is currently in a rate limited state
      if (limit.requestCount >= this.limits.perMinute && now < limit.windowResets.minute) {
        rateLimitedUsers++;
      }
    }

    return {
      totalUsers: this.userLimits.size,
      rateLimitedUsers,
    };
  }

  /**
   * Reset rate limits for a specific user (admin function)
   */
  resetUser(userId: number): boolean {
    return this.userLimits.delete(userId);
  }

  /**
   * Reset all rate limits (admin function)
   */
  resetAll(): void {
    this.userLimits.clear();
    logger.info('All rate limits reset');
  }
}

// Global singleton instance
let rateLimitMiddleware: RateLimitMiddleware | null = null;

/**
 * Get or create the global rate limit middleware instance
 */
export function getRateLimitMiddleware(): RateLimitMiddleware {
  if (!rateLimitMiddleware) {
    rateLimitMiddleware = new RateLimitMiddleware();

    // Setup cleanup every hour
    setInterval(() => {
      rateLimitMiddleware!.cleanup();
    }, 60 * 60 * 1000);
  }

  return rateLimitMiddleware;
}
