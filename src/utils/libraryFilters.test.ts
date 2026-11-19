import test from 'node:test';
import assert from 'node:assert/strict';
import { filterOfflineMediaFiles, shuffleItems } from './libraryFilters';
import type { OfflineMediaFile } from '../types/media';

function makeFakeRecord(
  id: string,
  title: string,
  mediaType: 'video' | 'audio'
): OfflineMediaFile {
  return {
    id,
    title,
    uploader: 'Artist',
    duration: 120,
    thumbnail: '',
    mediaType,
    formatLabel: mediaType === 'video' ? '720p HD MP4' : 'WAV PCM Audio',
    sizeBytes: 1024,
    createdAt: 1000,
    blob: new Blob(['test'], { type: mediaType === 'video' ? 'video/mp4' : 'audio/wav' }),
  };
}

test('filterOfflineMediaFiles filters by All/Video/Audio and title query', () => {
  const files = [
    makeFakeRecord('1', 'Midnight Tape Video', 'video'),
    makeFakeRecord('2', 'Sunrise Analog Audio', 'audio'),
    makeFakeRecord('3', 'Midnight Echo Audio', 'audio'),
  ];

  assert.equal(filterOfflineMediaFiles(files, 'all', '').length, 3);
  assert.deepEqual(
    filterOfflineMediaFiles(files, 'video', '').map((f) => f.id),
    ['1']
  );
  assert.deepEqual(
    filterOfflineMediaFiles(files, 'audio', '').map((f) => f.id),
    ['2', '3']
  );
  assert.deepEqual(
    filterOfflineMediaFiles(files, 'audio', 'midnight').map((f) => f.id),
    ['3']
  );
});

test('shuffleItems preserves all elements without mutating input array', () => {
  const input = ['a', 'b', 'c', 'd', 'e'];
  const shuffled = shuffleItems(input, () => 0.2);
  assert.deepEqual(input, ['a', 'b', 'c', 'd', 'e']);
  assert.equal(shuffled.length, 5);
  assert.deepEqual([...shuffled].sort(), [...input].sort());
});
