import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeAudioBufferToMp3 } from './mp3Encoder';

test('encodeAudioBufferToMp3 encodes Float32 PCM samples to a valid audio/mpeg Blob', async () => {
  const sampleRate = 44100;
  const length = 4410; // 0.1s sine tone
  const channel = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    channel[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.5;
  }

  const mp3Blob = encodeAudioBufferToMp3(
    {
      numberOfChannels: 1,
      sampleRate,
      length,
      getChannelData: () => channel,
    },
    192
  );

  assert.equal(mp3Blob.type, 'audio/mpeg');
  assert.ok(mp3Blob.size > 100);

  const bytes = new Uint8Array(await mp3Blob.arrayBuffer());
  // Valid MP3 frame sync header starts with 0xFF 0xE0..0xFF or ID3 tag
  const hasFrameSync = bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
  assert.equal(hasFrameSync, true);
});
