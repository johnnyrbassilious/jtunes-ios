import type { MediaFormatMode, MediaItem, SearchFilterType } from '../types/media';
import { detectPlatform, normalizeBackendUrl } from './formatters';

export const DEFAULT_BACKEND_URL = 'https://tubidy-vercel-api.vercel.app';
export const BACKEND_URL_STORAGE_KEY = 'tubidy_backend_url';
export const RESOLVE_STREAM_TIMEOUT_MS = 8000;

export function getSavedBackendUrl(): string {
  if (typeof window === 'undefined' || !window.localStorage) {
    return DEFAULT_BACKEND_URL;
  }
  const stored = window.localStorage.getItem(BACKEND_URL_STORAGE_KEY);
  if (!stored || !stored.trim()) {
    window.localStorage.setItem(BACKEND_URL_STORAGE_KEY, DEFAULT_BACKEND_URL);
    return DEFAULT_BACKEND_URL;
  }
  return normalizeBackendUrl(stored);
}

export function saveBackendUrl(url: string): string {
  const normalized = normalizeBackendUrl(url) || DEFAULT_BACKEND_URL;
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(BACKEND_URL_STORAGE_KEY, normalized);
  }
  return normalized;
}

function parseDurationValue(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.max(0, raw);
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      return Math.max(0, Number(trimmed));
    }
    const parts = trimmed.split(':').map((p) => Number(p));
    if (parts.length >= 2 && parts.every((n) => Number.isFinite(n))) {
      return parts.reduce((acc, part) => acc * 60 + part, 0);
    }
  }
  return 0;
}

function inferMediaTypeFromRaw(
  obj: Record<string, unknown>,
  resolvedUrl: string,
  uploader: string,
  platform: string,
  filterHint?: SearchFilterType
): MediaFormatMode {
  if (
    obj.mediaType === 'audio' ||
    obj.type === 'audio' ||
    obj.kind === 'song' ||
    obj.isAudioOnly === true ||
    obj.isLiveRadio === true
  ) {
    return 'audio';
  }
  if (obj.mediaType === 'video' || obj.type === 'video' || obj.kind === 'video') {
    return 'video';
  }
  if (filterHint === 'radio' || typeof obj.stationuuid === 'string') {
    return 'audio';
  }

  const lowerUrl = resolvedUrl.toLowerCase();
  const lowerPlatform = platform.toLowerCase();
  const lowerUploader = uploader.toLowerCase();

  if (
    lowerUrl.includes('music.youtube.com') ||
    lowerUrl.includes('soundcloud.com') ||
    lowerUrl.includes('bandcamp.com') ||
    lowerUrl.includes('itunes.apple.com') ||
    lowerUrl.includes('podcasts.apple.com') ||
    lowerUrl.endsWith('.mp3') ||
    lowerUrl.endsWith('.m4a') ||
    lowerUrl.endsWith('.ogg') ||
    lowerUrl.endsWith('.aac') ||
    lowerPlatform.includes('yt music') ||
    lowerPlatform.includes('youtube music') ||
    lowerPlatform.includes('itunes') ||
    lowerPlatform.includes('soundcloud') ||
    lowerPlatform.includes('radio') ||
    lowerPlatform.includes('podcast') ||
    lowerUploader.endsWith(' - topic')
  ) {
    return 'audio';
  }
  return 'video';
}

