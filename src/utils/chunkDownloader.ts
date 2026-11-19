import type { MediaFormatMode } from '../types/media';
import { DEFAULT_BACKEND_URL, resolveStream } from './api';
import { normalizeBackendUrl } from './formatters';
import { extractYouTubeVideoId } from './youtube';

export const CHUNK_SIZE_BYTES = 3 * 1024 * 1024; // 3 MB

export interface ChunkDownloadProgress {
  receivedBytes: number;
  totalBytes: number | null;
  progress: number;
  chunkIndex: number;
}

export interface ChunkDownloadResult {
  blob: Blob;
  mimeType: string;
  sizeBytes: number;
}

export function buildChunkedStreamUrl(
  backendUrl: string,
  targetUrl: string,
  mode: MediaFormatMode,
  quality: string,
  startOffset: number
): string {
  const base = normalizeBackendUrl(backendUrl) || DEFAULT_BACKEND_URL;
  return `${base}/api/stream?url=${encodeURIComponent(targetUrl)}&mode=${encodeURIComponent(mode)}&quality=${encodeURIComponent(quality)}&chunked=1&start=${startOffset}`;
}

export function parseContentRangeTotal(contentRange: string | null): number | null {
  if (!contentRange) {
    return null;
  }
  const match = /\/\s*(\d+)\s*$/i.exec(contentRange.trim());
  if (!match) {
    return null;
  }
  const total = Number(match[1]);
  return Number.isFinite(total) && total > 0 ? total : null;
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let totalLength = 0;
  for (const chunk of chunks) {
    totalLength += chunk.byteLength;
  }
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

async function readResponseWithProgress(
  response: Response,
  baseOffset: number,
  knownTotalBytes: number | null,
  chunkIndex: number,
  onProgress: (progress: ChunkDownloadProgress) => void
): Promise<{ bytes: Uint8Array; totalBytes: number | null }> {
  const headerTotal =
    parseContentRangeTotal(response.headers.get('content-range')) ??
    (() => {
      const len = Number(response.headers.get('content-length'));
      if (baseOffset === 0 && Number.isFinite(len) && len > 0) {
        return len;
      }
      return null;
    })();

  const effectiveTotal = knownTotalBytes ?? headerTotal;

  if (!response.body) {
    const arr = new Uint8Array(await response.arrayBuffer());
    const receivedBytes = baseOffset + arr.byteLength;
    onProgress({
      receivedBytes,
      totalBytes: effectiveTotal,
      progress: effectiveTotal
        ? Math.min(99, Math.round((receivedBytes / effectiveTotal) * 100))
        : -1,
      chunkIndex,
    });
    return { bytes: arr, totalBytes: effectiveTotal };
  }

  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let localBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value && value.byteLength > 0) {
      parts.push(value);
      localBytes += value.byteLength;
      const receivedBytes = baseOffset + localBytes;
      onProgress({
        receivedBytes,
        totalBytes: effectiveTotal,
        progress: effectiveTotal
          ? Math.min(99, Math.round((receivedBytes / effectiveTotal) * 100))
          : -1,
        chunkIndex,
      });
    }
  }

  return { bytes: concatChunks(parts), totalBytes: effectiveTotal };
}

function pickPipedStreamUrl(
  payload: Record<string, unknown>,
  mode: MediaFormatMode,
  quality: string
): string | null {
  if (mode === 'audio') {
    const audioStreams = Array.isArray(payload.audioStreams)
      ? (payload.audioStreams as Array<Record<string, unknown>>)
      : [];
    const sorted = [...audioStreams]
      .filter((s) => typeof s.url === 'string' && s.url.length > 0)
      .sort((a, b) => Number(b.bitrate ?? 0) - Number(a.bitrate ?? 0));
    if (sorted.length > 0) {
      return String(sorted[0].url);
    }
  }

  const videoStreams = Array.isArray(payload.videoStreams)
    ? (payload.videoStreams as Array<Record<string, unknown>>)
    : [];
  const progressive = videoStreams.filter(
    (s) => typeof s.url === 'string' && s.url.length > 0 && s.videoOnly !== true
  );
  if (progressive.length > 0) {
    const desired = Number.parseInt(quality, 10) || 720;
    const match =
      progressive.find((s) => String(s.quality || '').includes(String(desired))) ??
      progressive[0];
    return String(match.url);
  }

  return null;
}

