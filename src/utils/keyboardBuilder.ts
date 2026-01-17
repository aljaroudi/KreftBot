import { InlineKeyboard } from 'grammy';
import { Format } from '../types';

/**
 * Builds an inline keyboard for format selection
 */
export function buildFormatSelectionKeyboard(formats: Format[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  // Separate formats into categories
  const videoFormats = formats.filter(f => !f.isAudioOnly && !f.isVideoOnly);
  const videoOnlyFormats = formats.filter(f => f.isVideoOnly);
  const audioFormats = formats.filter(f => f.isAudioOnly);

  // Sort video formats by quality (descending)
  const sortedVideo = videoFormats.sort((a, b) => {
    const qualityA = parseInt(a.quality) || 0;
    const qualityB = parseInt(b.quality) || 0;
    return qualityB - qualityA;
  });

  // Sort video-only formats by quality
  const sortedVideoOnly = videoOnlyFormats.sort((a, b) => {
    const qualityA = parseInt(a.quality) || 0;
    const qualityB = parseInt(b.quality) || 0;
    return qualityB - qualityA;
  });

  // Sort audio formats by quality
  const sortedAudio = audioFormats.sort((a, b) => {
    const qualityA = parseInt(a.quality) || 0;
    const qualityB = parseInt(b.quality) || 0;
    return qualityB - qualityA;
  });

  // Add "Best Quality" option using yt-dlp's smart selector
  keyboard.text('🎬 Best Quality (auto)', 'download:bestvideo+bestaudio/best').row();

  // If we have combined video+audio formats, show them
  if (sortedVideo.length > 0) {
    const topVideo = sortedVideo.slice(0, 3);
    for (const format of topVideo) {
      keyboard.text(format.description, `download:${format.formatId}`).row();
    }
  } else if (sortedVideoOnly.length > 0) {
    // If only video-only formats available, show top quality options with note
    const topVideoOnly = sortedVideoOnly.slice(0, 3);
    for (const format of topVideoOnly) {
      const desc = `${format.description} + audio`;
      keyboard.text(desc, `download:${format.formatId}+bestaudio`).row();
    }
  }

  // Add audio-only option
  if (sortedAudio.length > 0) {
    keyboard.text('🎵 Audio Only (best)', 'download:bestaudio').row();
  }

  return keyboard;
}