export function normalizeMediaItem(
  raw: unknown,
  fallbackUrl = '',
  filterHint?: SearchFilterType
): MediaItem | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  let resolvedUrl =
    (typeof obj.url === 'string' && obj.url) ||
    (typeof obj.webpage_url === 'string' && obj.webpage_url) ||
    (typeof obj.original_url === 'string' && obj.original_url) ||
    (typeof obj.url_resolved === 'string' && obj.url_resolved) ||
    (typeof obj.link === 'string' && obj.link) ||
    (typeof obj.id === 'string' && obj.id.startsWith('http') ? obj.id : '') ||
    fallbackUrl;

  if (resolvedUrl.startsWith('/watch?')) {
    resolvedUrl = `https://www.youtube.com${resolvedUrl}`;
  }

  const title =
    (typeof obj.title === 'string' && obj.title.trim()) ||
    (typeof obj.name === 'string' && obj.name.trim()) ||
    'Untitled Media';

  if (!resolvedUrl && title === 'Untitled Media') {
    return null;
  }

  const uploader =
    (typeof obj.uploader === 'string' && obj.uploader.trim()) ||
    (typeof obj.uploaderName === 'string' && obj.uploaderName.trim()) ||
    (typeof obj.author === 'string' && obj.author.trim()) ||
    (typeof obj.channel === 'string' && obj.channel.trim()) ||
    (typeof obj.artist === 'string' && obj.artist.trim()) ||
    (typeof obj.country === 'string' && obj.country.trim()) ||
    'Unknown Uploader';

  const thumbnail =
    (typeof obj.thumbnail === 'string' && obj.thumbnail) ||
    (typeof obj.thumb === 'string' && obj.thumb) ||
    (typeof obj.favicon === 'string' && obj.favicon) ||
    (typeof obj.image === 'string' && obj.image) ||
    (Array.isArray(obj.thumbnails) &&
    obj.thumbnails.length > 0 &&
    typeof (obj.thumbnails[obj.thumbnails.length - 1] as Record<string, unknown>)?.url === 'string'
      ? String((obj.thumbnails[obj.thumbnails.length - 1] as Record<string, unknown>).url)
      : '') ||
    '';

  const duration = parseDurationValue(obj.duration ?? obj.lengthSeconds ?? obj.durationSeconds);

  const idSource =
    (typeof obj.id === 'string' && obj.id) ||
    (typeof obj.stationuuid === 'string' && obj.stationuuid) ||
    (typeof obj.videoId === 'string' && obj.videoId) ||
    resolvedUrl ||
    `${title}-${uploader}`;

  const platform =
    (typeof obj.platform === 'string' && obj.platform) ||
    (typeof obj.extractor === 'string' && obj.extractor) ||
    (filterHint === 'radio' ? 'Radio' : detectPlatform(resolvedUrl));

  const directStreamUrl =
    (typeof obj.directStreamUrl === 'string' && obj.directStreamUrl) ||
    (typeof obj.url_resolved === 'string' && obj.url_resolved) ||
    undefined;

  const isLiveRadio =
    obj.isLiveRadio === true ||
    filterHint === 'radio' ||
    typeof obj.stationuuid === 'string';

  const mediaType = inferMediaTypeFromRaw(obj, resolvedUrl, uploader, platform, filterHint);

  return {
    id: idSource,
    url: resolvedUrl,
    title,
    uploader,
    duration,
    thumbnail,
    platform,
    mediaType,
    isLiveRadio,
    directStreamUrl,
  };
}

export function normalizeSearchResults(
  payload: unknown,
  filterHint?: SearchFilterType
): MediaItem[] {
  let list: unknown[] = [];
  if (Array.isArray(payload)) {
    list = payload;
  } else if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.results)) {
      list = obj.results;
    } else if (Array.isArray(obj.items)) {
      list = obj.items;
    } else if (Array.isArray(obj.data)) {
      list = obj.data;
    } else if (Array.isArray(obj.entries)) {
      list = obj.entries;
    } else if (Array.isArray(obj.related)) {
      list = obj.related;
    }
  }

  return list
    .map((entry) => normalizeMediaItem(entry, '', filterHint))
    .filter((item): item is MediaItem => item !== null);
}

export function applyStrictSearchFilter(
  items: readonly MediaItem[],
  filter: SearchFilterType
): MediaItem[] {
  if (filter === 'audio') {
    return items.filter((item) => item.mediaType === 'audio');
  }
  if (filter === 'videos') {
    return items.filter((item) => item.mediaType === 'video');
  }
  if (filter === 'podcasts') {
    return items.filter(
      (item) =>
        item.mediaType === 'audio' ||
        (item.platform ?? '').toLowerCase().includes('podcast')
    );
  }
  if (filter === 'radio') {
    return items.filter((item) => item.isLiveRadio === true || item.mediaType === 'audio');
  }
  return [...items];
}

export function buildStreamUrl(
  backendUrl: string,
  targetUrl: string,
  mode: MediaFormatMode,
  quality: string
): string {
  const base = normalizeBackendUrl(backendUrl) || DEFAULT_BACKEND_URL;
  return `${base}/api/stream?url=${encodeURIComponent(targetUrl)}&mode=${encodeURIComponent(mode)}&quality=${encodeURIComponent(quality)}`;
}

