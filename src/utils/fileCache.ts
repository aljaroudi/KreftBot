/**
 * File path cache for storing temporary file paths with short IDs
 * Used to work around Telegram's 64-byte callback_data limit
 */

interface CacheEntry {
  path: string;
  timestamp: number;
  userId: number;
}

class FileCache {
  private cache = new Map<string, CacheEntry>();
  private readonly TTL = 60 * 60 * 1000; // 1 hour
  private cleanupInterval: Timer | null = null;

  constructor() {
    // Start cleanup job
    this.startCleanup();
  }

  /**
   * Store a file path and return a short ID
   */
  set(path: string, userId: number): string {
    // Generate short ID (8 chars)
    const id = this.generateId();
    
    this.cache.set(id, {
      path,
      timestamp: Date.now(),
      userId,
    });

    return id;
  }

  /**
   * Retrieve a file path by ID
   */
  get(id: string, userId: number): string | null {
    const entry = this.cache.get(id);
    
    if (!entry) {
      return null;
    }

    // Verify userId matches (security check)
    if (entry.userId !== userId) {
      return null;
    }

    // Check if expired
    if (Date.now() - entry.timestamp > this.TTL) {
      this.cache.delete(id);
      return null;
    }

    return entry.path;
  }

  /**
   * Delete an entry
   */
  delete(id: string): void {
    this.cache.delete(id);
  }

  /**
   * Generate a short unique ID
   */
  private generateId(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let id = '';
    
    // Generate until we find a unique one
    do {
      id = '';
      for (let i = 0; i < 8; i++) {
        id += chars[Math.floor(Math.random() * chars.length)];
      }
    } while (this.cache.has(id));

    return id;
  }

  /**
   * Start periodic cleanup of expired entries
   */
  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      
      for (const [id, entry] of this.cache.entries()) {
        if (now - entry.timestamp > this.TTL) {
          this.cache.delete(id);
        }
      }
    }, 5 * 60 * 1000); // Run every 5 minutes
  }

  /**
   * Stop cleanup job
   */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.cache.clear();
  }
}

// Singleton instance
let instance: FileCache | null = null;

export function getFileCache(): FileCache {
  if (!instance) {
    instance = new FileCache();
  }
  return instance;
}