async function resolvePublicFallbackUrls(
  videoId: string,
  mode: MediaFormatMode,
  quality: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch
): Promise<string[]> {
  const candidates: string[] = [];
  const pipedHosts = ['https://pipedapi.kavin.rocks', 'https://api.piped.private.coffee'];

  for (const host of pipedHosts) {
    if (signal.aborted) {
      break;
    }
    try {
      const resp = await fetchImpl(`${host}/streams/${encodeURIComponent(videoId)}`, {
        signal,
      });
      if (resp.ok) {
        const json = (await resp.json()) as Record<string, unknown>;
        const resolved = pickPipedStreamUrl(json, mode, quality);
        if (resolved) {
          candidates.push(resolved);
        }
      }
    } catch {
      // Try next public endpoint
    }
  }

  const itag = mode === 'audio' ? '140' : '18';
  candidates.push(
    `https://inv.nadeko.net/latest_version?id=${encodeURIComponent(videoId)}&itag=${itag}&local=true`
  );

  return candidates;
}

async function downloadFromDirectCandidate(
  url: string,
  signal: AbortSignal,
  onProgress: (progress: ChunkDownloadProgress) => void,
  fetchImpl: typeof fetch,
  fallbackMime: string
): Promise<ChunkDownloadResult | null> {
  try {
    const resp = await fetchImpl(url, { signal });
    if (!resp.ok) {
      return null;
    }
    const ct = resp.headers.get('content-type');
    if (ct && (ct.includes('application/json') || ct.includes('text/html'))) {
      return null;
    }
    const mimeType = ct || fallbackMime;
    const { bytes } = await readResponseWithProgress(resp, 0, null, 1, onProgress);
    if (bytes.byteLength === 0) {
      return null;
    }
    const blob = new Blob([bytes as BlobPart], { type: mimeType });
    return {
      blob,
      mimeType,
      sizeBytes: blob.size,
    };
  } catch (err) {
    if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
      throw err;
    }
    return null;
  }
}

async function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw new DOMException('Download aborted', 'AbortError');
  }
  if (ms <= 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Download aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function downloadViaLoaderFallback(
  targetUrl: string,
  mode: MediaFormatMode,
  quality: string,
  signal: AbortSignal,
  onProgress: (progress: ChunkDownloadProgress) => void,
  fetchImpl: typeof fetch,
  fallbackMime: string,
  pollIntervalMs = 1200
): Promise<ChunkDownloadResult | null> {
  const formatParam = mode === 'audio' ? 'mp3' : quality || '720';
  const initUrl = `https://ab.cococococ.com/ajax/download.php?copyright=0&format=${encodeURIComponent(
    formatParam
  )}&url=${encodeURIComponent(targetUrl)}&api=dfcb6d76f2f6a9894gjkege8a4ab232222`;

  try {
    const initResp = await fetchImpl(initUrl, { signal });
    if (!initResp.ok) {
      return null;
    }
    const initData = (await initResp.json()) as Record<string, unknown>;
    const taskId = typeof initData.id === 'string' || typeof initData.id === 'number'
      ? String(initData.id).trim()
      : '';
    if (!taskId) {
      return null;
    }

    let downloadUrl =
      typeof initData.download_url === 'string' && initData.download_url
        ? initData.download_url
        : '';

    const maxPolls = 60;
    for (let attempt = 0; attempt < maxPolls && !downloadUrl; attempt += 1) {
      if (signal.aborted) {
        throw new DOMException('Download aborted', 'AbortError');
      }
      if (attempt > 0) {
        await sleepWithAbort(pollIntervalMs, signal);
      }
      const pollResp = await fetchImpl(
        `https://p.oceansaver.in/ajax/progress.php?id=${encodeURIComponent(taskId)}`,
        { signal }
      );
      if (!pollResp.ok) {
        continue;
      }
      const pollData = (await pollResp.json()) as Record<string, unknown>;
      const rawProgress = Number(pollData.progress ?? 0);
      if (Number.isFinite(rawProgress) && rawProgress >= 0) {
        const normalizedPct =
          rawProgress > 100
            ? Math.min(99, Math.round(rawProgress / 10))
            : Math.min(99, Math.round(rawProgress));
        onProgress({
          receivedBytes: 0,
          totalBytes: null,
          progress: normalizedPct,
          chunkIndex: 1,
        });
      }
      if (typeof pollData.download_url === 'string' && pollData.download_url.startsWith('http')) {
        downloadUrl = pollData.download_url;
        break;
      }
      const textStatus = typeof pollData.text === 'string' ? pollData.text.toLowerCase() : '';
      if (textStatus.includes('error') || textStatus.includes('failed')) {
        break;
      }
    }

    if (!downloadUrl) {
      return null;
    }

    const expectedMime = mode === 'audio' ? 'audio/mpeg' : fallbackMime;
    return await downloadFromDirectCandidate(
      downloadUrl,
      signal,
      onProgress,
      fetchImpl,
      expectedMime
    );
  } catch (err) {
    if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
      throw err;
    }
    return null;
  }
}

