import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type { MediaFormatMode, MediaItem, VideoQuality } from '../types/media';
import { extractYouTubeVideoId } from './youtube';

interface Client {
  ua: string;
  cn: string;
  cv: string;
  host: string;
  body: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

const BASE_CLIENTS: Client[] = [
  {
    ua: 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    cn: '28',
    cv: '1.65.10',
    host: 'https://www.youtube.com',
    body: {
      clientName: 'ANDROID_VR',
      clientVersion: '1.65.10',
      deviceMake: 'Oculus',
      deviceModel: 'Quest 3',
      androidSdkVersion: 32,
      osName: 'Android',
      osVersion: '12L',
      hl: 'en',
      gl: 'US',
    },
  },
  {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
    cn: '101',
    cv: '1.02',
    host: 'https://www.youtube.com',
    body: {
      clientName: 'VISIONOS',
      clientVersion: '1.02',
      deviceMake: 'Apple',
      deviceModel: 'RealityDevice17,1',
      osName: 'visionOS',
      osVersion: '26.5.23O471',
      hl: 'en',
      gl: 'US',
    },
  },
  {
    ua: 'com.google.ios.youtube/20.11.6 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    cn: '5',
    cv: '20.11.6',
    host: 'https://www.youtube.com',
    body: {
      clientName: 'IOS',
      clientVersion: '20.11.6',
      deviceMake: 'Apple',
      deviceModel: 'iPhone16,2',
      osName: 'iPhone',
      osVersion: '18.3.2.22D82',
      hl: 'en',
      gl: 'US',
    },
  },
  {
    ua: 'Mozilla/5.0 (PlayStation; PlayStation 5/2.26) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0 Safari/605.1.15',
    cn: '85',
    cv: '2.0',
    host: 'https://www.youtube.com',
    body: {
      clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
      clientVersion: '2.0',
      hl: 'en',
      gl: 'US',
    },
    extra: { thirdParty: { embedUrl: 'https://www.youtube.com' } },
  },
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    cn: '56',
    cv: '1.20241009.01.00',
    host: 'https://www.youtube.com',
    body: {
      clientName: 'WEB_EMBEDDED_PLAYER',
      clientVersion: '1.20241009.01.00',
      hl: 'en',
      gl: 'US',
    },
    extra: { thirdParty: { embedUrl: 'https://www.youtube.com' } },
  },
  {
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1',
    cn: '67',
    cv: '1.20241009.01.00',
    host: 'https://music.youtube.com',
    body: {
      clientName: 'WEB_REMIX',
      clientVersion: '1.20241009.01.00',
      hl: 'en',
      gl: 'US',
    },
  },
];

const MUSIC_SEARCH_CLIENT: Client = BASE_CLIENTS[5];

// Base64 of the YouTube Music "Songs" filter chip
const MUSIC_SONGS_PARAMS = 'EgWKAQIIAWoKEAkQBRAKEAMQBA==';

const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://api.piped.private.coffee',
  'https://pipedapi.adminforge.de',
];

const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://yewtu.be',
];

const EXPIRY_SAFETY_MS = 60_000;
const EXPIRY_MAX_MS = 4 * 60 * 60 * 1000;
const EXPIRY_DEFAULT_MS = 15 * 60 * 1000;

let cachedVisitorData: string | null = null;

export interface ResolvedYouTubeStream {
  url: string;
  mime: string;
  audioUrl?: string;
  audioMime?: string;
  isHls?: boolean;
  height?: number;
}

export function isDirectYouTubeSupported(): boolean {
  return Capacitor.isNativePlatform();
}

export function computeStreamExpiry(streamUrl: string): number {
  const now = Date.now();
  try {
    const expire = Number(new URL(streamUrl).searchParams.get('expire'));
    if (Number.isFinite(expire) && expire > 0) {
      const at = expire * 1000 - EXPIRY_SAFETY_MS;
      if (at > now + 30_000) {
        return Math.min(at, now + EXPIRY_MAX_MS);
      }
    }
  } catch {
    // Non-standard URL
  }
  return now + EXPIRY_DEFAULT_MS;
}

type RawFormat = Record<string, unknown>;

