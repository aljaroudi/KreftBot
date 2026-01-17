import { Context } from 'grammy';
import { logger } from './logger';

interface ProgressInfo {
  percentage: number;
  downloadedSize?: string;
  totalSize?: string;
  speed?: string;
  eta?: string;
}

/**
 * Manages download progress tracking and Telegram message updates
 */
export class DownloadProgress {
  private lastUpdateTime = 0;
  private lastPercentage = 0;
  private messageId?: number;
  private ctx: Context;

  // Update every 5 seconds or 10% progress change
  private readonly UPDATE_INTERVAL_MS = 5000;
  private readonly PERCENTAGE_THRESHOLD = 10;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  /**
   * Parses yt-dlp progress output line
   * Example: "[download] 45.2% of 12.34MiB at 1.23MiB/s ETA 00:06"
   */
  parseProgress(line: string): ProgressInfo | null {
    // Match various yt-dlp progress formats
    const percentageMatch = line.match(/(\d+\.?\d*)%/);
    if (!percentageMatch) {
      return null;
    }

    const percentage = parseFloat(percentageMatch[1]);

    // Extract size info (e.g., "5.6MiB of 12.3MiB")
    const sizeMatch = line.match(/(\d+\.?\d*[KMG]iB)\s+of\s+(\d+\.?\d*[KMG]iB)/);
    const downloadedSize = sizeMatch?.[1];
    const totalSize = sizeMatch?.[2];

    // Extract speed (e.g., "at 1.23MiB/s")
    const speedMatch = line.match(/at\s+(\d+\.?\d*[KMG]iB\/s)/);
    const speed = speedMatch?.[1];

    // Extract ETA (e.g., "ETA 00:06")
    const etaMatch = line.match(/ETA\s+(\d{2}:\d{2})/);
    const eta = etaMatch?.[1];

    return {
      percentage,
      downloadedSize,
      totalSize,
      speed,
      eta,
    };
  }

  /**
   * Updates the Telegram message with current progress
   */
  async update(progressInfo: ProgressInfo): Promise<void> {
    const now = Date.now();
    const timeSinceLastUpdate = now - this.lastUpdateTime;
    const percentageChange = Math.abs(progressInfo.percentage - this.lastPercentage);

    // Only update if threshold met (time or percentage)
    if (
      timeSinceLastUpdate < this.UPDATE_INTERVAL_MS &&
      percentageChange < this.PERCENTAGE_THRESHOLD
    ) {
      return;
    }

    const message = this.formatProgressMessage(progressInfo);

    try {
      if (this.messageId) {
        await this.ctx.api.editMessageText(
          this.ctx.chat!.id,
          this.messageId,
          message
        );
      } else {
        const sentMessage = await this.ctx.reply(message);
        this.messageId = sentMessage.message_id;
      }

      this.lastUpdateTime = now;
      this.lastPercentage = progressInfo.percentage;
    } catch (error) {
      // Ignore errors from too frequent updates (Telegram rate limits)
      logger.debug({ error }, 'Failed to update progress message');
    }
  }

  /**
   * Formats progress information into user-friendly message
   */
  private formatProgressMessage(info: ProgressInfo): string {
    let message = '⬇️ Downloading...\n';
    message += `Progress: ${info.percentage.toFixed(1)}%\n`;

    if (info.downloadedSize && info.totalSize) {
      message += `Size: ${info.downloadedSize} / ${info.totalSize}\n`;
    }

    if (info.speed) {
      message += `Speed: ${info.speed}\n`;
    }

    if (info.eta) {
      message += `ETA: ${info.eta}`;
    }

    return message;
  }

  /**
   * Shows initial "Downloading..." message
   */
  async start(): Promise<void> {
    try {
      const sentMessage = await this.ctx.reply('⬇️ Downloading...');
      this.messageId = sentMessage.message_id;
      this.lastUpdateTime = Date.now();
    } catch (error) {
      logger.error({ error }, 'Failed to send initial progress message');
    }
  }

  /**
   * Updates message to show completion
   */
  async complete(): Promise<void> {
    if (!this.messageId) {
      return;
    }

    try {
      await this.ctx.api.editMessageText(
        this.ctx.chat!.id,
        this.messageId,
        '✅ Download completed!'
      );
    } catch (error) {
      logger.debug({ error }, 'Failed to update completion message');
    }
  }

  /**
   * Updates message to show error
   */
  async error(errorMessage: string): Promise<void> {
    if (!this.messageId) {
      await this.ctx.reply(`❌ ${errorMessage}`);
      return;
    }

    try {
      await this.ctx.api.editMessageText(
        this.ctx.chat!.id,
        this.messageId,
        `❌ ${errorMessage}`
      );
    } catch (error) {
      logger.debug({ error }, 'Failed to update error message');
      await this.ctx.reply(`❌ ${errorMessage}`);
    }
  }
}