interface CapacitorHttpLike {
  post: (options: {
    url: string;
    headers?: Record<string, string>;
    data?: unknown;
  }) => Promise<{ status: number; data: unknown }>;
  get?: (options: {
    url: string;
    headers?: Record<string, string>;
    responseType?: 'blob' | 'arraybuffer' | 'text' | 'json';
  }) => Promise<{
    status: number;
    data: unknown;
    headers?: Record<string, string>;
  }>;
}

interface CapacitorWindow {
  Capacitor?: {
    isNativePlatform?: () => boolean;
    Plugins?: {
      CapacitorHttp?: CapacitorHttpLike;
    };
  };
}

function decodeCapacitorBinaryData(data: unknown): Uint8Array | null {
  if (!data) {
    return null;
  }
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (typeof data === 'string' && data.length > 0) {
    try {
      const cleaned = data.includes(',') && data.startsWith('data:')
        ? data.slice(data.indexOf(',') + 1)
        : data;
      const binary = atob(cleaned);
      const out = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        out[i] = binary.charCodeAt(i);
      }
      return out;
    } catch {
      return null;
    }
  }
  return null;
}

function pickInnertubeIosFormat(
  streamingData: Record<string, unknown>,
  mode: MediaFormatMode,
  quality: string
): { url: string; mimeType: string; contentLength: number | null } | null {
  const formats = Array.isArray(streamingData.formats)
    ? (streamingData.formats as Array<Record<string, unknown>>)
    : [];
  const adaptiveFormats = Array.isArray(streamingData.adaptiveFormats)
    ? (streamingData.adaptiveFormats as Array<Record<string, unknown>>)
    : [];

  if (mode === 'audio') {
    const audioCandidates = [...adaptiveFormats, ...formats]
      .filter((f) => {
        const mime = typeof f.mimeType === 'string' ? f.mimeType : '';
        return typeof f.url === 'string' && f.url.length > 0 && mime.startsWith('audio/');
      })
      .sort(
        (a, b) =>
          Number(b.bitrate ?? b.averageBitrate ?? 0) -
          Number(a.bitrate ?? a.averageBitrate ?? 0)
      );

    if (audioCandidates.length > 0) {
      const chosen = audioCandidates[0];
      const rawMime = typeof chosen.mimeType === 'string' ? chosen.mimeType : 'audio/mp4';
      const len = Number(chosen.contentLength ?? 0);
      return {
        url: String(chosen.url),
        mimeType: rawMime.split(';')[0].trim() || 'audio/mp4',
        contentLength: Number.isFinite(len) && len > 0 ? len : null,
      };
    }
  }

  const desiredHeight = Number.parseInt(quality, 10) || 720;
  const progressiveMp4 = formats.filter((f) => {
    const mime = typeof f.mimeType === 'string' ? f.mimeType : '';
    return typeof f.url === 'string' && f.url.length > 0 && mime.includes('video/mp4');
  });

  if (progressiveMp4.length > 0) {
    const sorted = [...progressiveMp4].sort(
      (a, b) => Number(b.height ?? 0) - Number(a.height ?? 0)
    );
    const exactOrUnder =
      sorted.find((f) => Number(f.height ?? 0) === desiredHeight) ??
      sorted.find((f) => {
        const h = Number(f.height ?? 0);
        return h > 0 && h <= desiredHeight;
      }) ??
      sorted[0];

    const rawMime = typeof exactOrUnder.mimeType === 'string' ? exactOrUnder.mimeType : 'video/mp4';
    const len = Number(exactOrUnder.contentLength ?? 0);
    return {
      url: String(exactOrUnder.url),
      mimeType: rawMime.split(';')[0].trim() || 'video/mp4',
      contentLength: Number.isFinite(len) && len > 0 ? len : null,
    };
  }

  const fallbackAnyVideo = adaptiveFormats
    .filter((f) => {
      const mime = typeof f.mimeType === 'string' ? f.mimeType : '';
      return typeof f.url === 'string' && f.url.length > 0 && mime.startsWith('video/mp4');
    })
    .sort((a, b) => Number(b.height ?? 0) - Number(a.height ?? 0));

  if (fallbackAnyVideo.length > 0) {
    const chosen =
      fallbackAnyVideo.find((f) => Number(f.height ?? 0) <= desiredHeight) ??
      fallbackAnyVideo[0];
    const rawMime = typeof chosen.mimeType === 'string' ? chosen.mimeType : 'video/mp4';
    const len = Number(chosen.contentLength ?? 0);
    return {
      url: String(chosen.url),
      mimeType: rawMime.split(';')[0].trim() || 'video/mp4',
      contentLength: Number.isFinite(len) && len > 0 ? len : null,
    };
  }

  return null;
}

