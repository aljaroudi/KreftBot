/**
 * Error types and user-friendly error messages for KreftBot
 */

export enum ErrorType {
  NETWORK_ERROR = 'NETWORK_ERROR',
  FILE_TOO_LARGE = 'FILE_TOO_LARGE',
  DOWNLOAD_FAILED = 'DOWNLOAD_FAILED',
  PROCESSING_FAILED = 'PROCESSING_FAILED',
  RATE_LIMITED = 'RATE_LIMITED',
  TIMEOUT = 'TIMEOUT',
  DISK_SPACE_LOW = 'DISK_SPACE_LOW',
  UNSUPPORTED_FORMAT = 'UNSUPPORTED_FORMAT',
  INVALID_URL = 'INVALID_URL',
  SYSTEM_ERROR = 'SYSTEM_ERROR',
}

export interface ErrorContext {
  type: ErrorType;
  message: string;
  originalError?: Error;
  metadata?: Record<string, any>;
}

/**
 * Custom error class for bot errors
 */
export class BotError extends Error {
  constructor(
    public type: ErrorType,
    message: string,
    public metadata?: Record<string, any>,
    public originalError?: Error
  ) {
    super(message);
    this.name = 'BotError';
  }
}

/**
 * Generate user-friendly error messages
 */
export function getUserErrorMessage(error: ErrorContext): string {
  const { type, metadata = {} } = error;

  switch (type) {
    case ErrorType.NETWORK_ERROR:
      return `🌐 Network error. ${metadata.attempt ? `Retrying... (attempt ${metadata.attempt}/3)` : 'Please try again.'}`;

    case ErrorType.FILE_TOO_LARGE:
      const size = metadata.size || 'Unknown';
      const limit = metadata.limit || 50;
      return `⚠️ File is ${size}MB. Telegram limit is ${limit}MB.\n\nTry:\n• Lower quality format\n• Audio only\n• Video compression`;

    case ErrorType.DOWNLOAD_FAILED:
      const reason = metadata.reason || 'Unknown error';
      return `❌ Download failed: ${reason}.\n\nPlease try again or use a different format.`;

    case ErrorType.PROCESSING_FAILED:
      return `❌ Processing failed. The file format may not be supported.\n\nTry a different format or contact support.`;

    case ErrorType.RATE_LIMITED:
      const position = metadata.position;
      return position
        ? `⏳ You're in queue (position #${position}). Processing will start soon...`
        : `⏳ Too many requests. Please slow down and try again in a moment.`;

    case ErrorType.TIMEOUT:
      return `⏱️ Operation timed out.\n\nTry:\n• A shorter video\n• Simpler operation\n• Try again later`;

    case ErrorType.DISK_SPACE_LOW:
      return `⚠️ Server storage is low. Please try again later.`;

    case ErrorType.UNSUPPORTED_FORMAT:
      return `❌ Format not supported.\n\nSupported platforms:\n• YouTube\n• Twitter/X\n• Instagram\n• Reddit\n• TikTok`;

    case ErrorType.INVALID_URL:
      return `❌ Invalid URL. Please send a valid URL from a supported platform.`;

    case ErrorType.SYSTEM_ERROR:
    default:
      return `❌ An unexpected error occurred. Please try again later.`;
  }
}

/**
 * Retry configuration
 */
export interface RetryConfig {
  maxAttempts: number;
  baseDelay: number; // milliseconds
  maxDelay: number; // milliseconds
  exponentialBase: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelay: 1000, // 1 second
  maxDelay: 8000, // 8 seconds
  exponentialBase: 2,
};

/**
 * Execute a function with exponential backoff retry logic
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {},
  onRetry?: (attempt: number, error: Error) => void
): Promise<T> {
  const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...config };
  let lastError: Error;

  for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry on last attempt
      if (attempt === retryConfig.maxAttempts) {
        break;
      }

      // Calculate delay with exponential backoff
      const delay = Math.min(
        retryConfig.baseDelay * Math.pow(retryConfig.exponentialBase, attempt - 1),
        retryConfig.maxDelay
      );

      // Call retry callback if provided
      if (onRetry) {
        onRetry(attempt, lastError);
      }

      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError!;
}

/**
 * Check if an error is retryable (network errors, temporary failures)
 */
export function isRetryableError(error: Error): boolean {
  const message = error.message.toLowerCase();

  // Network-related errors
  if (
    message.includes('network') ||
    message.includes('timeout') ||
    message.includes('econnrefused') ||
    message.includes('econnreset') ||
    message.includes('etimedout') ||
    message.includes('socket hang up')
  ) {
    return true;
  }

  // HTTP errors that are retryable
  if (
    message.includes('502') ||
    message.includes('503') ||
    message.includes('504') ||
    message.includes('429') // Rate limit - retry with backoff
  ) {
    return true;
  }

  return false;
}

/**
 * Parse file size from string (e.g., "15.2MB" -> 15.2)
 */
export function parseFileSize(sizeStr: string): number | null {
  const match = sizeStr.match(/([0-9.]+)\s*(MB|GB|KB)/i);
  if (!match) return null;

  const value = parseFloat(match[1]);
  const unit = match[2].toUpperCase();

  switch (unit) {
    case 'KB':
      return value / 1024;
    case 'MB':
      return value;
    case 'GB':
      return value * 1024;
    default:
      return null;
  }
}

/**
 * Format file size in MB
 */
export function formatFileSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);

  if (mb < 1) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  } else if (mb < 1024) {
    return `${mb.toFixed(1)} MB`;
  } else {
    return `${(mb / 1024).toFixed(2)} GB`;
  }
}
