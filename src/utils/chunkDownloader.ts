import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type { MediaFormatMode } from '../types/media';
import { DEFAULT_BACKEND_URL, resolveStream } from './api';
import { normalizeBackendUrl } from './formatters';
import { extractYouTubeVideoId } from './youtube';

export const CHUNK_SIZE_BYTES = 2.5 * 1024 * 1024; // 2.5 MB (matches Vercel /api/stream)

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
    const mimeType = ct ? ct.split(';')[0].trim() || fallbackMime : fallbackMime;
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
      const stripped = data.includes(',') && data.startsWith('data:')
        ? data.slice(data.indexOf(',') + 1)
        : data;
      // Strip whitespace/newlines and normalize URL-safe base64 from iOS native bridge
      const cleaned = stripped.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
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
    const allAudio = [...adaptiveFormats, ...formats].filter((f) => {
      const mime = typeof f.mimeType === 'string' ? f.mimeType : '';
      return typeof f.url === 'string' && f.url.length > 0 && mime.startsWith('audio/');
    });
    const mp4Audio = allAudio.filter((f) =>
      String(f.mimeType ?? '').toLowerCase().includes('audio/mp4')
    );
    const pool = (mp4Audio.length > 0 ? mp4Audio : allAudio).sort(
      (a, b) =>
        Number(b.bitrate ?? b.averageBitrate ?? 0) -
        Number(a.bitrate ?? a.averageBitrate ?? 0)
    );

    if (pool.length > 0) {
      const chosen = pool[0];
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
  name: 'VISIONOS' | 'ANDROID_VR' | 'IOS';
  userAgent: string;
  clientNameHeader: string;
  clientVersion: string;
  clientPayload: Record<string, unknown>;
}