interface InnertubeClientProfile {
  name: 'ANDROID_VR' | 'IOS';
  userAgent: string;
  clientNameHeader: string;
  clientVersion: string;
  clientPayload: Record<string, unknown>;
}

const NATIVE_INNERTUBE_CLIENTS: readonly InnertubeClientProfile[] = [
  {
    name: 'ANDROID_VR',
    userAgent:
      'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    clientNameHeader: '28',
    clientVersion: '1.60.19',
    clientPayload: {
      clientName: 'ANDROID_VR',
      clientVersion: '1.60.19',
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
    name: 'IOS',
    userAgent:
      'com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 18_1_0 like Mac OS X;)',
    clientNameHeader: '5',
    clientVersion: '19.45.4',
    clientPayload: {
      clientName: 'IOS',
      clientVersion: '19.45.4',
      deviceMake: 'Apple',
      deviceModel: 'iPhone16,2',
      osName: 'iPhone',
      osVersion: '18.1.0.22B83',
      hl: 'en',
      gl: 'US',
    },
  },
];

function isYouTubeUrl(url: string): boolean {
  if (!url) {
    return false;
  }
  if (extractYouTubeVideoId(url)) {
    return true;
  }
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host.includes('youtube.com') ||
      host.includes('youtu.be') ||
      host.includes('youtube-nocookie.com')
    );
  } catch {
    return false;
  }
}

async function downloadBinaryWithCapacitorHttp(
  url: string,
  mimeType: string,
  contentLength: number | null,
  userAgent: string | undefined,
  signal: AbortSignal,
  onProgress: (progress: ChunkDownloadProgress) => void,
  capacitorHttp: CapacitorHttpLike
): Promise<ChunkDownloadResult | null> {
  if (typeof capacitorHttp.get !== 'function') {
    return null;
  }

  const baseHeaders: Record<string, string> = userAgent ? { 'User-Agent': userAgent } : {};

  if (contentLength && contentLength > CHUNK_SIZE_BYTES) {
    const chunks: Uint8Array[] = [];
    let offset = 0;
    let chunkIdx = 1;
    let rangeFailed = false;

    while (offset < contentLength) {
      if (signal.aborted) {
        throw new DOMException('Download aborted', 'AbortError');
      }
      const endByte = Math.min(offset + CHUNK_SIZE_BYTES - 1, contentLength - 1);
      const chunkResp = await capacitorHttp.get({
        url,
        headers: {
          ...baseHeaders,
          Range: `bytes=${offset}-${endByte}`,
        },
        responseType: 'arraybuffer',
      });
      if (chunkResp.status < 200 || chunkResp.status >= 300) {
        rangeFailed = true;
        break;
      }
      const bytes = decodeCapacitorBinaryData(chunkResp.data);
      if (!bytes || bytes.byteLength === 0) {
        rangeFailed = true;
        break;
      }
      chunks.push(bytes);
      offset += bytes.byteLength;
      onProgress({
        receivedBytes: offset,
        totalBytes: contentLength,
        progress: Math.min(99, Math.round((offset / contentLength) * 100)),
        chunkIndex: chunkIdx,
      });
      chunkIdx += 1;
      if (bytes.byteLength > CHUNK_SIZE_BYTES) {
        // Server ignored Range and returned full payload
        break;
      }
    }

    if (!rangeFailed && chunks.length > 0) {
      const blob = new Blob(chunks as BlobPart[], { type: mimeType });
      onProgress({
        receivedBytes: blob.size,
        totalBytes: blob.size,
        progress: 100,
        chunkIndex: chunkIdx,
      });
      return {
        blob,
        mimeType,
        sizeBytes: blob.size,
      };
    }
  }

  const binResp = await capacitorHttp.get({
    url,
    headers: baseHeaders,
    responseType: 'arraybuffer',
  });
  if (signal.aborted) {
    throw new DOMException('Download aborted', 'AbortError');
  }
  if (binResp.status >= 200 && binResp.status < 300) {
    const headerCt =
      binResp.headers?.['content-type'] ?? binResp.headers?.['Content-Type'] ?? '';
    if (headerCt && (headerCt.includes('text/html') || headerCt.includes('application/json'))) {
      return null;
    }
    const resolvedMime = headerCt ? headerCt.split(';')[0].trim() || mimeType : mimeType;
    const bytes = decodeCapacitorBinaryData(binResp.data);
    if (bytes && bytes.byteLength > 0) {
      onProgress({
        receivedBytes: bytes.byteLength,
        totalBytes: bytes.byteLength,
        progress: 100,
        chunkIndex: 1,
      });
      const blob = new Blob([bytes as BlobPart], { type: resolvedMime });
      return {
        blob,
        mimeType: resolvedMime,
        sizeBytes: blob.size,
      };
    }
  }

  return null;
}

