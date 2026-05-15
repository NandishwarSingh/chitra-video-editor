// Server-side beat detection client. Talks to `POST /api/detect-beats`, which
// shells out to madmom (peak accuracy + real downbeats) or aubio (fallback).
//
// We deliberately do NOT do the analysis in the browser anymore:
//   - madmom's RNN+DBN tracker hits ~0.87 F-measure on MIREX-Ballroom and
//     ~0.74 on downbeats. A pure-JS Ellis DP port tops out around 0.71 and
//     can't track downbeats at all.
//   - Running the model server-side means no 100 MB WASM blob in the bundle
//     and no UI freeze during inference.

import type { StoredBeatData } from './projectStore';

type DetectBeatsApiResponse = {
  beats: number[];
  downbeats: number[];
  bpm: number | null;
  confidence: number;
  duration: number | null;
  provider: string;
};

export async function detectBeats(file: Blob, fileName = 'audio.bin'): Promise<StoredBeatData> {
  const form = new FormData();
  form.append('file', file, fileName);

  const response = await fetch('/api/detect-beats', { body: form, method: 'POST' });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `beat detection failed (${response.status})`);
  }

  const data = (await response.json()) as DetectBeatsApiResponse;
  return {
    beats: data.beats,
    bpm: data.bpm,
    confidence: data.confidence,
    createdAt: Date.now(),
    downbeats: data.downbeats,
    duration: data.duration ?? 0,
    provider: data.provider,
    // Sample rate is irrelevant for server-detected beats (server uses 16 kHz
    // mono internally) — we retain the field for back-compat with cached
    // browser-side results from earlier builds.
    sampleRate: 16_000,
  };
}