const mimeOf = (f: RawFormat) => (typeof f.mimeType === 'string' ? f.mimeType : typeof f.type === 'string' ? f.type : '');
const urlOf = (f: RawFormat) => (typeof f.url === 'string' ? f.url : '');
const heightOf = (f: RawFormat) => Number(f.height ?? 0) || Number(String(f.qualityLabel ?? '').replace(/\D/g, '')) || 0;
const bitrateOf = (f: RawFormat) => Number(f.bitrate ?? f.averageBitrate ?? 0) || 0;

function cleanMime(f: RawFormat, fallback: string): string {
  return mimeOf(f).split(';')[0].trim() || fallback;
}

function parseDurationText(text: string | undefined): number {
  if (!text) return 0;
  const parts = String(text).split(':').map((p) => parseInt(p, 10));
  if (parts.some((p) => Number.isNaN(p))) return 0;
  return parts.reduce((acc, part) => acc * 60 + part, 0);
}

async function fetchJson(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  timeoutMs = 5000
): Promise<Record<string, unknown> | null> {
  try {
    const resp = await CapacitorHttp.request({
      url,
      method: init.method ?? 'GET',
      headers: { Accept: 'application/json', ...(init.headers ?? {}) },
      data: init.body ? JSON.parse(init.body) : undefined,
      connectTimeout: timeoutMs,
      readTimeout: timeoutMs,
    });
    if (resp.status < 200 || resp.status >= 300 || !resp.data) {
      return null;
    }
    return typeof resp.data === 'string'
      ? (JSON.parse(resp.data) as Record<string, unknown>)
      : (resp.data as Record<string, unknown>);
  } catch {
    return null;
  }
}

