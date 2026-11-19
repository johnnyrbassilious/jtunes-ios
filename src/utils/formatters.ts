export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return '00:00';
  }
  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  const mm = String(minutes).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');

  if (hours > 0) {
    return `${hours}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatMegabytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0.00 MB';
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function isHttpUrl(input: string): boolean {
  const trimmed = input.trim();
  return /^https?:\/\/.+/i.test(trimmed);
}

export function normalizeBackendUrl(rawUrl: string): string {
  return rawUrl.trim().replace(/\/+$/, '');
}

export function detectPlatform(url: string): string {
  const lower = url.toLowerCase();
  if (lower.includes('youtube.com') || lower.includes('youtu.be')) {
    return 'YouTube';
  }
  if (lower.includes('tiktok.com')) {
    return 'TikTok';
  }
  if (lower.includes('instagram.com')) {
    return 'Instagram';
  }
  if (lower.includes('soundcloud.com')) {
    return 'SoundCloud';
  }
  if (lower.includes('twitter.com') || lower.includes('x.com')) {
    return 'X';
  }
  return 'Web';
}

export function sanitizeFilename(title: string, extension: string): string {
  const cleaned = title
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  const base = cleaned || 'tubidy-fm-media';
  return `${base}.${extension}`;
}
