import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAYBACK_RATES,
  buildMediaMetadataInit,
  clampSeekTime,
  formatSleepCountdown,
  getNextLoopMode,
  getNextPlaybackRate,
  getNextTrackIndex,
  getPreviousTrackAction,
  insertPlayNextInQueue,
} from './playerLogic';
import type { PlayableTrack } from '../types/media';

function makeTrack(id: string): PlayableTrack {
  return {
    id,
    title: `Track ${id}`,
    uploader: 'FM Collective',
    duration: 210,
    thumbnail: 'https://example.com/art.jpg',
    sourceUrl: `https://example.com/${id}`,
    streamUrl: `https://example.com/${id}.mp4`,
    mode: 'video',
    isOffline: false,
  };
}

test('getNextLoopMode cycles off -> all -> one -> off', () => {
  assert.equal(getNextLoopMode('off'), 'all');
  assert.equal(getNextLoopMode('all'), 'one');
  assert.equal(getNextLoopMode('one'), 'off');
});

test('clampSeekTime clamps within valid track bounds', () => {
  assert.equal(clampSeekTime(-10, 120), 0);
  assert.equal(clampSeekTime(45, 120), 45);
  assert.equal(clampSeekTime(200, 120), 120);
  assert.equal(clampSeekTime(15, 0), 15);
});

test('getNextTrackIndex handles queue bounds and loop flag', () => {
  assert.equal(getNextTrackIndex(0, 3, false), 1);
  assert.equal(getNextTrackIndex(2, 3, false), -1);
  assert.equal(getNextTrackIndex(2, 3, true), 0);
  assert.equal(getNextTrackIndex(-1, 0, true), -1);
});

test('getPreviousTrackAction restarts after 3s or switches to previous track', () => {
  assert.deepEqual(getPreviousTrackAction(1, 5.2, 3), { action: 'restart', targetIndex: 1 });
  assert.deepEqual(getPreviousTrackAction(1, 1.5, 3), { action: 'switch', targetIndex: 0 });
  assert.deepEqual(getPreviousTrackAction(0, 1.0, 3), { action: 'restart', targetIndex: 0 });
  assert.deepEqual(getPreviousTrackAction(-1, 0, 0), { action: 'none', targetIndex: -1 });
});

test('getNextPlaybackRate cycles through balanced speeds centered on 1x', () => {
  assert.deepEqual(PLAYBACK_RATES, [0.5, 0.75, 1, 1.25, 1.5]);
  assert.equal(getNextPlaybackRate(1), 1.25);
  assert.equal(getNextPlaybackRate(1.5), 0.5);
  assert.equal(getNextPlaybackRate(99), 1);
});

test('insertPlayNextInQueue inserts track immediately after currentIndex and deduplicates', () => {
  const t1 = makeTrack('1');
  const t2 = makeTrack('2');
  const t3 = makeTrack('3');

  const inserted = insertPlayNextInQueue([t1, t2], 0, t3);
  assert.deepEqual(
    inserted.queue.map((t) => t.id),
    ['1', '3', '2']
  );
  assert.equal(inserted.currentIndex, 0);

  const reordered = insertPlayNextInQueue([t1, t2, t3], 1, t1);
  assert.deepEqual(
    reordered.queue.map((t) => t.id),
    ['2', '1', '3']
  );
  assert.equal(reordered.currentIndex, 0);
});

test('formatSleepCountdown formats mm:ss cleanly', () => {
  assert.equal(formatSleepCountdown(905), '15:05');
  assert.equal(formatSleepCountdown(0), '0:00');
  assert.equal(formatSleepCountdown(-5), '0:00');
});

test('buildMediaMetadataInit populates iOS MediaSession fields', () => {
  const track = makeTrack('t1');
  const meta = buildMediaMetadataInit(track);
  assert.equal(meta.title, 'Track t1');
  assert.equal(meta.artist, 'FM Collective');
  assert.equal(meta.album, 'Tubidy FM');
  assert.equal(meta.artwork?.length, 2);
});
