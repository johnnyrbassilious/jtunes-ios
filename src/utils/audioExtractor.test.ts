import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeAudioBufferToWav } from './audioExtractor';

test('encodeAudioBufferToWav generates a valid 44-byte RIFF PCM WAV blob', async () => {
  const left = new Float32Array([0, 0.5, -0.5, 1.5, -1.5]);
  const right = new Float32Array([0.25, -0.25, 0, 1, -1]);

  const blob = encodeAudioBufferToWav({
    numberOfChannels: 2,
    sampleRate: 44100,
    length: 5,
    getChannelData: (ch: number) => (ch === 0 ? left : right),
  });

  assert.equal(blob.type, 'audio/wav');
  // 44-byte header + 5 frames * 2 channels * 2 bytes = 64 bytes
  assert.equal(blob.size, 64);

  const buf = await blob.arrayBuffer();
  const view = new DataView(buf);
  const riff = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3)
  );
  const wave = String.fromCharCode(
    view.getUint8(8),
    view.getUint8(9),
    view.getUint8(10),
    view.getUint8(11)
  );
  assert.equal(riff, 'RIFF');
  assert.equal(wave, 'WAVE');
  assert.equal(view.getUint32(4, true), 56);
  assert.equal(view.getUint16(20, true), 1); // PCM
  assert.equal(view.getUint16(22, true), 2); // Stereo
  assert.equal(view.getUint32(24, true), 44100);
  assert.equal(view.getUint16(34, true), 16); // 16-bit
  assert.equal(view.getUint32(40, true), 20); // Data byte length

  // Verify clamping at frame index 3 (+1.5 -> 32767) and index 4 (-1.5 -> -32768)
  assert.equal(view.getInt16(44 + 3 * 4, true), 32767);
  assert.equal(view.getInt16(44 + 4 * 4, true), -32768);
});
