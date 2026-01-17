import { Bot } from 'grammy';
import { config } from './config';
import logger from './utils/logger';
import { registerDownloadHandlers } from './handlers/downloadHandler';

// Create bot instance
const bot = new Bot(config.botToken);

// Register download handlers
registerDownloadHandlers(bot);

// Command: /start
bot.command('start', async (ctx) => {
  const welcomeMessage = `
👋 Welcome to KreftBot!

I'm your media assistant that can help you:
📥 Download videos/images from YouTube, Twitter, Instagram, Reddit, and TikTok
🎵 Extract audio from videos
🗜️ Compress videos to specific file sizes
🖼️ Remove backgrounds from images
✨ Optimize and convert images
🔲 Generate QR codes

Send me a URL or use /help to see all available commands!
  `.trim();

  await ctx.reply(welcomeMessage);
});

// Command: /help
bot.command('help', async (ctx) => {
  const helpMessage = `
🤖 KreftBot - Help

📥 **Download Media**
Send any URL from:
• YouTube
• Twitter/X
• Instagram
• Reddit
• TikTok

I'll show you available formats to choose from!

🎬 **Video Transformations**
• Extract audio from videos
• Compress videos to target file size
• Optimize video quality

🖼️ **Image Transformations**
• Remove backgrounds
• Optimize image size
• Convert between formats (JPEG/PNG/WebP)

🔧 **Utilities**
• /qr <text> - Generate QR code

💡 **Tips**
• Just send a URL and I'll handle the rest
• Select your preferred format from the options
• Processing may take a few moments for large files

Need help? Report issues at: github.com/anthropics/kreftbot
  `.trim();

  await ctx.reply(helpMessage);
});

// Error handler
bot.catch((err) => {
  logger.error({ err }, 'Bot error occurred');
});

// Start bot
async function startBot() {
  try {
    logger.info('Starting KreftBot...');
    await bot.start();
    logger.info('KreftBot is running! Press Ctrl+C to stop.');
  } catch (error) {
    logger.error({ error }, 'Failed to start bot');
    process.exit(1);
  }
}

// Graceful shutdown
process.once('SIGINT', () => {
  logger.info('Stopping bot...');
  bot.stop();
});

process.once('SIGTERM', () => {
  logger.info('Stopping bot...');
  bot.stop();
});

startBot();
