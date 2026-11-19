import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDuration,
  formatBytes,
  formatMegabytes,
  isHttpUrl,
  normalizeBackendUrl,
  detectPlatform,
  sanitizeFilename,
} from './formatters';

test('formatDuration formats seconds as mm:ss and h:mm:ss', () => {
  assert.equal(formatDuration(0), '00:00');
  assert.equal(formatDuration(-5), '00:00');
  assert.equal(formatDuration(Number.NaN), '00:00');
  assert.equal(formatDuration(65), '01:05');
  assert.equal(formatDuration(599), '09:59');
  assert.equal(formatDuration(3661), '1:01:01');
});

test('formatBytes and formatMegabytes format byte counts accurately', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.00 MB');
  assert.equal(formatMegabytes(0), '0.00 MB');
  assert.equal(formatMegabytes(1572864), '1.50 MB');
});

test('isHttpUrl identifies http/https URLs and rejects plain search queries', () => {
  assert.equal(isHttpUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), true);
  assert.equal(isHttpUrl('  http://soundcloud.com/artist/track  '), true);
  assert.equal(isHttpUrl('lofi beats to study to'), false);
  assert.equal(isHttpUrl('ftp://example.com/file'), false);
});

test('normalizeBackendUrl trims whitespace and trailing slashes', () => {
  assert.equal(
    normalizeBackendUrl('  https://tubidy-vercel-api.vercel.app///  '),
    'https://tubidy-vercel-api.vercel.app'
  );
});

test('detectPlatform recognizes supported media hosts', () => {
  assert.equal(detectPlatform('https://youtu.be/abc'), 'YouTube');
  assert.equal(detectPlatform('https://www.tiktok.com/@user/video/1'), 'TikTok');
  assert.equal(detectPlatform('https://www.instagram.com/reel/abc'), 'Instagram');
  assert.equal(detectPlatform('https://soundcloud.com/a/b'), 'SoundCloud');
  assert.equal(detectPlatform('https://x.com/user/status/1'), 'X');
  assert.equal(detectPlatform('https://example.org/media'), 'Web');
});

test('sanitizeFilename strips invalid filename characters', () => {
  assert.equal(sanitizeFilename('Track: "One" / Two?', 'mp3'), 'Track One Two.mp3');
  assert.equal(sanitizeFilename('   ', 'mp4'), 'tubidy-fm-media.mp4');
});
