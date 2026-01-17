import { Bot } from 'grammy';
import { config, validateConfig } from './config';
import logger from './utils/logger';
import { registerDownloadHandlers } from './handlers/downloadHandler';
import { registerVideoHandlers } from './handlers/videoHandler';
import { registerImageHandlers } from './handlers/imageHandler';
import { setupGracefulShutdown, registerShutdownHandlers } from './utils/shutdown';
import { getResourceMonitor } from './utils/resourceMonitor';
import { getAnalytics } from './utils/analytics';
import { getHealthStatus, formatHealthStatus } from './utils/healthCheck';
import { getRateLimitMiddleware } from './middleware/rateLimiter';
import { RequestQueue } from './utils/rateLimiter';

// Create bot instance
const bot = new Bot(config.botToken);

// Create global instances
const requestQueue = new RequestQueue(config.maxConcurrentDownloads, 5, 10 * 60 * 1000);
const resourceMonitor = getResourceMonitor();
const analytics = getAnalytics();
const rateLimitMiddleware = getRateLimitMiddleware();

// Apply rate limiting middleware
bot.use(rateLimitMiddleware.middleware());

// Register handlers (pass requestQueue to handlers that need it)
registerDownloadHandlers(bot);
registerVideoHandlers(bot);
registerImageHandlers(bot);

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
• /cancel - Cancel your pending operations
• /status - Check bot system status

💡 **Tips**
• Just send a URL and I'll handle the rest
• Select your preferred format from the options
• Processing may take a few moments for large files

Need help? Report issues at: github.com/anthropics/kreftbot
  `.trim();

  await ctx.reply(helpMessage);
});

// Command: /cancel
bot.command('cancel', async (ctx) => {
  const userId = ctx.from?.id;

  if (!userId) {
    await ctx.reply('❌ Unable to identify user');
    return;
  }

  const cancelled = requestQueue.cancelUserRequests(userId);

  if (cancelled > 0) {
    await ctx.reply(`✅ Cancelled ${cancelled} operation(s)`);
    logger.info({ userId, cancelled }, 'User cancelled operations');
  } else {
    await ctx.reply('No active operations to cancel');
  }
});

// Command: /status (for monitoring)
bot.command('status', async (ctx) => {
  try {
    const health = await getHealthStatus(requestQueue, resourceMonitor, analytics);
    const statusText = formatHealthStatus(health);

    await ctx.reply(`📊 Bot Status\n\n\`\`\`\n${statusText}\n\`\`\``, {
      parse_mode: 'Markdown',
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get status');
    await ctx.reply('❌ Failed to retrieve status');
  }
});

// Error handler
bot.catch((err) => {
  logger.error({ err }, 'Bot error occurred');
});

// Start bot
async function startBot() {
  try {
    logger.info('🚀 Starting KreftBot...');

    // Validate configuration and dependencies
    logger.info('Validating configuration and dependencies...');
    await validateConfig();
    logger.info('✅ Configuration and dependencies validated');

    // Start resource monitor
    logger.info('Starting resource monitor...');
    resourceMonitor.start();

    // Register shutdown handlers
    registerShutdownHandlers({
      bot,
      requestQueue,
      resourceMonitor,
      additionalCleanup: async () => {
        // Log final stats before shutdown
        logger.info({ analytics: analytics.getSummary() }, 'Final analytics before shutdown');
      },
    });

    // Setup graceful shutdown signal handlers
    setupGracefulShutdown();

    // Start the bot
    logger.info('Starting bot polling...');
    await bot.start();

    logger.info('✅ KreftBot is running! Press Ctrl+C to stop.');
    logger.info({
      tempDir: config.tempDir,
      maxFileSizeMB: config.maxFileSizeMB,
      maxConcurrent: config.maxConcurrentDownloads,
    }, 'Bot configuration');

    // Schedule daily stats logging
    setInterval(() => {
      analytics.logDailySummary();
    }, 24 * 60 * 60 * 1000); // Every 24 hours
  } catch (error) {
    logger.error({ error }, '❌ Failed to start bot');
    process.exit(1);
  }
}

startBot();