export function buildRelatedUrl(
  backendUrl: string,
  params: { id: string; title: string; uploader: string; historyArtists?: readonly string[] }
): string {
  const base = normalizeBackendUrl(backendUrl) || DEFAULT_BACKEND_URL;
  let url = `${base}/api/related?id=${encodeURIComponent(params.id)}&title=${encodeURIComponent(params.title)}&uploader=${encodeURIComponent(params.uploader)}`;
  const artists = (params.historyArtists ?? [])
    .map((a) => a.trim())
    .filter(Boolean);
  if (artists.length > 0) {
    url += `&historyArtists=${encodeURIComponent(artists.join(','))}`;
  }
  return url;
}

async function parseErrorMessage(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as Record<string, unknown>;
    if (typeof data.error === 'string' && data.error) {
      return data.error;
    }
    if (typeof data.message === 'string' && data.message) {
      return data.message;
    }
  } catch {
    // Ignore non-JSON error body
  }
  return `Server responded with HTTP ${response.status}`;
}

export interface PingResult {
  online: boolean;
  latencyMs: number;
  serverName?: string;
  error?: string;
}

export async function pingServer(backendUrl: string): Promise<PingResult> {
  const base = normalizeBackendUrl(backendUrl);
  if (!base) {
    return {
      online: false,
      latencyMs: 0,
      error: 'Enter a valid server URL first.',
    };
  }

  const startedAt = performance.now();
  try {
    const response = await fetch(`${base}/api/ping`, {
      method: 'GET',
      cache: 'no-store',
    });
    const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
    if (!response.ok) {
      const msg = await parseErrorMessage(response);
      return { online: false, latencyMs, error: msg };
    }
    let serverName: string | undefined;
    try {
      const json = (await response.json()) as Record<string, unknown>;
      if (typeof json.server === 'string') {
        serverName = json.server;
      }
    } catch {
      // Plain text ping response is fine
    }
    return { online: true, latencyMs, serverName };
  } catch (err) {
    const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
    return {
      online: false,
      latencyMs,
      error: err instanceof Error ? err.message : 'Network error reaching server.',
    };
  }
}

export async function fetchMediaInfo(backendUrl: string, targetUrl: string): Promise<MediaItem> {
  const base = normalizeBackendUrl(backendUrl) || DEFAULT_BACKEND_URL;
  const response = await fetch(`${base}/api/info?url=${encodeURIComponent(targetUrl)}`);
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }
  const payload = await response.json();
  const normalized = normalizeMediaItem(payload, targetUrl);
  if (!normalized) {
    throw new Error('Could not resolve media metadata for this link.');
  }
  return normalized;
}

export async function searchRadioStations(
  query: string,
  fetchImpl: typeof fetch = fetch
): Promise<MediaItem[]> {
  try {
    const response = await fetchImpl(
      `https://de1.api.radio-browser.info/json/stations/search?name=${encodeURIComponent(query)}&hidebroken=true&limit=20`
    );
    if (!response.ok) {
      return [];
    }
    const stations = (await response.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(stations)) {
      return [];
    }
    return stations
      .filter((st) => typeof st.url_resolved === 'string' && st.url_resolved.length > 0)
      .map((st) => ({
        id: String(st.stationuuid || st.url_resolved),
        url: String(st.url_resolved),
        directStreamUrl: String(st.url_resolved),
        isLiveRadio: true,
        mediaType: 'audio' as const,
        title: String(st.name || 'Live Radio Station').trim(),
        uploader: String(st.country || st.tags || 'Live Radio').trim(),
        duration: 0,
        thumbnail: typeof st.favicon === 'string' ? st.favicon : '',
        platform: 'Radio',
      }));
  } catch {
    return [];
  }
}