async function postInnertube(
  path: string,
  client: Client,
  payload: Record<string, unknown>,
  timeoutMs: number
): Promise<Record<string, unknown> | null> {
  const clientBody: Record<string, unknown> = { ...client.body };
  if (cachedVisitorData) {
    clientBody.visitorData = cachedVisitorData;
  }
  return fetchJson(
    `${client.host}${path}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': client.ua,
        'X-YouTube-Client-Name': client.cn,
        'X-YouTube-Client-Version': client.cv,
        Origin: client.host,
      },
      body: JSON.stringify({
        ...payload,
        ...(client.extra ?? {}),
        context: { client: clientBody },
      }),
    },
    timeoutMs
  );
}

/** Grab a visitor id once; some clients reject requests without one. */
async function ensureVisitorData(): Promise<void> {
  if (cachedVisitorData) return;
  const json = await fetchJson('https://www.youtube.com/sw.js_data', {}, 4000);
  try {
    const rows = json as unknown as unknown[][];
    if (Array.isArray(rows) && Array.isArray(rows[0])) {
      for (const row of rows[0] as unknown[]) {
        if (Array.isArray(row) && typeof row[1] === 'string' && row[1].length > 20) {
          cachedVisitorData = row[1];
          return;
        }
      }
    }
  } catch {
    // Visitor data is optional
  }
}

/* ------------------------------- SEARCH ---------------------------------- */

export async function searchYouTubeDirect(
  query: string,
  musicOnly: boolean,
  limit = 24
): Promise<MediaItem[]> {
  if (!isDirectYouTubeSupported()) return [];

  if (musicOnly) {
    const viaMusic = await searchYouTubeMusic(query, limit);
    if (viaMusic.length > 0) return viaMusic;
    return searchPipedMusic(query, limit);
  }

  await ensureVisitorData();
  const items = await searchInnertube(query, limit);
  if (items.length > 0) return items;
  return searchPipedVideos(query, limit);
}

async function searchYouTubeMusic(query: string, limit: number): Promise<MediaItem[]> {
  const json = await postInnertube(
    '/youtubei/v1/search?prettyPrint=false',
    MUSIC_SEARCH_CLIENT,
    { query, params: MUSIC_SONGS_PARAMS },
    7000
  );
  if (!json?.contents) return [];
  return extractRenderers(json.contents, limit, true);
}

async function searchInnertube(query: string, limit: number): Promise<MediaItem[]> {
  const json = await postInnertube(
    '/youtubei/v1/search?prettyPrint=false',
    BASE_CLIENTS[4],
    { query },
    7000
  );
  if (!json?.contents) return [];
  return extractRenderers(json.contents, limit, false);
}

function extractRenderers(contents: unknown, limit: number, music: boolean): MediaItem[] {
  const renderers: Array<Record<string, unknown>> = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (
        (key === 'videoRenderer' ||
          key === 'playlistVideoRenderer' ||
          key === 'musicResponsiveListItemRenderer' ||
          key === 'musicTwoRowItemRenderer') &&
        value
      ) {
        renderers.push(value as Record<string, unknown>);
      } else {
        walk(value);
      }
    }
  };
  walk(contents);

  const seen = new Set<string>();
  const items: MediaItem[] = [];

  for (const r of renderers) {
    const videoId = extractRendererVideoId(r);
    if (!videoId || seen.has(videoId)) continue;

    const title = extractRendererTitle(r);
    if (!title) continue;

    const uploader = extractRendererByline(r);
    const thumbnail = extractRendererThumb(r);

    seen.add(videoId);
    items.push({
      id: `yt_${videoId}`,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      title: title.trim(),
      uploader: uploader.trim() || (music ? 'YouTube Music' : 'YouTube'),
      duration: extractRendererDuration(r),
      thumbnail,
      platform: music ? 'YT Music' : 'YouTube',
      mediaType: music ? 'audio' : 'video',
      isLiveRadio: false,
    });

    if (items.length >= limit) break;
  }

  return items;
}

function extractRendererVideoId(r: Record<string, unknown>): string {
  if (typeof r.videoId === 'string') return r.videoId;
  const endpoint = r.navigationEndpoint as Record<string, unknown> | undefined;
  const watch = endpoint?.watchEndpoint as Record<string, unknown> | undefined;
  if (typeof watch?.videoId === 'string') return watch.videoId;
  const overlay = JSON.stringify(r);
  const m = /"videoId":"([a-zA-Z0-9_-]{11})"/.exec(overlay);
  return m ? m[1] : '';
}

function firstText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const obj = node as Record<string, unknown>;
  if (typeof obj.simpleText === 'string') return obj.simpleText;
  const runs = obj.runs;
  if (Array.isArray(runs) && runs.length > 0) {
    return String((runs[0] as Record<string, unknown>)?.text ?? '');
  }
  return '';
}

function extractRendererTitle(r: Record<string, unknown>): string {
  const direct = firstText(r.title);
  if (direct) return direct;
  const flex = r.flexColumns;
  if (Array.isArray(flex) && flex.length > 0) {
    const col = flex[0] as Record<string, unknown>;
    const text = col?.musicResponsiveListItemFlexColumnRenderer as Record<string, unknown> | undefined;
    return firstText(text?.text);
  }
  return '';
}

function extractRendererByline(r: Record<string, unknown>): string {
  const byline = firstText(r.ownerText ?? r.longBylineText ?? r.shortBylineText);
  if (byline) return byline;
  const flex = r.flexColumns;
  if (Array.isArray(flex) && flex.length > 1) {
    const col = flex[1] as Record<string, unknown>;
    const text = col?.musicResponsiveListItemFlexColumnRenderer as Record<string, unknown> | undefined;
    const runs = (text?.text as Record<string, unknown> | undefined)?.runs;
    if (Array.isArray(runs)) {
      const names = runs
        .map((run) => String((run as Record<string, unknown>)?.text ?? ''))
        .filter((t) => t && !/^\d+:\d+$/.test(t) && t !== '•');
      return names[0] ?? '';
    }
  }
  return '';
}

function extractRendererThumb(r: Record<string, unknown>): string {
  const thumbs =
    (r.thumbnail as { thumbnails?: Array<{ url?: string }> } | undefined)?.thumbnails ??
    ((r.thumbnailRenderer as Record<string, unknown> | undefined)?.musicThumbnailRenderer as
      | { thumbnail?: { thumbnails?: Array<{ url?: string }> } }
      | undefined)?.thumbnail?.thumbnails;
  if (Array.isArray(thumbs) && thumbs.length > 0) {
    return String(thumbs[thumbs.length - 1]?.url ?? '');
  }
  return '';
}

function extractRendererDuration(r: Record<string, unknown>): number {
  const direct = (r.lengthText as { simpleText?: string } | undefined)?.simpleText;
  if (direct) return parseDurationText(direct);
  const flex = r.flexColumns;
  if (Array.isArray(flex) && flex.length > 1) {
    const col = flex[1] as Record<string, unknown>;
    const text = col?.musicResponsiveListItemFlexColumnRenderer as Record<string, unknown> | undefined;
    const runs = (text?.text as Record<string, unknown> | undefined)?.runs;
    if (Array.isArray(runs)) {
      for (const run of runs) {
        const t = String((run as Record<string, unknown>)?.text ?? '');
        if (/^\d+:\d+$/.test(t)) return parseDurationText(t);
      }
    }
  }
  return 0;
}

async function searchPipedMusic(query: string, limit: number): Promise<MediaItem[]> {
  for (const host of PIPED_INSTANCES) {
    const json = await fetchJson(
      `${host}/search?q=${encodeURIComponent(query)}&filter=music_songs`,
      {},
      6000
    );
    const list = Array.isArray(json?.items) ? (json.items as Array<Record<string, unknown>>) : [];
    if (list.length === 0) continue;
    return list
      .map((entry) => {
        const id = extractYouTubeVideoId(String(entry.url ?? ''));
        if (!id || !entry.title) return null;
        return {
          id: `yt_${id}`,
          url: `https://www.youtube.com/watch?v=${id}`,
          title: String(entry.title).trim(),
          uploader: String(entry.uploaderName ?? 'YouTube Music').trim(),
          duration: Number(entry.duration) || 0,
          thumbnail: String(entry.thumbnail ?? ''),
          platform: 'YT Music',
          mediaType: 'audio' as const,
          isLiveRadio: false,
        };
      })
      .filter((x): x is MediaItem => x !== null)
      .slice(0, limit);
  }
  return [];
}

