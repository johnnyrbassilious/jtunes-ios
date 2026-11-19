import { Mp3Encoder } from '@breezystack/lamejs';
import type { AudioBufferLike } from './audioExtractor';

function floatToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    out[i] = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
  }
  return out;
}

export function encodeAudioBufferToMp3(audioBuffer: AudioBufferLike, kbps = 192): Blob {
  const numChannels = Math.max(1, Math.min(2, audioBuffer.numberOfChannels || 1));
  const sampleRate = Math.max(8000, Math.round(audioBuffer.sampleRate || 44100));
  const encoder = new Mp3Encoder(numChannels, sampleRate, kbps);

  const leftPcm = floatToInt16(audioBuffer.getChannelData(0));
  const rightPcm =
    numChannels > 1 ? floatToInt16(audioBuffer.getChannelData(1)) : undefined;

  const mp3Chunks: Uint8Array[] = [];
  const blockSize = 1152;

  for (let i = 0; i < leftPcm.length; i += blockSize) {
    const leftChunk = leftPcm.subarray(i, i + blockSize);
    const rightChunk = rightPcm ? rightPcm.subarray(i, i + blockSize) : undefined;
    const encoded = rightChunk
      ? encoder.encodeBuffer(leftChunk, rightChunk)
      : encoder.encodeBuffer(leftChunk);
    if (encoded.length > 0) {
      mp3Chunks.push(new Uint8Array(encoded));
    }
  }

  const flushed = encoder.flush();
  if (flushed.length > 0) {
    mp3Chunks.push(new Uint8Array(flushed));
  }

  return new Blob(mp3Chunks as BlobPart[], { type: 'audio/mpeg' });
}

export async function convertBlobToMp3(inputBlob: Blob, kbps = 192): Promise<Blob> {
  if (inputBlob.type === 'audio/mpeg' || inputBlob.type === 'audio/mp3') {
    return inputBlob;
  }

  if (typeof window === 'undefined') {
    return new Blob([inputBlob], { type: 'audio/mpeg' });
  }

  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

  if (!AudioCtx) {
    return new Blob([inputBlob], { type: 'audio/mpeg' });
  }

  const audioContext = new AudioCtx();
  try {
    const buffer = await inputBlob.arrayBuffer();
    const decoded = await audioContext.decodeAudioData(buffer.slice(0));
    return encodeAudioBufferToMp3(decoded, kbps);
  } catch {
    return new Blob([inputBlob], { type: 'audio/mpeg' });
  } finally {
    await audioContext.close().catch(() => {});
  }
}
