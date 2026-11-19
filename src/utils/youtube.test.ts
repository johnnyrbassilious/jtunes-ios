import test from 'node:test';
import assert from 'node:assert/strict';
import { extractYouTubeVideoId } from './youtube';

test('extractYouTubeVideoId extracts 11-char video ID from watch, youtu.be, shorts, and fallbackId', () => {
  assert.equal(extractYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractYouTubeVideoId('https://youtu.be/jfKfPfyJRdk?si=xyz'), 'jfKfPfyJRdk');
  assert.equal(extractYouTubeVideoId('https://www.youtube.com/shorts/5qap5aO4i9A'), '5qap5aO4i9A');
  assert.equal(extractYouTubeVideoId('https://soundcloud.com/artist/song'), null);
  assert.equal(extractYouTubeVideoId('', 'jfKfPfyJRdk'), 'jfKfPfyJRdk');
});
