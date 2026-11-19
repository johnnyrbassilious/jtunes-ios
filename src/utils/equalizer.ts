export interface EqBandDefinition {
  index: number;
  freq: number;
  label: string;
}

export const EQ_BANDS: readonly EqBandDefinition[] = [
  { index: 0, freq: 60, label: '60Hz' },
  { index: 1, freq: 230, label: '230Hz' },
  { index: 2, freq: 910, label: '910Hz' },
  { index: 3, freq: 3600, label: '3.6kHz' },
  { index: 4, freq: 14000, label: '14kHz' },
] as const;

export type EqGains = [number, number, number, number, number];

export type EqPresetName = 'Flat' | 'Bass Boost' | 'Vocal' | 'Piano / Acoustic';

export const EQ_PRESETS: Record<EqPresetName, EqGains> = {
  Flat: [0, 0, 0, 0, 0],
  'Bass Boost': [7, 5, 0, -1, 1],
  Vocal: [-3, -1, 4, 5, 2],
  'Piano / Acoustic': [3, 2, 1, 3, 4],
};

export const EQ_PRESET_NAMES: readonly EqPresetName[] = [
  'Flat',
  'Bass Boost',
  'Vocal',
  'Piano / Acoustic',
] as const;

export function clampEqGain(gainDb: number): number {
  if (!Number.isFinite(gainDb)) {
    return 0;
  }
  return Math.max(-12, Math.min(12, Math.round(gainDb * 2) / 2));
}

export function detectActiveEqPreset(gains: readonly number[]): EqPresetName | 'Custom' {
  for (const name of EQ_PRESET_NAMES) {
    const preset = EQ_PRESETS[name];
    if (preset.every((val, idx) => Math.abs((gains[idx] ?? 0) - val) < 0.01)) {
      return name;
    }
  }
  return 'Custom';
}

interface EqAudioGraph {
  context: AudioContext;
  source: MediaElementAudioSourceNode;
  filters: BiquadFilterNode[];
}

const elementGraphMap = new WeakMap<HTMLMediaElement, EqAudioGraph>();

export function ensureEqualizerGraph(
  mediaElement: HTMLMediaElement,
  initialGains: EqGains
): EqAudioGraph | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const existing = elementGraphMap.get(mediaElement);
  if (existing) {
    if (existing.context.state === 'suspended') {
      void existing.context.resume().catch(() => {});
    }
    return existing;
  }

  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) {
    return null;
  }

  try {
    const context = new AudioCtx();
    const source = context.createMediaElementSource(mediaElement);
    const filters = EQ_BANDS.map((band, idx) => {
      const filter = context.createBiquadFilter();
      filter.type = 'peaking';
      filter.frequency.value = band.freq;
      filter.Q.value = 1.4;
      filter.gain.value = clampEqGain(initialGains[idx] ?? 0);
      return filter;
    });

    // Wire chain: source -> 60Hz -> 230Hz -> 910Hz -> 3.6kHz -> 14kHz -> destination
    let prevNode: AudioNode = source;
    for (const filter of filters) {
      prevNode.connect(filter);
      prevNode = filter;
    }
    prevNode.connect(context.destination);

    if (context.state === 'suspended') {
      void context.resume().catch(() => {});
    }

    const graph: EqAudioGraph = { context, source, filters };
    elementGraphMap.set(mediaElement, graph);
    return graph;
  } catch {
    return null;
  }
}

export function applyEqualizerGains(
  mediaElement: HTMLMediaElement | null,
  gains: EqGains
): void {
  if (!mediaElement) {
    return;
  }
  const graph = ensureEqualizerGraph(mediaElement, gains);
  if (!graph) {
    return;
  }
  const now = graph.context.currentTime;
  graph.filters.forEach((filter, idx) => {
    const target = clampEqGain(gains[idx] ?? 0);
    if (typeof filter.gain.setTargetAtTime === 'function') {
      filter.gain.setTargetAtTime(target, now, 0.015);
    } else {
      filter.gain.value = target;
    }
  });
}

export function resumeEqualizerContext(mediaElement: HTMLMediaElement | null, gains: EqGains): void {
  if (!mediaElement) {
    return;
  }
  const graph = ensureEqualizerGraph(mediaElement, gains);
  if (graph && graph.context.state === 'suspended') {
    void graph.context.resume().catch(() => {});
  }
}
