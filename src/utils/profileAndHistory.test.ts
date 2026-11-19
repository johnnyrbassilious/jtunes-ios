import test from 'node:test';
import assert from 'node:assert/strict';
import type { MediaItem, PlayableTrack } from '../types/media';
import {
  filterDistinctRelatedItems,
  getFuzzyLocalSuggestions,
  getTopListenedArtists,
  moveQueueItem,
  normalizeSongTitleKey,
  rebuildQueueForNewSelection,
} from './profileAndHistory';

test('getTopListenedArtists ranks frequent recent artists and excludes Unknown Uploader', () => {
  const artists = getTopListenedArtists([
    { id: '1', title: 'Track A', uploader: 'Daft Punk - Topic', mediaType: 'audio', timestamp: 5 },
    { id: '2', title: 'Track B', uploader: 'M83', mediaType: 'audio', timestamp: 4 },
    { id: '3', title: 'Track C', uploader: 'Unknown Uploader', mediaType: 'audio', timestamp: 3 },
    { id: '4', title: 'Track D', uploader: 'Daft Punk', mediaType: 'audio', timestamp: 2 },
  ]);

  assert.equal(artists[0], 'Daft Punk');
  assert.equal(artists[1], 'M83');
  assert.equal(artists.length, 2);
});

test('getFuzzyLocalSuggestions prioritizes prefix then substring matches across history and library', () => {
  const suggestions = getFuzzyLocalSuggestions(
    'mid',
    ['Midnight City', 'Solar Midnight'],
    ['Midnight Echoes']
  );
  assert.deepEqual(suggestions.slice(0, 2), ['Midnight City', 'Midnight Echoes']);
  assert.equal(suggestions.includes('Solar Midnight'), true);
});

test('filterDistinctRelatedItems strips remixes and versions of the current song', () => {
  const current = { id: 'orig', title: 'Blinding Lights (Official Video)' };
  assert.equal(normalizeSongTitleKey(current.title), 'blinding lights');

  const candidates: MediaItem[] = [
    { id: 'orig', url: 'u0', title: 'Blinding Lights (Official Video)', uploader: 'The Weeknd', duration: 200, thumbnail: '' },
    { id: 'remix', url: 'u1', title: 'Blinding Lights (Slowed + Reverb Remix)', uploader: 'Fan', duration: 220, thumbnail: '' },
    { id: 'live', url: 'u2', title: 'Blinding Lights [Live]', uploader: 'The Weeknd', duration: 210, thumbnail: '' },
    { id: 'sim1', url: 'u3', title: 'Save Your Tears', uploader: 'The Weeknd', duration: 215, thumbnail: '' },
    { id: 'sim2', url: 'u4', title: 'Starboy', uploader: 'The Weeknd', duration: 230, thumbnail: '' },
    { id: 'sim2-dup', url: 'u5', title: 'Starboy (Official Audio)', uploader: 'The Weeknd', duration: 230, thumbnail: '' },
  ];

  const filtered = filterDistinctRelatedItems(candidates, current, new Set());
  assert.deepEqual(
    filtered.map((c) => c.id),
    ['sim1', 'sim2']
  );
});

test('rebuildQueueForNewSelection clears stale auto tracks while preserving manual Play Next items', () => {
  const prev: PlayableTrack[] = [
    { id: 'old-1', title: 'Old Song', uploader: 'A', duration: 100, thumbnail: '', sourceUrl: 'u1', streamUrl: '', mode: 'audio', isOffline: false, queueOrigin: 'manual' },
    { id: 'auto-1', title: 'Old Auto 1', uploader: 'A', duration: 100, thumbnail: '', sourceUrl: 'u2', streamUrl: '', mode: 'audio', isOffline: false, queueOrigin: 'auto' },
    { id: 'manual-next', title: 'Pinned Next', uploader: 'B', duration: 120, thumbnail: '', sourceUrl: 'u3', streamUrl: '', mode: 'audio', isOffline: false, queueOrigin: 'manual' },
  ];

  const newTrack: PlayableTrack = {
    id: 'fresh-1',
    title: 'Fresh Song',
    uploader: 'C',
    duration: 180,
    thumbnail: '',
    sourceUrl: 'u4',
    streamUrl: '',
    mode: 'audio',
    isOffline: false,
    queueOrigin: 'manual',
  };

  const rebuilt = rebuildQueueForNewSelection(prev, 0, newTrack);
  assert.equal(rebuilt.currentIndex, 0);
  assert.deepEqual(
    rebuilt.queue.map((t) => t.id),
    ['fresh-1', 'manual-next']
  );
});

test('moveQueueItem reorders tracks and keeps currentIndex tracking the playing song', () => {
  const mk = (id: string): PlayableTrack => ({
    id,
    title: id,
    uploader: 'U',
    duration: 60,
    thumbnail: '',
    sourceUrl: '',
    streamUrl: '',
    mode: 'audio',
    isOffline: false,
  });
  const q = [mk('a'), mk('b'), mk('c')];
  const res = moveQueueItem(q, 2, 1, 0);
  assert.deepEqual(res.queue.map((t) => t.id), ['a', 'c', 'b']);
  assert.equal(res.currentIndex, 0);

  const res2 = moveQueueItem(q, 2, 0, 1);
  assert.deepEqual(res2.queue.map((t) => t.id), ['c', 'a', 'b']);
  assert.equal(res2.currentIndex, 2);
});
