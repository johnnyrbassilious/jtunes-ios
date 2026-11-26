import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type { MediaFormatMode } from '../types/media';
import { DEFAULT_BACKEND_URL, resolveStream } from './api';
import { normalizeBackendUrl } from './formatters';
import { extractYouTubeVideoId } from './youtube';
import { resolveYouTubeDirect } from './youtubeDirect';

export const CHUNK_SIZE_BYTES = 2.5 * 1024 * 1024;
export const NATIVE_CHUNK_SIZE_BYTES = 8 * 1024 * 1024;

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

function getHeaderInsensitive(
  headers: Record<string, string> | undefined,
  name: string
): string | null {
  if (!headers) return null;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) {
      return v;
    }
  }
  return null;
}

function isLikelyLiveStreamUrl(url: string): boolean {
  return /\.(m3u8|m3u|pls)(\?|$)/i.test(url);
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

function decodeCapacitorBinaryData(data: unknown): Uint8Array | null {
  if (!data) return null;
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof data === 'string' && data.length > 0) {
    try {
      const stripped =
        data.includes(',') && data.startsWith('data:')
          ? data.slice(data.indexOf(',') + 1)
          : data;
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

async function downloadBinaryWithCapacitorHttp(
  url: string,
  fallbackMime: string,
  signal: AbortSignal,
  onProgress: (progress: ChunkDownloadProgress) => void
): Promise<ChunkDownloadResult | null> {
  const rangeHeaders = (start: number, end: number) => ({
    Range: `bytes=${start}-${end}`,
    'Accept-Encoding': 'identity',
  });

  let total: number | null = null;
  let mime = fallbackMime;
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let chunkIdx = 1;

  // The first request doubles as the probe, so there is no separate HEAD round-trip.
  let first: Awaited<ReturnType<typeof CapacitorHttp.get>>;
  try {
    first = await CapacitorHttp.get({
      url,
      headers: rangeHeaders(0, NATIVE_CHUNK_SIZE_BYTES - 1),
      responseType: 'blob',
      connectTimeout: 10000,
      readTimeout: 30000,
    });
  } catch {
    return null;
  }

  if (
    getHeaderInsensitive(first.headers, 'icy-name') ||
    getHeaderInsensitive(first.headers, 'icy-metaint')
  ) {
    throw new Error('Live radio streams cannot be downloaded offline.');
  }

  if (first.status < 200 || first.status >= 300) {
    return null;
  }

  const ct = getHeaderInsensitive(first.headers, 'content-type');
  if (ct && (ct.includes('text/html') || ct.includes('application/json'))) {
    return null;
  }
  if (ct) {
    mime = ct.split(';')[0].trim() || fallbackMime;
  }

  const contentRange = getHeaderInsensitive(first.headers, 'content-range');
  if (contentRange) {
    const m = /\/\s*(\d+)\s*$/.exec(contentRange);
    if (m) {
      const parsed = Number(m[1]);
      if (Number.isFinite(parsed) && parsed > 0) {
        total = parsed;
      }
    }
  } else {
    const len = Number(getHeaderInsensitive(first.headers, 'content-length'));
    if (Number.isFinite(len) && len > 0) {
      total = len;
    }
  }

  const firstBytes = decodeCapacitorBinaryData(first.data);
  if (!firstBytes || firstBytes.byteLength === 0) {
    return null;
  }

  chunks.push(firstBytes);
  offset = firstBytes.byteLength;
  onProgress({
    receivedBytes: offset,
    totalBytes: total,
    progress: total ? Math.min(99, Math.round((offset / total) * 100)) : -1,
    chunkIndex: chunkIdx,
  });

  // 200 means the server ignored Range and we already hold the whole file.
  const rangeHonoured = first.status === 206;

  while (rangeHonoured && total !== null && offset < total) {
    if (signal.aborted) {
      throw new DOMException('Download aborted', 'AbortError');
    }
    const end = Math.min(offset + NATIVE_CHUNK_SIZE_BYTES - 1, total - 1);
    let next: Awaited<ReturnType<typeof CapacitorHttp.get>>;
    try {
      next = await CapacitorHttp.get({
        url,
        headers: rangeHeaders(offset, end),
        responseType: 'blob',
        connectTimeout: 10000,
        readTimeout: 30000,
      });
    } catch {
      break;
    }
    if (next.status < 200 || next.status >= 300) break;

    const bytes = decodeCapacitorBinaryData(next.data);
    if (!bytes || bytes.byteLength === 0) break;

    chunks.push(bytes);
    offset += bytes.byteLength;
    chunkIdx += 1;
    onProgress({
      receivedBytes: offset,
      totalBytes: total,
      progress: Math.min(99, Math.round((offset / total) * 100)),
      chunkIndex: chunkIdx,
    });
  }

  const blob = new Blob(chunks as BlobPart[], { type: mime });
  onProgress({
    receivedBytes: blob.size,
    totalBytes: blob.size,
    progress: 100,
    chunkIndex: chunkIdx,
  });
  return { blob, mimeType: mime, sizeBytes: blob.size };
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
    if (resp.headers.get('icy-name') || resp.headers.get('icy-metaint')) {
      throw new Error('Live radio streams cannot be downloaded offline.');
    }
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
    onProgress({
      receivedBytes: blob.size,
      totalBytes: blob.size,
      progress: 100,
      chunkIndex: 1,
    });
    return { blob, mimeType, sizeBytes: blob.size };
  } catch (err) {
    if (
      signal.aborted ||
      (err instanceof Error &&
        (err.name === 'AbortError' || err.message.includes('Live radio')))
    ) {
      throw err;
    }
    return null;
  }
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

  const fallbackMime = mode === 'audio' ? 'audio/mpeg' : 'video/mp4';

  if (signal.aborted) {
    throw new DOMException('Download aborted', 'AbortError');
  }

  if (isLikelyLiveStreamUrl(targetUrl)) {
    throw new Error('Live radio / HLS streams cannot be downloaded offline.');
  }

  onProgress({
    receivedBytes: 0,
    totalBytes: null,
    progress: 0,
    chunkIndex: 1,
  });

  const isNative = Capacitor.isNativePlatform();

  // Step 1: YouTube resolves on the phone (real IP, no server round-trip)
  let downloadUrl = targetUrl;
  const ytId = extractYouTubeVideoId(targetUrl);

  if (ytId && isNative) {
    const direct = await resolveYouTubeDirect(ytId, mode, quality);
    if (direct) {
      downloadUrl = direct.url;
    }
  }

  // Step 1b: other page URLs still need the server
  if (downloadUrl === targetUrl) {
    const needsServerResolve =
      /archive\.org\/details\//i.test(targetUrl) || /\/api\/v1\/videos\//i.test(targetUrl);
    if (needsServerResolve) {
      const resolved = await resolveStream(backendUrl, targetUrl, mode, quality, {
        timeoutMs: 12000,
        fetchImpl,
        signal,
      });
      if (resolved.resolved && resolved.directUrl) {
        downloadUrl = resolved.directUrl;
      }
    }
  }

  if (isLikelyLiveStreamUrl(downloadUrl)) {
    throw new Error('Live HLS streams cannot be downloaded offline.');
  }

  // Step 2: native direct download, 8 MB ranges
  if (isNative) {
    const nativeRes = await downloadBinaryWithCapacitorHttp(
      downloadUrl,
      fallbackMime,
      signal,
      onProgress
    );
    if (nativeRes) {
      return nativeRes;
    }
  }

  // Step 3: direct browser fetch
  const directRes = await downloadFromDirectCandidate(
    downloadUrl,
    signal,
    onProgress,
    fetchImpl,
    fallbackMime
  );
  if (directRes) {
    return directRes;
  }

  // Step 4: chunked proxy fallback
  const collectedChunks: Uint8Array[] = [];
  let offset = 0;
  let chunkIndex = 1;
  let knownTotalBytes: number | null = null;
  let detectedMimeType = fallbackMime;
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

    if (response.status === 400) {
      throw new Error('Live radio streams cannot be downloaded offline.');
    }

    if (!response.ok) {
      backendFailedStatus = response.status;
      break;
    }

    const contentType = response.headers.get('content-type');
    if (contentType && !contentType.includes('application/json')) {
      detectedMimeType = contentType.split(';')[0].trim() || fallbackMime;
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
    onProgress({
      receivedBytes: blob.size,
      totalBytes: blob.size,
      progress: 100,
      chunkIndex,
    });
    return { blob, mimeType: detectedMimeType, sizeBytes: blob.size };
  }

  throw new Error(
    backendFailedStatus
      ? `Download failed (HTTP ${backendFailedStatus}).`
      : 'Unable to download this media file.'
  );
}

export const downloadMediaChunked = downloadMediaInChunks;
