import { InlineKeyboard } from 'grammy';
import { Format } from '../types';

/**
 * Formats file size in bytes to MB or GB
 */
function formatFileSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(1)}GB`;
  }
  return `${mb.toFixed(1)}MB`;
}

/**
 * Builds an inline keyboard for format selection
 * Shows simplified options: Best, Middle, Lowest quality, and Audio only
 */
export function buildFormatSelectionKeyboard(formats: Format[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  // Separate formats into categories
  const videoFormats = formats.filter(f => !f.isAudioOnly && !f.isVideoOnly);
  const videoOnlyFormats = formats.filter(f => f.isVideoOnly);
  const audioFormats = formats.filter(f => f.isAudioOnly);

  // Helper to get quality number from format
  const getQualityNumber = (format: Format): number => {
    const match = format.quality.match(/(\d+)p/);
    return match ? parseInt(match[1]) : 0;
  };

  // Build list of available video formats (combined or video-only)
  const availableVideoFormats: Array<{ format: Format; quality: number; formatId: string }> = [];

  // Add combined video+audio formats
  for (const format of videoFormats) {
    const quality = getQualityNumber(format);
    if (quality > 0) {
      availableVideoFormats.push({
        format,
        quality,
        formatId: format.formatId,
      });
    }
  }

  // Add video-only formats (will combine with bestaudio)
  for (const format of videoOnlyFormats) {
    const quality = getQualityNumber(format);
    if (quality > 0) {
      availableVideoFormats.push({
        format,
        quality,
        formatId: `${format.formatId}+bestaudio`,
      });
    }
  }

  // Sort by quality (descending)
  availableVideoFormats.sort((a, b) => b.quality - a.quality);

  // Get best, middle, and lowest quality options
  if (availableVideoFormats.length > 0) {
    const best = availableVideoFormats[0];
    const middleIndex = Math.floor(availableVideoFormats.length / 2);
    const middle = availableVideoFormats[middleIndex];
    const lowest = availableVideoFormats[availableVideoFormats.length - 1];

    // Best quality - {pixels}p - {size}MB/GB
    const bestSize = best.format.fileSize || 0;
    const bestSizeLabel = bestSize > 0 ? ` - ${formatFileSize(bestSize)}` : '';
    keyboard.text(`🎬 ${best.quality}p${bestSizeLabel}`, `download:${best.formatId}`).row();

    // Middle quality - {pixels}p - {size}MB/GB
    // Show middle if we have at least 2 formats and middle is different from best
    if (availableVideoFormats.length >= 2 && middle.formatId !== best.formatId) {
      const middleSize = middle.format.fileSize || 0;
      const middleSizeLabel = middleSize > 0 ? ` - ${formatFileSize(middleSize)}` : '';
      keyboard.text(`🎬 ${middle.quality}p${middleSizeLabel}`, `download:${middle.formatId}`).row();
    }

    // Lowest quality - {pixels}p - {size}MB/GB
    // Show lowest if we have at least 2 formats and lowest is different from best
    if (availableVideoFormats.length >= 2 && lowest.formatId !== best.formatId) {
      const lowestSize = lowest.format.fileSize || 0;
      const lowestSizeLabel = lowestSize > 0 ? ` - ${formatFileSize(lowestSize)}` : '';
      keyboard.text(`🎬 ${lowest.quality}p${lowestSizeLabel}`, `download:${lowest.formatId}`).row();
    }
  } else {
    // Fallback: use yt-dlp's smart selector if no formats parsed
    keyboard.text('🎬 Best quality', 'download:bestvideo+bestaudio/best').row();
  }

  // Audio only - always show this option
  if (audioFormats.length > 0) {
    // Find best audio format
    const bestAudio = audioFormats.sort((a, b) => {
      const qualityA = parseInt(a.quality) || 0;
      const qualityB = parseInt(b.quality) || 0;
      return qualityB - qualityA;
    })[0];

    const audioSize = bestAudio.fileSize || 0;
    // Format as MB only (audio files are typically < 1GB)
    const audioSizeMB = audioSize > 0 ? ` - ${(audioSize / (1024 * 1024)).toFixed(1)}MB` : '';
    keyboard.text(`🎵 audio${audioSizeMB}`, 'download:bestaudio').row();
  } else {
    // No audio format available - show option without size, will extract from video
    keyboard.text('🎵 audio', 'download:extract_audio').row();
  }

  return keyboard;
}