export async function searchPipedMusicSongs(
  query: string,
  fetchImpl: typeof fetch = fetch
): Promise<MediaItem[]> {
  const pipedHosts = ['https://pipedapi.kavin.rocks', 'https://api.piped.private.coffee'];
  for (const host of pipedHosts) {
    try {
      const resp = await fetchImpl(
        `${host}/search?q=${encodeURIComponent(query)}&filter=music_songs`
      );
      if (!resp.ok) {
        continue;
      }
      const data = (await resp.json()) as { items?: Array<Record<string, unknown>> };
      if (!Array.isArray(data.items) || data.items.length === 0) {
        continue;
      }
      const items = data.items
        .map((entry) =>
          normalizeMediaItem(
            {
              ...entry,
              mediaType: 'audio',
              platform: 'YT Music',
            },
            '',
            'audio'
          )
        )
        .filter((item): item is MediaItem => item !== null && Boolean(item.url));
      if (items.length > 0) {
        return items;
      }
    } catch {
      // Try next Piped host
    }
  }
  return [];
}

function normalizeDedupeField(value: string): string {
  const stripped = value
    .toLowerCase()
    .replace(/\s*(?:\([^)]*\)|\[[^\]]*\])\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped || value.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function dedupeMediaItems(items: readonly MediaItem[]): MediaItem[] {
  const seenIds = new Set<string>();
  const seenTitleUploader = new Set<string>();
  const unique: MediaItem[] = [];

  for (const item of items) {
    const idKey = item.id.trim().toLowerCase();
    const normTitle = normalizeDedupeField(item.title);
    const normUploader = normalizeDedupeField(item.uploader)
      .replace(/\s*-\s*topic$/, '')
      .trim();
    const compositeKey = `${normTitle}::${normUploader}`;

    if (idKey && seenIds.has(idKey)) {
      continue;
    }
    if (normTitle && seenTitleUploader.has(compositeKey)) {
      continue;
    }

    if (idKey) {
      seenIds.add(idKey);
    }
    if (normTitle) {
      seenTitleUploader.add(compositeKey);
    }
    unique.push(item);
  }

  return unique;
}

export async function searchMedia(
  backendUrl: string,
  query: string,
  filter: SearchFilterType = 'all',
  fetchImpl: typeof fetch = fetch
): Promise<MediaItem[]> {
  const base = normalizeBackendUrl(backendUrl) || DEFAULT_BACKEND_URL;

  try {
    const response = await fetchImpl(
      `${base}/api/search?q=${encodeURIComponent(query)}&filter=${encodeURIComponent(filter)}`
    );
    if (!response.ok) {
      if (filter === 'radio') {
        return dedupeMediaItems(await searchRadioStations(query, fetchImpl));
      }
      if (filter === 'audio') {
        const audioFallback = await searchPipedMusicSongs(query, fetchImpl);
        if (audioFallback.length > 0) {
          return dedupeMediaItems(audioFallback);
        }
      }
      throw new Error(await parseErrorMessage(response));
    }
    const payload = await response.json();
    const normalized = normalizeSearchResults(payload, filter);
    const strictResults = dedupeMediaItems(applyStrictSearchFilter(normalized, filter));

    if (strictResults.length === 0 && filter === 'radio') {
      return dedupeMediaItems(await searchRadioStations(query, fetchImpl));
    }
    if (strictResults.length === 0 && filter === 'audio') {
      const musicSongs = await searchPipedMusicSongs(query, fetchImpl);
      if (musicSongs.length > 0) {
        return dedupeMediaItems(musicSongs);
      }
    }
    return strictResults;
  } catch (err) {
    if (filter === 'radio') {
      const radioResults = await searchRadioStations(query, fetchImpl);
      if (radioResults.length > 0) {
        return dedupeMediaItems(radioResults);
      }
    }
    if (filter === 'audio') {
      const musicSongs = await searchPipedMusicSongs(query, fetchImpl);
      if (musicSongs.length > 0) {
        return dedupeMediaItems(musicSongs);
      }
    }
    throw err;
  }
}