async function searchPipedVideos(query: string, limit: number): Promise<MediaItem[]> {
  for (const host of PIPED_INSTANCES) {
    const json = await fetchJson(`${host}/search?q=${encodeURIComponent(query)}&filter=videos`, {}, 6000);
    const list = Array.isArray(json?.items) ? (json.items as Array<Record<string, unknown>>) : [];
    if (list.length === 0) continue;
    return list
      .map((entry) => {
        const id = extractYouTubeVideoId(String(entry.url ?? ''));
        if (!id || !entry.title) return null;
        return {
          id: `yt_${id}`,
          url: `https://www.youtube.com/watch?v=${id}`,
          title: String(entry.title).trim(),
          uploader: String(entry.uploaderName ?? 'YouTube').trim(),
          duration: Number(entry.duration) || 0,
          thumbnail: String(entry.thumbnail ?? ''),
          platform: 'YouTube',
          mediaType: 'video' as const,
          isLiveRadio: false,
        };
      })
      .filter((x): x is MediaItem => x !== null)
      .slice(0, limit);
  }
  return [];
}

/* ------------------------------ RESOLUTION -------------------------------- */

function pickFromFormats(
  formats: RawFormat[],
  adaptive: RawFormat[],
  hls: string | null,
  mode: MediaFormatMode,
  quality: VideoQuality
): ResolvedYouTubeStream | null {
  const playable = (f: RawFormat) => urlOf(f).length > 0;

  if (mode === 'audio') {
    const audio = [...adaptive, ...formats].filter(
      (f) => playable(f) && mimeOf(f).startsWith('audio/')
    );
    const mp4 = audio.filter((f) => mimeOf(f).toLowerCase().includes('audio/mp4'));
    const pool = mp4.length > 0 ? mp4 : audio;
    if (pool.length === 0) {
      return hls ? { url: hls, mime: 'application/x-mpegURL', isHls: true } : null;
    }
    const sorted = [...pool].sort((a, b) => bitrateOf(b) - bitrateOf(a));
    return { url: urlOf(sorted[0]), mime: cleanMime(sorted[0], 'audio/mp4') };
  }

  const desired = Number.parseInt(String(quality), 10) || 720;

  const progressive = formats.filter(
    (f) => playable(f) && mimeOf(f).includes('video/mp4')
  );
  if (progressive.length > 0) {
    const sorted = [...progressive].sort((a, b) => heightOf(b) - heightOf(a));
    const chosen =
      sorted.find((f) => heightOf(f) === desired) ??
      sorted.find((f) => heightOf(f) > 0 && heightOf(f) <= desired) ??
      sorted[sorted.length - 1];
    return { url: urlOf(chosen), mime: cleanMime(chosen, 'video/mp4'), height: heightOf(chosen) };
  }

  if (hls) return { url: hls, mime: 'application/x-mpegURL', isHls: true };

  const video = adaptive.filter((f) => playable(f) && mimeOf(f).startsWith('video/mp4'));
  if (video.length === 0) return null;

  const capped = video.filter((f) => heightOf(f) > 0 && heightOf(f) <= desired);
  const sorted = [...(capped.length > 0 ? capped : video)].sort(
    (a, b) => heightOf(b) - heightOf(a) || bitrateOf(b) - bitrateOf(a)
  );
  const chosen = sorted[0];

  const audio = [...adaptive, ...formats].filter(
    (f) => playable(f) && mimeOf(f).startsWith('audio/')
  );
  const audioMp4 = audio.filter((f) => mimeOf(f).toLowerCase().includes('audio/mp4'));
  const audioPool = audioMp4.length > 0 ? audioMp4 : audio;
  const bestAudio = [...audioPool].sort((a, b) => bitrateOf(b) - bitrateOf(a))[0];

  const result: ResolvedYouTubeStream = {
    url: urlOf(chosen),
    mime: cleanMime(chosen, 'video/mp4'),
    height: heightOf(chosen),
  };
  if (bestAudio) {
    result.audioUrl = urlOf(bestAudio);
    result.audioMime = cleanMime(bestAudio, 'audio/mp4');
  }
  return result;
}

