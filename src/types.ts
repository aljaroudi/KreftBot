export enum Platform {
  YouTube = 'youtube',
  Twitter = 'twitter',
  Instagram = 'instagram',
  Reddit = 'reddit',
  TikTok = 'tiktok',
}

export interface Format {
  formatId: string;
  quality: string;
  extension: string;
  fileSize?: number;
  description: string;
  isAudioOnly: boolean;
  isVideoOnly: boolean;
}

export interface ContentInfo {
  title: string;
  duration?: number;
  thumbnail?: string;
  uploader?: string;
  url: string;
}