export async function fetchSearchSuggestions(
  backendUrl: string,
  query: string,
  fetchImpl: typeof fetch = fetch
): Promise<string[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }
  const base = normalizeBackendUrl(backendUrl) || DEFAULT_BACKEND_URL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetchImpl(
      `${base}/api/suggestions?q=${encodeURIComponent(trimmed)}`,
      { signal: controller.signal }
    );
    if (!response.ok) {
      return [];
    }
    const payload = await response.json();
    let list: unknown[] = [];
    if (Array.isArray(payload)) {
      list = payload;
    } else if (payload && typeof payload === 'object') {
      const obj = payload as Record<string, unknown>;
      if (Array.isArray(obj.suggestions)) {
        list = obj.suggestions;
      } else if (Array.isArray(obj.results)) {
        list = obj.results;
      } else if (Array.isArray(obj.items)) {
        list = obj.items;
      }
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of list) {
      const text =
        typeof entry === 'string'
          ? entry.trim()
          : entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).query === 'string'
            ? String((entry as Record<string, unknown>).query).trim()
            : '';
      if (text && !seen.has(text.toLowerCase())) {
        seen.add(text.toLowerCase());
        out.push(text);
      }
    }
    return out.slice(0, 8);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function searchMediaSmart(
  backendUrl: string,
  query: string,
  filter: SearchFilterType = 'all',
  options?: {
    fetchImpl?: typeof fetch;
    localCandidates?: readonly string[];
  }
): Promise<{ items: MediaItem[]; correctedQuery: string | null }> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const items = await searchMedia(backendUrl, query, filter, fetchImpl);
  if (items.length > 0) {
    return { items, correctedQuery: null };
  }

  // Typo recovery: query suggestions and local fuzzy candidates
  const remoteSuggestions = await fetchSearchSuggestions(backendUrl, query, fetchImpl);
  const candidate =
    remoteSuggestions.find(
      (s) => s.toLowerCase() !== query.trim().toLowerCase()
    ) ??
    options?.localCandidates?.find(
      (s) => s.toLowerCase() !== query.trim().toLowerCase()
    );

  if (!candidate) {
    return { items: [], correctedQuery: null };
  }

  const correctedItems = await searchMedia(backendUrl, candidate, filter, fetchImpl);
  if (correctedItems.length > 0) {
    return { items: correctedItems, correctedQuery: candidate };
  }
  return { items: [], correctedQuery: null };
}

export async function resolveStream(
  backendUrl: string,
  targetUrl: string,
  mode: MediaFormatMode,
  quality: string,
  options?: { timeoutMs?: number; fetchImpl?: typeof fetch; signal?: AbortSignal }
): Promise<{ directUrl: string; fallbackUrl: string; resolved: boolean }> {
  const base = normalizeBackendUrl(backendUrl) || DEFAULT_BACKEND_URL;
  const fallbackUrl = buildStreamUrl(base, targetUrl, mode, quality);
  const timeoutMs = options?.timeoutMs ?? RESOLVE_STREAM_TIMEOUT_MS;
  const fetchImpl = options?.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  options?.signal?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    const response = await fetchImpl(
      `${base}/api/resolve-stream?url=${encodeURIComponent(targetUrl)}&mode=${encodeURIComponent(mode)}&quality=${encodeURIComponent(quality)}`,
      { signal: controller.signal }
    );
    if (!response.ok) {
      return { directUrl: fallbackUrl, fallbackUrl, resolved: false };
    }
    const payload = (await response.json()) as Record<string, unknown>;
    const directUrl =
      (typeof payload.directUrl === 'string' && payload.directUrl) ||
      (typeof payload.url === 'string' && payload.url) ||
      (typeof payload.streamUrl === 'string' && payload.streamUrl) ||
      '';
    if (!directUrl) {
      return { directUrl: fallbackUrl, fallbackUrl, resolved: false };
    }
    return { directUrl, fallbackUrl, resolved: true };
  } catch {
    return { directUrl: fallbackUrl, fallbackUrl, resolved: false };
  } finally {
    clearTimeout(timer);
    options?.signal?.removeEventListener('abort', onExternalAbort);
  }
}

export async function fetchRelatedMedia(
  backendUrl: string,
  track: { id: string; title: string; uploader: string; historyArtists?: readonly string[] },
  fetchImpl: typeof fetch = fetch
): Promise<MediaItem[]> {
  const base = normalizeBackendUrl(backendUrl) || DEFAULT_BACKEND_URL;
  const url = buildRelatedUrl(base, track);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      if (!response.ok) {
        return [];
      }
      const payload = await response.json();
      return normalizeSearchResults(payload);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return [];
  }
}
