import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHUNK_SIZE_BYTES,
  buildChunkedStreamUrl,
  downloadMediaChunked,
  downloadMediaInChunks,
  parseContentRangeTotal,
} from './chunkDownloader';

test('buildChunkedStreamUrl appends chunked=1 and start offset', () => {
  const url = buildChunkedStreamUrl(
    'https://tubidy-vercel-api.vercel.app/',
    'https://www.youtube.com/watch?v=abc',
    'video',
    '720',
    3145728
  );
  assert.equal(
    url,
    'https://tubidy-vercel-api.vercel.app/api/stream?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dabc&mode=video&quality=720&chunked=1&start=3145728'
  );
});

test('parseContentRangeTotal extracts total length from Content-Range header', () => {
  assert.equal(parseContentRangeTotal('bytes 0-3145727/7000000'), 7000000);
  assert.equal(parseContentRangeTotal('bytes 0-100/*'), null);
  assert.equal(parseContentRangeTotal(null), null);
});

test('downloadMediaInChunks tries directUrl first and falls back to 3 MB chunked proxy on failure', async () => {
  const chunk1 = new Uint8Array(CHUNK_SIZE_BYTES).fill(1);
  const chunk2 = new Uint8Array(512).fill(2);
  const requestedStarts: string[] = [];
  let directAttempted = false;

  const mockFetch = (async (input: RequestInfo | URL) => {
    const urlStr = String(input);
    const parsed = new URL(urlStr);

    if (parsed.pathname === '/api/resolve-stream') {
      return new Response(
        JSON.stringify({ directUrl: 'https://cdn.example.com/blocked.mp4' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (parsed.hostname === 'cdn.example.com') {
      directAttempted = true;
      throw new TypeError('CORS blocked');
    }

    const start = parsed.searchParams.get('start') ?? '';
    requestedStarts.push(start);

    if (start === '0') {
      return new Response(chunk1, {
        status: 206,
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Range': `bytes 0-${CHUNK_SIZE_BYTES - 1}/${CHUNK_SIZE_BYTES + 512}`,
        },
      });
    }
    return new Response(chunk2, {
      status: 206,
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Range': `bytes ${CHUNK_SIZE_BYTES}-${CHUNK_SIZE_BYTES + 511}/${CHUNK_SIZE_BYTES + 512}`,
      },
    });
  }) as typeof fetch;

  const progressUpdates: number[] = [];
  const controller = new AbortController();

  const result = await downloadMediaInChunks({
    backendUrl: 'https://tubidy-vercel-api.vercel.app',
    targetUrl: 'https://www.youtube.com/watch?v=test',
    mode: 'video',
    quality: '720',
    signal: controller.signal,
    onProgress: (p) => progressUpdates.push(p.receivedBytes),
    fetchImpl: mockFetch,
  });

  assert.equal(directAttempted, true);
  assert.deepEqual(requestedStarts, ['0', String(CHUNK_SIZE_BYTES)]);
  assert.equal(result.sizeBytes, CHUNK_SIZE_BYTES + 512);
  assert.equal(result.mimeType, 'video/mp4');
  assert.equal(progressUpdates[progressUpdates.length - 1], CHUNK_SIZE_BYTES + 512);
});

test('downloadMediaChunked falls back to Piped/Invidious CORS endpoints when backend returns HTTP 500', async () => {
  const audioPayload = new Uint8Array(4096).fill(9);
  let hitPiped = false;

  const mockFetch = (async (input: RequestInfo | URL) => {
    const urlStr = String(input);
    const parsed = new URL(urlStr);

    if (parsed.hostname === 'tubidy-vercel-api.vercel.app') {
      return new Response(JSON.stringify({ error: 'Server error' }), { status: 500 });
    }

    if (parsed.hostname === 'pipedapi.kavin.rocks') {
      hitPiped = true;
      return new Response(
        JSON.stringify({
          audioStreams: [
            { bitrate: 128000, url: 'https://piped-cdn.example.com/audio.m4a' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (parsed.hostname === 'piped-cdn.example.com') {
      return new Response(audioPayload, {
        status: 200,
        headers: { 'Content-Type': 'audio/mp4', 'Content-Length': '4096' },
      });
    }

    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const progressUpdates: number[] = [];
  const result = await downloadMediaChunked({
    backendUrl: 'https://tubidy-vercel-api.vercel.app',
    targetUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    mode: 'audio',
    quality: 'highest',
    signal: new AbortController().signal,
    onProgress: (p) => progressUpdates.push(p.receivedBytes),
    fetchImpl: mockFetch,
  });

  assert.equal(hitPiped, true);
  assert.equal(result.sizeBytes, 4096);
  assert.equal(result.mimeType, 'audio/mp4');
  assert.equal(progressUpdates[progressUpdates.length - 1], 4096);
});

test('downloadMediaChunked falls back to Loader.to / Oceansaver when backend and Piped/Invidious fail', async () => {
  const mp3Payload = new Uint8Array(2048).fill(7);
  let pollCount = 0;

  const mockFetch = (async (input: RequestInfo | URL) => {
    const urlStr = String(input);
    const parsed = new URL(urlStr);

    if (
      parsed.hostname === 'tubidy-vercel-api.vercel.app' ||
      parsed.hostname === 'pipedapi.kavin.rocks' ||
      parsed.hostname === 'api.piped.private.coffee' ||
      parsed.hostname === 'inv.nadeko.net'
    ) {
      return new Response(JSON.stringify({ error: 'Unavailable' }), { status: 500 });
    }

    if (parsed.hostname === 'ab.cococococ.com') {
      assert.equal(parsed.searchParams.get('format'), 'mp3');
      assert.equal(parsed.searchParams.get('api'), 'dfcb6d76f2f6a9894gjkege8a4ab232222');
      return new Response(JSON.stringify({ success: true, id: 'task-42' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (parsed.hostname === 'p.oceansaver.in') {
      pollCount += 1;
      if (pollCount === 1) {
        return new Response(JSON.stringify({ success: 0, progress: 450 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          success: 1,
          progress: 1000,
          download_url: 'https://loader-cdn.example.com/track.mp3',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (parsed.hostname === 'loader-cdn.example.com') {
      return new Response(mp3Payload, {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': '2048' },
      });
    }

    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const progressValues: number[] = [];
  const result = await downloadMediaChunked({
    backendUrl: 'https://tubidy-vercel-api.vercel.app',
    targetUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    mode: 'audio',
    quality: 'highest',
    signal: new AbortController().signal,
    onProgress: (p) => progressValues.push(p.progress),
    fetchImpl: mockFetch,
    loaderPollIntervalMs: 0,
  });

  assert.equal(pollCount, 2);
  assert.equal(result.sizeBytes, 2048);
  assert.equal(result.mimeType, 'audio/mpeg');
  assert.ok(progressValues.includes(45));
});