const NATIVE_INNERTUBE_CLIENTS: readonly InnertubeClientProfile[] = [
  {
    name: 'VISIONOS',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
    clientNameHeader: '101',
    clientVersion: '1.02',
    clientPayload: {
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
    name: 'ANDROID_VR',
    userAgent:
      'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    clientNameHeader: '28',
    clientVersion: '1.65.10',
    clientPayload: {
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
    name: 'IOS',
    userAgent:
      'com.google.ios.youtube/20.11.6 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    clientNameHeader: '5',
    clientVersion: '20.11.6',
    clientPayload: {
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
  errorsOut: string[]
): Promise<ChunkDownloadResult | null> {
  const baseHeaders: Record<string, string> = userAgent ? { 'User-Agent': userAgent } : {};

  // Use 2.5 MB Range chunks when contentLength is known so the native bridge stays fast and shows progress
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
      const chunkResp = await CapacitorHttp.get({
        url,
        headers: {
          ...baseHeaders,
          Range: `bytes=${offset}-${endByte}`,
        },
        responseType: 'blob',
      });
      if (chunkResp.status < 200 || chunkResp.status >= 300) {
        errorsOut.push(`chunkHTTP:${chunkResp.status}`);
        rangeFailed = true;
        break;
      }
      const bytes = decodeCapacitorBinaryData(chunkResp.data);
      if (!bytes || bytes.byteLength === 0) {
        errorsOut.push('chunkDecodeEmpty');
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

  // Single-shot native download fallback
  const binResp = await CapacitorHttp.get({
    url,
    headers: baseHeaders,
    responseType: 'blob',
  });
  if (signal.aborted) {
    throw new DOMException('Download aborted', 'AbortError');
  }
  if (binResp.status >= 200 && binResp.status < 300) {
    const headerCt =
      binResp.headers?.['content-type'] ?? binResp.headers?.['Content-Type'] ?? '';
    if (headerCt && (headerCt.includes('text/html') || headerCt.includes('application/json'))) {
      errorsOut.push(`badCT:${headerCt}`);
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
    errorsOut.push('singleDecodeEmpty');
  } else {
    errorsOut.push(`singleHTTP:${binResp.status}`);
  }

  return null;
}

async function downloadViaNativeCapacitorIos(
  videoId: string,
  mode: MediaFormatMode,
  quality: string,
  signal: AbortSignal,
  onProgress: (progress: ChunkDownloadProgress) => void,
  errorsOut: string[]
): Promise<ChunkDownloadResult | null> {
  for (const profile of NATIVE_INNERTUBE_CLIENTS) {
    if (signal.aborted) {
      throw new DOMException('Download aborted', 'AbortError');
    }

    try {
      const response = await CapacitorHttp.post({
        url: 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': profile.userAgent,
          'X-YouTube-Client-Name': profile.clientNameHeader,
          'X-YouTube-Client-Version': profile.clientVersion,
          Origin: 'https://www.youtube.com',
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
        errorsOut.push(`${profile.name}:HTTP${response.status}`);
        continue;
      }

      const payload =
        typeof response.data === 'string'
          ? (JSON.parse(response.data) as Record<string, unknown>)
          : (response.data as Record<string, unknown>);

      const playability = payload?.playabilityStatus as Record<string, unknown> | undefined;
      if (playability?.status && playability.status !== 'OK') {
        errorsOut.push(`${profile.name}:${String(playability.status)}`);
        continue;
      }

      const streamingData = payload?.streamingData as Record<string, unknown> | undefined;
      if (!streamingData) {
        errorsOut.push(`${profile.name}:noStreamData`);
        continue;
      }

      const picked = pickInnertubeIosFormat(streamingData, mode, quality);
      if (!picked) {
        errorsOut.push(`${profile.name}:noFormat`);
        continue;
      }

      onProgress({
        receivedBytes: 0,
        totalBytes: picked.contentLength,
        progress: picked.contentLength ? 2 : 1,
        chunkIndex: 1,
      });

      // Go straight through native CapacitorHttp.get (avoids WKWebView CORS / patched-fetch binary bugs)
      const capResult = await downloadBinaryWithCapacitorHttp(
        picked.url,
        picked.mimeType,
        picked.contentLength,
        profile.userAgent,
        signal,
        onProgress,
        errorsOut
      );
      if (capResult) {
        return capResult;
      }
    } catch (err) {
      if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        throw err;
      }
      errorsOut.push(`${profile.name}:${err instanceof Error ? err.message : 'err'}`);
    }

    onProgress({
      receivedBytes: 0,
      totalBytes: null,
      progress: 0,
      chunkIndex: 1,
    });
  }

  return null;
}

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
  } = params;

  const fallbackMime = mode === 'audio' ? 'audio/mp4' : 'video/mp4';
  let detectedMimeType: string = fallbackMime;
  const nativeErrors: string[] = [];

  if (signal.aborted) {
    throw new DOMException('Download aborted', 'AbortError');
  }

  onProgress({
    receivedBytes: 0,
    totalBytes: null,
    progress: 0,
    chunkIndex: 1,
  });

  const videoId = extractYouTubeVideoId(targetUrl);
  const targetIsYouTube = isYouTubeUrl(targetUrl);
  const isNative = Capacitor.isNativePlatform();

  // Step 0a: Direct non-YouTube URLs (live radio, direct MP3/MP4 files)
  if (!targetIsYouTube && /^https?:\/\//i.test(targetUrl)) {
    if (isNative) {
      const nativeDirectRes = await downloadBinaryWithCapacitorHttp(
        targetUrl,
        fallbackMime,
        null,
        undefined,
        signal,
        onProgress,
        nativeErrors
      );
      if (nativeDirectRes) {
        return nativeDirectRes;
      }
    }
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
  }

  // Step 0b: Native Capacitor iOS direct YouTube downloader (VISIONOS -> ANDROID_VR -> IOS)
  if (isNative && videoId) {
    const nativeRes = await downloadViaNativeCapacitorIos(
      videoId,
      mode,
      quality,
      signal,
      onProgress,
      nativeErrors
    );
    if (nativeRes) {
      return nativeRes;
    }
  }

  // Step 1: Resolve directUrl via Vercel backend and download directly
  const { directUrl, fallbackUrl, resolved } = await resolveStream(
    backendUrl,
    targetUrl,
    mode,
    quality,
    { timeoutMs: 5500, fetchImpl, signal }
  );

  if (signal.aborted) {
    throw new DOMException('Download aborted', 'AbortError');
  }

  if (resolved && directUrl && directUrl !== fallbackUrl) {
    if (isNative) {
      const nativeBackendDirectRes = await downloadBinaryWithCapacitorHttp(
        directUrl,
        fallbackMime,
        null,
        NATIVE_INNERTUBE_CLIENTS[0].userAgent,
        signal,
        onProgress,
        nativeErrors
      );
      if (nativeBackendDirectRes) {
        return nativeBackendDirectRes;
      }
    }

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

  // Step 2: Sequential 2.5 MB chunked proxy requests on Vercel backend
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
      bytes.byteLength === 0 ||
      (knownTotalBytes !== null && offset >= knownTotalBytes) ||
      (knownTotalBytes === null && bytes.byteLength < CHUNK_SIZE_BYTES)
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

  const diag = nativeErrors.length > 0 ? ` [${nativeErrors.slice(0, 3).join(', ')}]` : '';
  if ((targetIsYouTube || videoId) && !isNative) {
    throw new Error('Web proxy blocked by YouTube — works natively in iPhone IPA');
  }

  throw new Error(
    backendFailedStatus
      ? `Download failed (HTTP ${backendFailedStatus})${diag}`
      : `Unable to download media stream${diag}`
  );
}

export const downloadMediaChunked = downloadMediaInChunks;
