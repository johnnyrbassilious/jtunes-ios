import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EQ_BANDS,
  EQ_PRESETS,
  clampEqGain,
  detectActiveEqPreset,
} from './equalizer';

test('EQ_BANDS defines the 5 required peaking frequencies', () => {
  assert.deepEqual(
    EQ_BANDS.map((b) => b.freq),
    [60, 230, 910, 3600, 14000]
  );
  assert.deepEqual(
    EQ_BANDS.map((b) => b.label),
    ['60Hz', '230Hz', '910Hz', '3.6kHz', '14kHz']
  );
});

test('clampEqGain clamps gains within [-12, +12] dB in 0.5 dB steps', () => {
  assert.equal(clampEqGain(-20), -12);
  assert.equal(clampEqGain(20), 12);
  assert.equal(clampEqGain(4.2), 4);
  assert.equal(clampEqGain(4.3), 4.5);
  assert.equal(clampEqGain(Number.NaN), 0);
});

test('detectActiveEqPreset recognizes presets and custom curves', () => {
  assert.equal(detectActiveEqPreset(EQ_PRESETS.Flat), 'Flat');
  assert.equal(detectActiveEqPreset(EQ_PRESETS['Bass Boost']), 'Bass Boost');
  assert.equal(detectActiveEqPreset(EQ_PRESETS.Vocal), 'Vocal');
  assert.equal(detectActiveEqPreset(EQ_PRESETS['Piano / Acoustic']), 'Piano / Acoustic');
  assert.equal(detectActiveEqPreset([1, 2, 3, 4, 5]), 'Custom');
});
