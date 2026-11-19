export interface AudioBufferLike {
  numberOfChannels: number;
  sampleRate: number;
  length: number;
  getChannelData(channel: number): Float32Array;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

export function encodeAudioBufferToWav(audioBuffer: AudioBufferLike): Blob {
  const numChannels = Math.max(1, Math.min(2, audioBuffer.numberOfChannels || 1));
  const sampleRate = Math.max(8000, Math.round(audioBuffer.sampleRate || 44100));
  const numFrames = audioBuffer.length;
  const bytesPerSample = 2; // 16-bit PCM
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numFrames * blockAlign;
  const totalBufferLength = 44 + dataSize;

  const arrayBuffer = new ArrayBuffer(totalBufferLength);
  const view = new DataView(arrayBuffer);

  // RIFF chunk descriptor
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');

  // fmt sub-chunk
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM subchunk size
  view.setUint16(20, 1, true); // Linear PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // Bits per sample

  // data sub-chunk
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) {
    channels.push(audioBuffer.getChannelData(ch));
  }

  let writeOffset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = channels[ch][i] ?? 0;
      const clamped = Math.max(-1, Math.min(1, sample));
      const int16 = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
      view.setInt16(writeOffset, int16, true);
      writeOffset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

export async function extractWavFromMediaBlob(mediaBlob: Blob): Promise<Blob> {
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

  if (!AudioCtx) {
    throw new Error('Web Audio API (AudioContext) is not available in this browser.');
  }

  const rawBuffer = await mediaBlob.arrayBuffer();
  const audioContext = new AudioCtx();

  try {
    const decodedBuffer = await audioContext.decodeAudioData(rawBuffer.slice(0));
    return encodeAudioBufferToWav(decodedBuffer);
  } catch (err) {
    throw new Error(
      err instanceof Error
        ? `Client-side audio decoding failed: ${err.message}`
        : 'Client-side audio decoding failed for this media stream.'
    );
  } finally {
    await audioContext.close().catch(() => {});
  }
}
