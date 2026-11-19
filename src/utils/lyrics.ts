export interface LyricLine {
  time: number;
  text: string;
}

export interface TrackLyricsResult {
  synced: LyricLine[];
  plain: string[];
  hasLyrics: boolean;
}

export function cleanTrackMetadataForLyrics(title: string, uploader: string): {
  cleanTitle: string;
  cleanArtist: string;
} {
  const cleanTitle = title
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\((?:official|lyric|lyrics|audio|video|hd|4k|hq|visualizer|live)[^)]*\)/gi, ' ')
    .replace(/\b(?:official\s+video|official\s+audio|music\s+video|lyric\s+video|hd|4k)\b/gi, ' ')
    .replace(/\b(?:feat\.?|ft\.?)\s+[^-|]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const cleanArtist = uploader
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/\b(?:Official|VEVO|Records|Music)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    cleanTitle: cleanTitle || title.trim(),
    cleanArtist: cleanArtist === 'Unknown Uploader' ? '' : cleanArtist,
  };
}

export function parseLrcLyrics(rawLrc: string): LyricLine[] {
  if (!rawLrc || !rawLrc.trim()) {
    return [];
  }

  const lines: LyricLine[] = [];
  const rowRegex = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\](.*)/;

  for (const rawLine of rawLrc.split(/\r?\n/)) {
    const match = rowRegex.exec(rawLine.trim());
    if (!match) {
      continue;
    }
    const minutes = Number(match[1]);
    const seconds = Number(match[2]);
    const fracRaw = match[3] ?? '0';
    const fracSeconds =
      fracRaw.length === 3 ? Number(fracRaw) / 1000 : Number(fracRaw) / 100;
    const text = (match[4] ?? '').trim();
    if (!Number.isFinite(minutes) || !Number.isFinite(seconds) || !text) {
      continue;
    }
    const time = minutes * 60 + seconds + fracSeconds;
    lines.push({ time, text });
  }

  return lines.sort((a, b) => a.time - b.time);
}

export function getActiveLyricIndex(lines: LyricLine[], currentTimeSeconds: number): number {
  if (lines.length === 0) {
    return -1;
  }
  let active = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time <= currentTimeSeconds + 0.15) {
      active = i;
    } else {
      break;
    }
  }
  return active;
}

export async function fetchTrackLyrics(
  title: string,
  uploader: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<TrackLyricsResult> {
  const { cleanTitle, cleanArtist } = cleanTrackMetadataForLyrics(title, uploader);
  const query = `${cleanTitle} ${cleanArtist}`.trim();
  if (!query) {
    return { synced: [], plain: [], hasLyrics: false };
  }

  try {
    const response = await fetchImpl(
      `https://lrclib.net/api/search?q=${encodeURIComponent(query)}`,
      { signal }
    );
    if (!response.ok) {
      return { synced: [], plain: [], hasLyrics: false };
    }
    const payload = (await response.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(payload) || payload.length === 0) {
      return { synced: [], plain: [], hasLyrics: false };
    }

    const withSynced = payload.find(
      (entry) => typeof entry.syncedLyrics === 'string' && entry.syncedLyrics.trim().length > 0
    );
    const withPlain = payload.find(
      (entry) => typeof entry.plainLyrics === 'string' && entry.plainLyrics.trim().length > 0
    );

    const best = withSynced ?? withPlain;
    if (!best) {
      return { synced: [], plain: [], hasLyrics: false };
    }

    const synced =
      typeof best.syncedLyrics === 'string' ? parseLrcLyrics(best.syncedLyrics) : [];
    const plain =
      typeof best.plainLyrics === 'string'
        ? best.plainLyrics
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)
        : [];

    return {
      synced,
      plain,
      hasLyrics: synced.length > 0 || plain.length > 0,
    };
  } catch {
    return { synced: [], plain: [], hasLyrics: false };
  }
}