async function resolveViaInnertube(
  videoId: string,
  mode: MediaFormatMode,
  quality: VideoQuality
): Promise<ResolvedYouTubeStream | null> {
  await ensureVisitorData();

  const attempt = async (client: Client) => {
    const json = await postInnertube(
      '/youtubei/v1/player?prettyPrint=false',
      client,
      { videoId, contentCheckOk: true, racyCheckOk: true },
      4500
    );
    if (!json) return null;

    const playability = json.playabilityStatus as Record<string, unknown> | undefined;
    if (playability?.status && playability.status !== 'OK') return null;

    const streamingData = json.streamingData as Record<string, unknown> | undefined;
    if (!streamingData) return null;

    const formats = Array.isArray(streamingData.formats)
      ? (streamingData.formats as RawFormat[])
      : [];
    const adaptive = Array.isArray(streamingData.adaptiveFormats)
      ? (streamingData.adaptiveFormats as RawFormat[])
      : [];
    const hls =
      typeof streamingData.hlsManifestUrl === 'string' ? streamingData.hlsManifestUrl : null;

    return pickFromFormats(formats, adaptive, hls, mode, quality);
  };

  const results = await Promise.allSettled(BASE_CLIENTS.map(attempt));
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      return result.value;
    }
  }
  return null;
}

async function resolveViaPiped(
  videoId: string,
  mode: MediaFormatMode,
  quality: Quality
): Promise<ResolvedYouTubeStream | null> {
  for (const host of PIPED_INSTANCES) {
    const json = await fetchJson(`${host}/streams/${videoId}`, {}, 6000);
    if (!json) continue;

    const audioStreams = Array.isArray(json.audioStreams)
      ? (json.audioStreams as RawFormat[])
      : [];
    const videoStreams = Array.isArray(json.videoStreams)
      ? (json.videoStreams as RawFormat[])
      : [];

    if (mode === 'audio') {
      const pool = audioStreams.filter((f) => urlOf(f).length > 0);
      if (pool.length === 0) continue;
      const sorted = [...pool].sort((a, b) => bitrateOf(b) - bitrateOf(a));
      return { url: urlOf(sorted[0]), mime: cleanMime(sorted[0], 'audio/mp4') };
    }

    const desired = Number.parseInt(String(quality), 10) || 720;
    const muxed = videoStreams.filter(
      (f) => urlOf(f).length > 0 && f.videoOnly === false && mimeOf(f).includes('mp4')
    );
    if (muxed.length > 0) {
      const sorted = [...muxed].sort((a, b) => heightOf(b) - heightOf(a));
      const chosen =
        sorted.find((f) => heightOf(f) === desired) ??
        sorted.find((f) => heightOf(f) > 0 && heightOf(f) <= desired) ??
        sorted[sorted.length - 1];
      return { url: urlOf(chosen), mime: 'video/mp4', height: heightOf(chosen) };
    }

    const adaptive = videoStreams.filter(
      (f) => urlOf(f).length > 0 && mimeOf(f).includes('mp4')
    );
    if (adaptive.length > 0) {
      const sorted = [...adaptive].sort((a, b) => heightOf(b) - heightOf(a));
      const chosen = sorted.find((f) => heightOf(f) <= desired) ?? sorted[0];
      const bestAudio = [...audioStreams]
        .filter((f) => urlOf(f).length > 0)
        .sort((a, b) => bitrateOf(b) - bitrateOf(a))[0];
      const result: ResolvedYouTubeStream = {
        url: urlOf(chosen),
        mime: 'video/mp4',
        height: heightOf(chosen),
      };
      if (bestAudio) {
        result.audioUrl = urlOf(bestAudio);
        result.audioMime = cleanMime(bestAudio, 'audio/mp4');
      }
      return result;
    }
  }
  return null;
}

