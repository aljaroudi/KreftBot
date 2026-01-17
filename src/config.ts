import 'dotenv/config';
import { spawn } from 'bun';
import { mkdir } from 'fs/promises';

interface Config {
  botToken: string;
  tempDir: string;
  maxFileSizeMB: number;
  maxConcurrentDownloads: number;
  logLevel: string;
}

/**
 * Validate Telegram bot token format
 */
function isValidTelegramToken(token: string): boolean {
  // Telegram bot tokens follow the format: <bot_id>:<token>
  // Example: 123456789:ABCdefGHIjklMNOpqrsTUVwxyz
  const tokenPattern = /^\d+:[A-Za-z0-9_-]{35,}$/;
  return tokenPattern.test(token);
}

/**
 * Check if a command exists in the system
 */
async function checkCommandExists(command: string): Promise<boolean> {
  try {
    const proc = spawn(['which', command], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Validate system dependencies
 */
async function validateDependencies(): Promise<void> {
  const errors: string[] = [];

  // Check for yt-dlp
  if (!(await checkCommandExists('yt-dlp'))) {
    errors.push(
      'yt-dlp is not installed. Install it from: https://github.com/yt-dlp/yt-dlp#installation'
    );
  }

  // Check for ffmpeg
  if (!(await checkCommandExists('ffmpeg'))) {
    errors.push(
      'ffmpeg is not installed. Install it:\n' +
      '  Ubuntu/Debian: sudo apt-get install ffmpeg\n' +
      '  macOS: brew install ffmpeg'
    );
  }

  if (errors.length > 0) {
    throw new Error(
      '❌ Missing required dependencies:\n\n' +
      errors.join('\n\n') +
      '\n\nPlease install the missing dependencies and try again.'
    );
  }
}

/**
 * Ensure temp directory exists
 */
async function ensureDirectoryExists(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true });
  } catch (error) {
    throw new Error(`Failed to create directory ${path}: ${error}`);
  }
}

/**
 * Get and validate configuration
 */
function getConfig(): Config {
  const botToken = process.env.BOT_TOKEN;

  if (!botToken) {
    throw new Error(
      '❌ BOT_TOKEN is required! Please set it in your .env file.\n' +
      'Get your bot token from @BotFather on Telegram.'
    );
  }

  if (!isValidTelegramToken(botToken)) {
    throw new Error(
      '❌ BOT_TOKEN format is invalid!\n' +
      'Expected format: <bot_id>:<token> (e.g., 123456789:ABCdefGHIjklMNOpqrsTUVwxyz)\n' +
      'Get your bot token from @BotFather on Telegram.'
    );
  }

  const maxFileSizeMB = parseInt(process.env.MAX_FILE_SIZE_MB || '50', 10);
  const maxConcurrentDownloads = parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || '3', 10);

  // Validate numeric values
  if (isNaN(maxFileSizeMB) || maxFileSizeMB <= 0) {
    throw new Error('❌ MAX_FILE_SIZE_MB must be a positive number');
  }

  if (isNaN(maxConcurrentDownloads) || maxConcurrentDownloads <= 0) {
    throw new Error('❌ MAX_CONCURRENT_DOWNLOADS must be a positive number');
  }

  return {
    botToken,
    tempDir: process.env.TEMP_DIR || '/tmp/telegram-bot',
    maxFileSizeMB,
    maxConcurrentDownloads,
    logLevel: process.env.LOG_LEVEL || 'info',
  };
}

/**
 * Validate complete configuration and system
 */
export async function validateConfig(): Promise<void> {
  // Config validation happens in getConfig()
  const cfg = config;

  // Validate temp directory
  await ensureDirectoryExists(cfg.tempDir);

  // Validate system dependencies
  await validateDependencies();
}

export const config = getConfig();