async function downloadViaNativeCapacitorIos(
  videoId: string,
  mode: MediaFormatMode,
  quality: string,
  signal: AbortSignal,
  onProgress: (progress: ChunkDownloadProgress) => void,
  fetchImpl: typeof fetch,
  capacitorHttp: CapacitorHttpLike
): Promise<ChunkDownloadResult | null> {
  for (const profile of NATIVE_INNERTUBE_CLIENTS) {
    if (signal.aborted) {
      throw new DOMException('Download aborted', 'AbortError');
    }

    try {
      const response = await capacitorHttp.post({
        url: 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': profile.userAgent,
          'X-YouTube-Client-Name': profile.clientNameHeader,
          'X-YouTube-Client-Version': profile.clientVersion,
        },
        data: {
          videoId,
          context: {
            client: profile.clientPayload,
          },
          contentCheckOk: true,
          racyCheckOk: true,
        },
      });

      if (signal.aborted) {
        throw new DOMException('Download aborted', 'AbortError');
      }

      if (response.status < 200 || response.status >= 300 || !response.data) {
        continue;
      }

      const payload =
        typeof response.data === 'string'
          ? (JSON.parse(response.data) as Record<string, unknown>)
          : (response.data as Record<string, unknown>);

      const streamingData = payload?.streamingData as Record<string, unknown> | undefined;
      if (!streamingData) {
        continue;
      }

      const picked = pickInnertubeIosFormat(streamingData, mode, quality);
      if (!picked) {
        continue;
      }

      onProgress({
        receivedBytes: 0,
        totalBytes: picked.contentLength,
        progress: picked.contentLength ? 1 : 0,
        chunkIndex: 1,
      });

      // Attempt streaming fetch first for fine-grained progress updates
      try {
        const mediaResp = await fetchImpl(picked.url, { signal });
        if (mediaResp.ok) {
          const ct = mediaResp.headers.get('content-type');
          if (!ct || (!ct.includes('text/html') && !ct.includes('application/json'))) {
            const { bytes } = await readResponseWithProgress(
              mediaResp,
              0,
              picked.contentLength,
              1,
              onProgress
            );
            if (bytes.byteLength > 0) {
              const blob = new Blob([bytes as BlobPart], { type: picked.mimeType });
              return {
                blob,
                mimeType: picked.mimeType,
                sizeBytes: blob.size,
              };
            }
          }
        }
      } catch (err) {
        if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
          throw err;
        }
        // Fall back to CapacitorHttp.get below if WKWebView blocked direct fetch
      }

      const capResult = await downloadBinaryWithCapacitorHttp(
        picked.url,
        picked.mimeType,
        picked.contentLength,
        profile.userAgent,
        signal,
        onProgress,
        capacitorHttp
      );
      if (capResult) {
        return capResult;
      }
    } catch (err) {
      if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        throw err;
      }
      // Try next InnerTube client profile automatically (ANDROID_VR -> IOS)
    }

    // Reset progress cleanly before trying the next client profile
    onProgress({
      receivedBytes: 0,
      totalBytes: null,
      progress: 0,
      chunkIndex: 1,
    });
  }

  return null;
}