async function resolveViaInvidious(
  videoId: string,
  mode: MediaFormatMode,
  quality: Quality
): Promise<ResolvedYouTubeStream | null> {
  for (const host of INVIDIOUS_INSTANCES) {
    const json = await fetchJson(`${host}/api/v1/videos/${videoId}?fields=adaptiveFormats,formatStreams`, {}, 6000);
    if (!json) continue;

    const adaptive = Array.isArray(json.adaptiveFormats)
      ? (json.adaptiveFormats as RawFormat[])
      : [];
    const muxed = Array.isArray(json.formatStreams)
      ? (json.formatStreams as RawFormat[])
      : [];

    if (mode === 'audio') {
      const pool = adaptive.filter(
        (f) => urlOf(f).length > 0 && mimeOf(f).startsWith('audio/')
      );
      if (pool.length === 0) continue;
      const sorted = [...pool].sort((a, b) => bitrateOf(b) - bitrateOf(a));
      return { url: urlOf(sorted[0]), mime: cleanMime(sorted[0], 'audio/mp4') };
    }

    const desired = Number.parseInt(String(quality), 10) || 720;
    const muxedMp4 = muxed.filter((f) => urlOf(f).length > 0);
    if (muxedMp4.length > 0) {
      const sorted = [...muxedMp4].sort((a, b) => heightOf(b) - heightOf(a));
      const chosen =
        sorted.find((f) => heightOf(f) === desired) ??
        sorted.find((f) => heightOf(f) > 0 && heightOf(f) <= desired) ??
        sorted[sorted.length - 1];
      return { url: urlOf(chosen), mime: 'video/mp4', height: heightOf(chosen) };
    }

    const video = adaptive.filter(
      (f) => urlOf(f).length > 0 && mimeOf(f).startsWith('video/')
    );
    if (video.length > 0) {
      const sorted = [...video].sort((a, b) => heightOf(b) - heightOf(a));
      const chosen = sorted.find((f) => heightOf(f) <= desired) ?? sorted[0];
      const bestAudio = [...adaptive]
        .filter((f) => urlOf(f).length > 0 && mimeOf(f).startsWith('audio/'))
        .sort((a, b) => bitrateOf(b) - bitrateOf(a))[0];
      const result: ResolvedYouTubeStream = {
        url: urlOf(chosen),
        mime: cleanMime(chosen, 'video/mp4'),
        height: heightOf(chosen),
      };
      if (bestAudio) {
        result.audioUrl = urlOf(bestAudio);
        result.audioMime = cleanMime(bestAudio, 'audio/mp4');
      }
      return result;
    }
  }
  return null;
}

/**
 * Three independent networks, tried in order of reliability.
 * InnerTube first, then Piped, then Invidious.
 */
export async function resolveYouTubeDirect(
  videoId: string,
  mode: MediaFormatMode,
  quality: VideoQuality
): Promise<ResolvedYouTubeStream | null> {
  if (!isDirectYouTubeSupported()) return null;

  const innertube = await resolveViaInnertube(videoId, mode, quality);
  if (innertube) return innertube;

  const [piped, invidious] = await Promise.allSettled([
    resolveViaPiped(videoId, mode, quality),
    resolveViaInvidious(videoId, mode, quality),
  ]);

  if (piped.status === 'fulfilled' && piped.value) return piped.value;
  if (invidious.status === 'fulfilled' && invidious.value) return invidious.value;

  return null;
}

export async function resolveYouTubeUrlDirect(
  targetUrl: string,
  mode: MediaFormatMode,
  quality: VideoQuality
): Promise<ResolvedYouTubeStream | null> {
  const videoId = extractYouTubeVideoId(targetUrl);
  if (!videoId) return null;
  return resolveYouTubeDirect(videoId, mode, quality);
}
