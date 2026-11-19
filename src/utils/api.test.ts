import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BACKEND_URL,
  applyStrictSearchFilter,
  buildRelatedUrl,
  buildStreamUrl,
  fetchRelatedMedia,
  fetchSearchSuggestions,
  normalizeMediaItem,
  normalizeSearchResults,
  resolveStream,
  searchMedia,
  searchMediaSmart,
} from './api';

test('buildStreamUrl encodes url, mode, and quality cleanly', () => {
  const url = buildStreamUrl(
    'https://tubidy-vercel-api.vercel.app/',
    'https://www.youtube.com/watch?v=123',
    'video',
    '720'
  );
  assert.equal(
    url,
    'https://tubidy-vercel-api.vercel.app/api/stream?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D123&mode=video&quality=720'
  );
});

test('buildRelatedUrl encodes id, title, uploader, and optional historyArtists', () => {
  const url = buildRelatedUrl('https://tubidy-vercel-api.vercel.app/', {
    id: 'abc123',
    title: 'Midnight Echoes',
    uploader: 'Studio Archive',
  });
  assert.equal(
    url,
    'https://tubidy-vercel-api.vercel.app/api/related?id=abc123&title=Midnight%20Echoes&uploader=Studio%20Archive'
  );

  const urlWithHistory = buildRelatedUrl('https://tubidy-vercel-api.vercel.app/', {
    id: 'abc123',
    title: 'Midnight Echoes',
    uploader: 'Studio Archive',
    historyArtists: ['Daft Punk', 'Kaytranada'],
  });
  assert.match(urlWithHistory, /&historyArtists=Daft%20Punk%2CKaytranada$/);
});

test('applyStrictSearchFilter never mixes audio and video items across Audio and Videos tabs', () => {
  const mixed = normalizeSearchResults([
    {
      id: 'yt-vid',
      url: 'https://www.youtube.com/watch?v=vid123',
      title: 'Official Video',
      uploader: 'Artist VEVO',
      platform: 'YouTube',
    },
    {
      id: 'yt-music',
      url: 'https://music.youtube.com/watch?v=aud123',
      title: 'Album Track',
      uploader: 'Artist - Topic',
      platform: 'YT Music',
    },
    {
      id: 'sc-track',
      url: 'https://soundcloud.com/artist/track',
      title: 'SoundCloud Cut',
      uploader: 'Artist',
    },
  ]);

  const audioOnly = applyStrictSearchFilter(mixed, 'audio');
  assert.equal(audioOnly.length, 2);
  assert.ok(audioOnly.every((i) => i.mediaType === 'audio'));

  const videosOnly = applyStrictSearchFilter(mixed, 'videos');
  assert.equal(videosOnly.length, 1);
  assert.equal(videosOnly[0].id, 'yt-vid');
  assert.equal(videosOnly[0].mediaType, 'video');
});

