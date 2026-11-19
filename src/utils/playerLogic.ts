import type { LoopMode, PlayableTrack } from '../types/media';

export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5] as const;
export type PlaybackRate = (typeof PLAYBACK_RATES)[number];

export function getNextLoopMode(current: LoopMode): LoopMode {
  if (current === 'off') {
    return 'all';
  }
  if (current === 'all') {
    return 'one';
  }
  return 'off';
}

export function clampSeekTime(targetSeconds: number, durationSeconds: number): number {
  if (!Number.isFinite(targetSeconds) || targetSeconds <= 0) {
    return 0;
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return targetSeconds;
  }
  return Math.min(durationSeconds, Math.max(0, targetSeconds));
}

export function getNextTrackIndex(
  currentIndex: number,
  queueLength: number,
  loopQueue: boolean
): number {
  if (queueLength <= 0 || currentIndex < 0) {
    return -1;
  }
  if (currentIndex + 1 < queueLength) {
    return currentIndex + 1;
  }
  return loopQueue ? 0 : -1;
}

export function getPreviousTrackAction(
  currentIndex: number,
  currentTimeSeconds: number,
  queueLength: number
): { action: 'restart' | 'switch' | 'none'; targetIndex: number } {
  if (queueLength <= 0 || currentIndex < 0) {
    return { action: 'none', targetIndex: -1 };
  }
  if (currentTimeSeconds > 3) {
    return { action: 'restart', targetIndex: currentIndex };
  }
  if (currentIndex > 0) {
    return { action: 'switch', targetIndex: currentIndex - 1 };
  }
  return { action: 'restart', targetIndex: 0 };
}

export function getNextPlaybackRate(currentRate: number): PlaybackRate {
  const index = PLAYBACK_RATES.indexOf(currentRate as PlaybackRate);
  if (index === -1) {
    return 1;
  }
  return PLAYBACK_RATES[(index + 1) % PLAYBACK_RATES.length];
}

export function insertPlayNextInQueue(
  queue: PlayableTrack[],
  currentIndex: number,
  track: PlayableTrack
): { queue: PlayableTrack[]; currentIndex: number } {
  if (queue.length === 0 || currentIndex < 0 || currentIndex >= queue.length) {
    return { queue: [track], currentIndex: 0 };
  }

  const currentTrack = queue[currentIndex];
  if (currentTrack.id === track.id) {
    return { queue, currentIndex };
  }

  const filtered: PlayableTrack[] = [];
  let nextCurrentIndex = currentIndex;
  for (let i = 0; i < queue.length; i++) {
    if (queue[i].id === track.id) {
      if (i < currentIndex) {
        nextCurrentIndex -= 1;
      }
      continue;
    }
    filtered.push(queue[i]);
  }

  const insertAt = Math.min(filtered.length, nextCurrentIndex + 1);
  const updated = [
    ...filtered.slice(0, insertAt),
    track,
    ...filtered.slice(insertAt),
  ];

  return { queue: updated, currentIndex: nextCurrentIndex };
}

export function formatSleepCountdown(remainingSeconds: number): string {
  const safe = Math.max(0, Math.floor(remainingSeconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function buildMediaMetadataInit(track: PlayableTrack): MediaMetadataInit {
  const artwork: MediaImage[] = track.thumbnail
    ? [
        { src: track.thumbnail, sizes: '512x512', type: 'image/jpeg' },
        { src: track.thumbnail, sizes: '256x256', type: 'image/jpeg' },
      ]
    : [];

  return {
    title: track.title || 'Tubidy FM',
    artist: track.uploader || 'Unknown Artist',
    album: 'Tubidy FM',
    artwork,
  };
}
