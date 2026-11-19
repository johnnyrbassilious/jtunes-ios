import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCENT_THEMES, getAccentThemePreset } from './theme';

test('ACCENT_THEMES provides 6 presets and falls back cleanly', () => {
  assert.equal(ACCENT_THEMES.length, 6);
  assert.equal(getAccentThemePreset('emerald').accent, '#10b981');
  assert.equal(getAccentThemePreset('violet').accent, '#8b5cf6');
  assert.equal(getAccentThemePreset('monochrome').text, '#09090b');
});