test('searchMediaSmart recovers from typos using /api/suggestions when initial search is empty', async () => {
  const mockFetch = (async (input: RequestInfo | URL) => {
    const parsed = new URL(String(input));
    if (parsed.pathname === '/api/search') {
      const q = parsed.searchParams.get('q');
      if (q === 'daft pnk') {
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      }
      if (q === 'Daft Punk') {
        return new Response(
          JSON.stringify({
            results: [
              {
                id: 'dp-1',
                url: 'https://music.youtube.com/watch?v=dp1',
                title: 'One More Time',
                uploader: 'Daft Punk - Topic',
                platform: 'YT Music',
              },
            ],
          }),
          { status: 200 }
        );
      }
    }
    if (parsed.pathname === '/api/suggestions') {
      return new Response(JSON.stringify({ suggestions: ['Daft Punk', 'Daft Punk Mix'] }), {
        status: 200,
      });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const suggestions = await fetchSearchSuggestions(
    'https://tubidy-vercel-api.vercel.app',
    'daft pnk',
    mockFetch
  );
  assert.deepEqual(suggestions, ['Daft Punk', 'Daft Punk Mix']);

  const smart = await searchMediaSmart(
    'https://tubidy-vercel-api.vercel.app',
    'daft pnk',
    'audio',
    { fetchImpl: mockFetch }
  );
  assert.equal(smart.correctedQuery, 'Daft Punk');
  assert.equal(smart.items.length, 1);
  assert.equal(smart.items[0].mediaType, 'audio');
});

test('searchMedia passes filter param and falls back to radio-browser on radio filter', async () => {
  const requestedUrls: string[] = [];
  const mockFetch = (async (input: RequestInfo | URL) => {
    const urlStr = String(input);
    requestedUrls.push(urlStr);
    if (urlStr.includes('/api/search')) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify([
        {
          stationuuid: 'st-1',
          name: 'BBC Radio 1',
          url_resolved: 'https://stream.example.com/radio1.mp3',
          country: 'UK',
          favicon: '',
        },
      ]),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as typeof fetch;

  const items = await searchMedia(
    'https://tubidy-vercel-api.vercel.app',
    'bbc',
    'radio',
    mockFetch
  );
  assert.match(requestedUrls[0], /filter=radio/);
  assert.equal(items.length, 1);
  assert.equal(items[0].isLiveRadio, true);
  assert.equal(items[0].mediaType, 'audio');
  assert.equal(items[0].directStreamUrl, 'https://stream.example.com/radio1.mp3');
});

test('resolveStream falls back to proxy streamUrl with resolved=false when request times out', async () => {
  const slowFetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('Timed out', 'AbortError'));
      });
    })) as typeof fetch;

  const result = await resolveStream(
    'https://tubidy-vercel-api.vercel.app',
    'https://www.youtube.com/watch?v=abc',
    'audio',
    '720',
    { timeoutMs: 25, fetchImpl: slowFetch }
  );

  assert.equal(result.resolved, false);
  assert.equal(result.directUrl, result.fallbackUrl);
  assert.match(result.fallbackUrl, /mode=audio/);
});

test('fetchRelatedMedia normalizes /api/related payloads', async () => {
  const mockFetch = (async () =>
    new Response(
      JSON.stringify({
        related: [
          {
            id: 'rel-1',
            url: 'https://www.youtube.com/watch?v=rel12345678',
            title: 'Next Up Track',
            uploader: 'Archive FM',
            duration: 190,
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )) as typeof fetch;

  const items = await fetchRelatedMedia(
    'https://tubidy-vercel-api.vercel.app',
    { id: 'orig', title: 'Track 1', uploader: 'Artist' },
    mockFetch
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'rel-1');
  assert.equal(items[0].title, 'Next Up Track');
});

test('normalizeMediaItem handles standard and alternate API field names', () => {
  const item = normalizeMediaItem({
    id: 'vid-1',
    webpage_url: 'https://www.youtube.com/watch?v=vid-1',
    title: 'Midnight Echoes',
    author: 'Studio Archive',
    duration: '03:45',
    thumbnails: [{ url: 'https://cdn.example/small.jpg' }, { url: 'https://cdn.example/large.jpg' }],
  });

  assert.ok(item);
  assert.equal(item.id, 'vid-1');
  assert.equal(item.url, 'https://www.youtube.com/watch?v=vid-1');
  assert.equal(item.title, 'Midnight Echoes');
  assert.equal(item.uploader, 'Studio Archive');
  assert.equal(item.duration, 225);
  assert.equal(item.thumbnail, 'https://cdn.example/large.jpg');
  assert.equal(item.platform, 'YouTube');
  assert.equal(item.mediaType, 'video');
});

test('normalizeSearchResults handles array and wrapped payloads without injecting mock items', () => {
  assert.deepEqual(normalizeSearchResults([]), []);
  assert.deepEqual(normalizeSearchResults({ results: [] }), []);

  const parsed = normalizeSearchResults({
    results: [
      {
        id: '1',
        url: 'https://soundcloud.com/test/track',
        title: 'Test Track',
        uploader: 'Artist',
        duration: 120,
        thumbnail: '',
      },
    ],
  });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].platform, 'SoundCloud');
  assert.equal(parsed[0].mediaType, 'audio');
  assert.equal(DEFAULT_BACKEND_URL, 'https://tubidy-vercel-api.vercel.app');
});
