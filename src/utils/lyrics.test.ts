import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanTrackMetadataForLyrics,
  fetchTrackLyrics,
  getActiveLyricIndex,
  parseLrcLyrics,
} from './lyrics';

test('cleanTrackMetadataForLyrics strips brackets and official suffixes', () => {
  const res = cleanTrackMetadataForLyrics(
    'Midnight City [Official Video] (4K)',
    'M83 - Topic'
  );
  assert.equal(res.cleanTitle, 'Midnight City');
  assert.equal(res.cleanArtist, 'M83');
});

test('parseLrcLyrics parses mm:ss.xx timestamps and sorts chronologically', () => {
  const lrc = `
[00:12.50] Waiting in a car
[00:04.20] Intro line
[01:02.000] Looking at the stars
`;
  const lines = parseLrcLyrics(lrc);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].text, 'Intro line');
  assert.ok(Math.abs(lines[0].time - 4.2) < 0.01);
  assert.equal(lines[1].text, 'Waiting in a car');
  assert.equal(lines[2].text, 'Looking at the stars');
  assert.ok(Math.abs(lines[2].time - 62) < 0.01);
});

test('getActiveLyricIndex returns active line matching currentTime', () => {
  const lines = [
    { time: 5, text: 'Line 1' },
    { time: 12, text: 'Line 2' },
    { time: 20, text: 'Line 3' },
  ];
  assert.equal(getActiveLyricIndex(lines, 1), -1);
  assert.equal(getActiveLyricIndex(lines, 5.1), 0);
  assert.equal(getActiveLyricIndex(lines, 15), 1);
  assert.equal(getActiveLyricIndex(lines, 25), 2);
});

test('fetchTrackLyrics parses lrclib.net synced and plain payloads', async () => {
  const mockFetch = (async () =>
    new Response(
      JSON.stringify([
        {
          syncedLyrics: '[00:01.00] First\n[00:05.00] Second',
          plainLyrics: 'First\nSecond',
        },
      ]),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )) as typeof fetch;

  const res = await fetchTrackLyrics('Test Song (Official Audio)', 'Artist', mockFetch);
  assert.equal(res.hasLyrics, true);
  assert.equal(res.synced.length, 2);
  assert.equal(res.plain.length, 2);
});
