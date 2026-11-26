import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type { MediaFormatMode, MediaItem, VideoQuality } from '../types/media';
import { extractYouTubeVideoId } from './youtube';

interface Client {
  ua: string;
  cn: string;
  cv: string;
  origin: string;
  body: Record<string, unknown>;
}

const CLIENTS: Client[] = [
  {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
    cn: '101',
    cv: '1.02',
    origin: 'https://www.youtube.com',
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
    ua: 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    cn: '28',
    cv: '1.65.10',
    origin: 'https://www.youtube.com',
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
    ua: 'com.google.ios.youtube/20.11.6 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    cn: '5',
    cv: '20.11.6',
    origin: 'https://www.youtube.com',
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
    origin: 'https://www.youtube.com',
    body: {
      clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
      clientVersion: '2.0',
      hl: 'en',
      gl: 'US',
    },
  },
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    cn: '1',
    cv: '2.20241010.01.00',
    origin: 'https://www.youtube.com',
    body: { clientName: 'WEB', clientVersion: '2.20241010.01.00', hl: 'en', gl: 'US' },
  },
];

const MUSIC_CLIENT: Client = {
  ua: CLIENTS[4].ua,
  cn: '67',
  cv: '1.20241009.01.00',
  origin: 'https://music.youtube.com',
  body: {
    clientName: 'WEB_REMIX',
    clientVersion: '1.20241009.01.00',
    hl: 'en',
    gl: 'US',
  },
};

const EXPIRY_SAFETY_MS = 60_000;
const EXPIRY_MAX_MS = 4 * 60 * 60 * 1000;
const EXPIRY_DEFAULT_MS = 15 * 60 * 1000;

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

const mimeOf = (f: RawFormat) => (typeof f.mimeType === 'string' ? f.mimeType : '');
const urlOf = (f: RawFormat) => (typeof f.url === 'string' ? f.url : '');
const heightOf = (f: RawFormat) => Number(f.height ?? 0) || 0;
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

async function post(
  path: string,
  client: Client,
  payload: Record<string, unknown>,
  timeoutMs: number
): Promise<Record<string, unknown> | null> {
  try {
    const resp = await CapacitorHttp.post({
      url: `https://www.youtube.com${path}`,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': client.ua,
        'X-YouTube-Client-Name': client.cn,
        'X-YouTube-Client-Version': client.cv,
        Origin: client.origin,
      },
      data: { ...payload, context: { client: client.body } },
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

/**
 * Search straight from the device. No backend, no CORS, no datacenter-IP blocking.
 */
export async function searchYouTubeDirect(
  query: string,
  musicOnly: boolean,
  limit = 24
): Promise<MediaItem[]> {
  if (!isDirectYouTubeSupported()) {
    return [];
  }

  const client = musicOnly ? MUSIC_CLIENT : CLIENTS[4];
  const json = await post('/youtubei/v1/search?prettyPrint=false', client, { query }, 7000);
  if (!json?.contents) {
    return [];
  }

  const renderers: Array<Record<string, unknown>> = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if ((key === 'videoRenderer' || key === 'playlistVideoRenderer') && value) {
        renderers.push(value as Record<string, unknown>);
      } else {
        walk(value);
      }
    }
  };
  walk(json.contents);

  const seen = new Set<string>();
  const items: MediaItem[] = [];

  for (const r of renderers) {
    const videoId = typeof r.videoId === 'string' ? r.videoId : '';
    if (!videoId || seen.has(videoId)) continue;

    const titleRuns = r.title as { runs?: Array<{ text?: string }>; simpleText?: string } | undefined;
    const title =
      titleRuns?.runs?.[0]?.text ?? titleRuns?.simpleText ?? '';
    if (!title) continue;

    const byline = (r.ownerText ?? r.longBylineText ?? r.shortBylineText) as
      | { runs?: Array<{ text?: string }> }
      | undefined;
    const uploader = byline?.runs?.[0]?.text ?? 'YouTube';

    const thumbs = (r.thumbnail as { thumbnails?: Array<{ url?: string }> } | undefined)?.thumbnails;
    const thumbnail =
      Array.isArray(thumbs) && thumbs.length > 0 ? String(thumbs[thumbs.length - 1]?.url ?? '') : '';

    const lengthText = (r.lengthText as { simpleText?: string } | undefined)?.simpleText;

    seen.add(videoId);
    items.push({
      id: `yt_${videoId}`,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      title: title.trim(),
      uploader: uploader.trim(),
      duration: parseDurationText(lengthText),
      thumbnail,
      platform: musicOnly ? 'YT Music' : 'YouTube',
      mediaType: musicOnly ? 'audio' : 'video',
      isLiveRadio: false,
    });

    if (items.length >= limit) break;
  }

  return items;
}

/**
 * Resolve a direct googlevideo URL on-device. All clients race in parallel,
 * so the first usable answer wins instead of waiting out a slow one.
 */
export async function resolveYouTubeDirect(
  videoId: string,
  mode: MediaFormatMode,
  quality: VideoQuality
): Promise<{ url: string; mime: string } | null> {
  if (!isDirectYouTubeSupported()) {
    return null;
  }

  const attempt = async (client: Client) => {
    const json = await post(
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

    if (mode === 'audio') {
      const audio = [...adaptive, ...formats].filter(
        (f) => urlOf(f).length > 0 && mimeOf(f).startsWith('audio/')
      );
      const mp4 = audio.filter((f) => mimeOf(f).toLowerCase().includes('audio/mp4'));
      const pool = mp4.length > 0 ? mp4 : audio;
      if (pool.length === 0) return hls ? { url: hls, mime: 'application/x-mpegURL' } : null;
      const sorted = [...pool].sort((a, b) => bitrateOf(b) - bitrateOf(a));
      return { url: urlOf(sorted[0]), mime: cleanMime(sorted[0], 'audio/mp4') };
    }

    const desired = Number.parseInt(String(quality), 10) || 720;
    const progressive = formats.filter(
      (f) => urlOf(f).length > 0 && mimeOf(f).includes('video/mp4')
    );
    if (progressive.length > 0) {
      const sorted = [...progressive].sort((a, b) => heightOf(b) - heightOf(a));
      const chosen =
        sorted.find((f) => heightOf(f) === desired) ??
        sorted.find((f) => heightOf(f) > 0 && heightOf(f) <= desired) ??
        sorted[sorted.length - 1];
      return { url: urlOf(chosen), mime: cleanMime(chosen, 'video/mp4') };
    }

    if (hls) return { url: hls, mime: 'application/x-mpegURL' };

    const video = adaptive.filter(
      (f) => urlOf(f).length > 0 && mimeOf(f).startsWith('video/mp4')
    );
    if (video.length === 0) return null;
    const capped = video.filter((f) => heightOf(f) > 0 && heightOf(f) <= desired);
    const sorted = [...(capped.length > 0 ? capped : video)].sort(
      (a, b) => heightOf(b) - heightOf(a) || bitrateOf(b) - bitrateOf(a)
    );
    return { url: urlOf(sorted[0]), mime: cleanMime(sorted[0], 'video/mp4') };
  };

  const results = await Promise.allSettled(CLIENTS.map(attempt));
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      return result.value;
    }
  }
  return null;
}

/** Convenience wrapper for callers that only have a URL. */
export async function resolveYouTubeUrlDirect(
  targetUrl: string,
  mode: MediaFormatMode,
  quality: VideoQuality
): Promise<{ url: string; mime: string } | null> {
  const videoId = extractYouTubeVideoId(targetUrl);
  if (!videoId) return null;
  return resolveYouTubeDirect(videoId, mode, quality);
}
