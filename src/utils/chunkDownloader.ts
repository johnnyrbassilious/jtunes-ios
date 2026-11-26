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

  // First request doubles as the probe: no separate HEAD round-trip.
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

  // 200 means the server ignored Range and we already have the whole file.
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
