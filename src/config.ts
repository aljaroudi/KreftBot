import 'dotenv/config';

interface Config {
  botToken: string;
  tempDir: string;
  maxFileSizeMB: number;
  maxConcurrentDownloads: number;
  logLevel: string;
}

function getConfig(): Config {
  const botToken = process.env.BOT_TOKEN;

  if (!botToken) {
    throw new Error(
      'BOT_TOKEN is required! Please set it in your .env file.\n' +
      'Get your bot token from @BotFather on Telegram.'
    );
  }

  return {
    botToken,
    tempDir: process.env.TEMP_DIR || '/tmp/telegram-bot',
    maxFileSizeMB: parseInt(process.env.MAX_FILE_SIZE_MB || '50', 10),
    maxConcurrentDownloads: parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || '3', 10),
    logLevel: process.env.LOG_LEVEL || 'info',
  };
}

export const config = getConfig();
