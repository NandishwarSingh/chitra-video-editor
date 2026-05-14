// Local-only beat detection. Decodes an audio (or video-with-audio) file via
// OfflineAudioContext, computes per-frame energy + spectral flux, picks peaks,
// and infers a BPM from the median inter-onset interval.
//
// Algorithm:
//   1. Decode to a mono 44.1 kHz buffer.
//   2. Compute RMS energy in 1024-sample frames with 512-sample hop.
//   3. Spectral flux = positive frame-to-frame energy delta.
//   4. Adaptive threshold (k × local mean over a ~1 s window).
//   5. Local-max peak pick with a refractory period (≥ 150 ms).
//   6. BPM = 60 / median(inter-onset intervals), confined to [60, 200] BPM.
//
// This isn't a research-grade tracker, but for clean-rhythm music it picks
// kicks/snares reliably. Speech audio mostly returns very few beats — which
// is the right behaviour (don't manufacture rhythm where there is none).

import type { StoredBeatData } from './projectStore';

const FRAME_SIZE = 1024;
const HOP_SIZE = 512;
const TARGET_SAMPLE_RATE = 44_100;
const MIN_INTER_ONSET_S = 0.15; // <=> 400 BPM cap, plenty of headroom.

export type BeatDetectionResult = StoredBeatData;

export async function detectBeats(file: Blob): Promise<BeatDetectionResult> {
  const arrayBuffer = await file.arrayBuffer();

  // OfflineAudioContext is only used for decoding here — its `length` and
  // `numberOfChannels` are ignored once we pull the AudioBuffer out.
  const offlineCtx = new OfflineAudioContext(1, 1, TARGET_SAMPLE_RATE);
  const audioBuffer = await offlineCtx.decodeAudioData(arrayBuffer.slice(0));

  const mono = toMono(audioBuffer);
  const sampleRate = audioBuffer.sampleRate;
  const duration = audioBuffer.duration;

  const flux = computeSpectralFlux(mono);
  const beats = pickPeaks(flux, sampleRate);
  const bpm = inferBpm(beats);

  return {
    beats,
    bpm,
    createdAt: Date.now(),
    duration,
    sampleRate,
  };
}

function toMono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) {
    return buffer.getChannelData(0);
  }
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  const out = new Float32Array(left.length);
  for (let i = 0; i < left.length; i += 1) {
    out[i] = 0.5 * (left[i] + right[i]);
  }
  return out;
}

function computeSpectralFlux(samples: Float32Array): Float32Array {
  // We use energy flux (not true spectral flux) because it's fast, allocation-
  // free, and gives onset signal that's close enough for our purposes.
  const frameCount = Math.max(0, Math.floor((samples.length - FRAME_SIZE) / HOP_SIZE));
  const energies = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i += 1) {
    const start = i * HOP_SIZE;
    let sum = 0;
    for (let j = 0; j < FRAME_SIZE; j += 1) {
      const sample = samples[start + j];
      sum += sample * sample;
    }
    energies[i] = sum / FRAME_SIZE;
  }
  const flux = new Float32Array(frameCount);
  for (let i = 1; i < frameCount; i += 1) {
    flux[i] = Math.max(0, energies[i] - energies[i - 1]);
  }
  return flux;
}

function pickPeaks(flux: Float32Array, sampleRate: number): number[] {
  if (flux.length < 4) return [];

  // ~1 s local context, plus a small lookahead so the threshold tracks the
  // music's loudness curve rather than a single global average.
  const windowFrames = Math.max(4, Math.round((sampleRate / HOP_SIZE) | 0));
  const beats: number[] = [];
  let runningSum = 0;
  for (let i = 0; i < Math.min(windowFrames, flux.length); i += 1) runningSum += flux[i];

  for (let i = 1; i < flux.length - 1; i += 1) {
    if (i >= windowFrames) {
      runningSum += flux[i + windowFrames - 1] ?? 0;
      runningSum -= flux[i - windowFrames] ?? 0;
    }
    const localMean = runningSum / Math.min(windowFrames * 2, i + windowFrames);
    const threshold = localMean * 1.6 + 1e-6;

    if (flux[i] < threshold) continue;
    if (flux[i] <= flux[i - 1] || flux[i] <= flux[i + 1]) continue;

    const time = (i * HOP_SIZE) / sampleRate;
    if (beats.length > 0 && time - beats[beats.length - 1] < MIN_INTER_ONSET_S) continue;
    beats.push(Number(time.toFixed(4)));
  }
  return beats;
}

function inferBpm(beats: number[]): number | null {
  if (beats.length < 4) return null;
  const intervals: number[] = [];
  for (let i = 1; i < beats.length; i += 1) {
    intervals.push(beats[i] - beats[i - 1]);
  }
  intervals.sort((a, b) => a - b);
  const median = intervals[Math.floor(intervals.length / 2)];
  if (!median || !Number.isFinite(median)) return null;
  let bpm = 60 / median;
  // Sometimes peak-picking finds every other beat. Try to fold into the
  // [60, 200] BPM band — typical for popular music.
  while (bpm < 60) bpm *= 2;
  while (bpm > 200) bpm /= 2;
  return Math.round(bpm * 10) / 10;
}