/**
 * Multi-fallback hybrid downloader:
 * 0a. Direct non-YouTube URLs (live radio, direct MP3/MP4 links): bypass YouTube resolution
 *     and download directly via fetch (or CapacitorHttp on native iOS).
 * 0b. On native Capacitor iOS for YouTube URLs: call YouTube InnerTube player API sequentially
 *     with ANDROID_VR (1.60.19) and IOS (19.45.4) via CapacitorHttp from the device IP.
 * 1. Try `${backendUrl}/api/resolve-stream` (up to 4s) and direct fetch.
 * 2. Fall back to sequential 3 MB chunked proxy `${backendUrl}/api/stream?...&chunked=1&start=${offset}`.
 * 3. If backend returns HTTP 500 or fails, fall back on the client to public Piped / Invidious
 *    CORS endpoints (`pipedapi.kavin.rocks`, `api.piped.private.coffee`, `inv.nadeko.net`),
 *    and finally direct browser extraction via Loader.to / Oceansaver CORS API (`ab.cococococ.com` + `p.oceansaver.in`).
 */
export async function downloadMediaInChunks(params: {
  backendUrl: string;
  targetUrl: string;
  mode: MediaFormatMode;
  quality: string;
  signal: AbortSignal;
  onProgress: (progress: ChunkDownloadProgress) => void;
  fetchImpl?: typeof fetch;
  loaderPollIntervalMs?: number;
}): Promise<ChunkDownloadResult> {
  const {
    backendUrl,
    targetUrl,
    mode,
    quality,
    signal,
    onProgress,
    fetchImpl = fetch,
    loaderPollIntervalMs = 1200,
  } = params;

  const fallbackMime = mode === 'audio' ? 'audio/mp4' : 'video/mp4';
  let detectedMimeType: string = fallbackMime;

  if (signal.aborted) {
    throw new DOMException('Download aborted', 'AbortError');
  }

  // Always start (or retry) with a clean zeroed progress baseline
  onProgress({
    receivedBytes: 0,
    totalBytes: null,
    progress: 0,
    chunkIndex: 1,
  });

  const videoId = extractYouTubeVideoId(targetUrl);
  const targetIsYouTube = isYouTubeUrl(targetUrl);

  const capacitor =
    typeof window !== 'undefined'
      ? (window as unknown as CapacitorWindow).Capacitor
      : undefined;
  const isNativeIos = Boolean(capacitor?.isNativePlatform?.());
  const capacitorHttp = capacitor?.Plugins?.CapacitorHttp;

  // Step 0a: Direct non-YouTube URLs (e.g., live radio streams, direct MP3/MP4 files)
  // Always bypass YouTube resolution and attempt direct binary download first.
  if (!targetIsYouTube && /^https?:\/\//i.test(targetUrl)) {
    const directRes = await downloadFromDirectCandidate(
      targetUrl,
      signal,
      onProgress,
      fetchImpl,
      fallbackMime
    );
    if (directRes) {
      return directRes;
    }

    if (isNativeIos && capacitorHttp) {
      const nativeDirectRes = await downloadBinaryWithCapacitorHttp(
        targetUrl,
        fallbackMime,
        null,
        undefined,
        signal,
        onProgress,
        capacitorHttp
      );
      if (nativeDirectRes) {
        return nativeDirectRes;
      }
    }
  }

  // Step 0b: Native Capacitor iOS direct YouTube downloader (ANDROID_VR -> IOS)
  if (isNativeIos && capacitorHttp && videoId) {
    const nativeRes = await downloadViaNativeCapacitorIos(
      videoId,
      mode,
      quality,
      signal,
      onProgress,
      fetchImpl,
      capacitorHttp
    );
    if (nativeRes) {
      return nativeRes;
    }
  }

  // Step 1: Resolve directUrl via backend and attempt direct fetch
  const { directUrl, fallbackUrl, resolved } = await resolveStream(
    backendUrl,
    targetUrl,
    mode,
    quality,
    { timeoutMs: 4000, fetchImpl, signal }
  );

  if (signal.aborted) {
    throw new DOMException('Download aborted', 'AbortError');
  }

  if (resolved && directUrl && directUrl !== fallbackUrl) {
    const directRes = await downloadFromDirectCandidate(
      directUrl,
      signal,
      onProgress,
      fetchImpl,
      fallbackMime
    );
    if (directRes) {
      return directRes;
    }
  }

  // Step 2: Sequential 3 MB chunked proxy requests on backend
  const collectedChunks: Uint8Array[] = [];
  let offset = 0;
  let chunkIndex = 1;
  let knownTotalBytes: number | null = null;
  let backendFailedStatus: number | null = null;

  while (true) {
    if (signal.aborted) {
      throw new DOMException('Download aborted', 'AbortError');
    }

    const chunkUrl = buildChunkedStreamUrl(backendUrl, targetUrl, mode, quality, offset);
    let response: Response;
    try {
      response = await fetchImpl(chunkUrl, { signal });
    } catch (err) {
      if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        throw err;
      }
      backendFailedStatus = 500;
      break;
    }

    if (!response.ok) {
      backendFailedStatus = response.status;
      break;
    }

    const contentType = response.headers.get('content-type');
    if (contentType && !contentType.includes('application/json')) {
      detectedMimeType = contentType;
    }

    const { bytes, totalBytes } = await readResponseWithProgress(
      response,
      offset,
      knownTotalBytes,
      chunkIndex,
      onProgress
    );

    if (totalBytes !== null) {
      knownTotalBytes = totalBytes;
    }

    if (bytes.byteLength > 0) {
      collectedChunks.push(bytes);
      offset += bytes.byteLength;
    }

    if (
      bytes.byteLength < CHUNK_SIZE_BYTES ||
      bytes.byteLength > CHUNK_SIZE_BYTES ||
      (knownTotalBytes !== null && offset >= knownTotalBytes)
    ) {
      break;
    }

    chunkIndex += 1;
  }

  if (backendFailedStatus === null && collectedChunks.length > 0) {
    const blob = new Blob(collectedChunks as BlobPart[], { type: detectedMimeType });
    return {
      blob,
      mimeType: detectedMimeType,
      sizeBytes: blob.size,
    };
  }

  // Try unchunked backend /api/stream if not an explicit 5xx error
  if (backendFailedStatus !== null && backendFailedStatus < 500) {
    const unchunkedRes = await downloadFromDirectCandidate(
      fallbackUrl,
      signal,
      onProgress,
      fetchImpl,
      fallbackMime
    );
    if (unchunkedRes) {
      return unchunkedRes;
    }
  }

  // Step 3: Client-side public Piped / Invidious CORS fallback on HTTP 500 or backend failure
  if (videoId) {
    const publicUrls = await resolvePublicFallbackUrls(
      videoId,
      mode,
      quality,
      signal,
      fetchImpl
    );
    for (const candidateUrl of publicUrls) {
      if (signal.aborted) {
        throw new DOMException('Download aborted', 'AbortError');
      }
      const res = await downloadFromDirectCandidate(
        candidateUrl,
        signal,
        onProgress,
        fetchImpl,
        fallbackMime
      );
      if (res) {
        return res;
      }
    }
  }

  // Step 4: Direct browser extraction fallback via Loader.to / Oceansaver CORS API (YouTube only)
  if (targetIsYouTube || videoId) {
    const loaderRes = await downloadViaLoaderFallback(
      targetUrl,
      mode,
      quality,
      signal,
      onProgress,
      fetchImpl,
      fallbackMime,
      loaderPollIntervalMs
    );
    if (loaderRes) {
      return loaderRes;
    }
  }

  if ((targetIsYouTube || videoId) && !isNativeIos) {
    throw new Error('Web proxy blocked by YouTube — works natively in iPhone IPA');
  }

  throw new Error(
    backendFailedStatus
      ? `Download failed (HTTP ${backendFailedStatus}) and fallbacks were unavailable.`
      : 'Unable to download media stream.'
  );
}

export const downloadMediaChunked = downloadMediaInChunks;
