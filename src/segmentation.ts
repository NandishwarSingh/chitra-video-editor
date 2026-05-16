// Frontend client for the SAM2/EfficientTAM segmentation sidecar
// (`POST /api/segment`). Mirrors `transcribe.ts`. v1 is synchronous: send the
// clip + a click/box prompt, get back a grayscale mask video (mask in luma)
// the caller persists to IndexedDB `MASK_STORE` and composites.

export type SegmentPrompt =
  | { frame: number; points: Array<[number, number]>; labels: number[] }
  | { frame: number; box: [number, number, number, number] };

export type SegmentResult = {
  createdAt: number;
  engine: string;
  model: string;
  device: string;
  frames: number;
  propagated: number;
  sourceFps: number;
  maskWidth: number;
  maskHeight: number;
  /** Grayscale H.264 mp4, mask in the luma plane. One Blob per object track. */
  maskVideo: Blob;
  timings: unknown;
};

type SegmentApiResponse = {
  device: string;
  engine: string;
  frames: number;
  mask_height: number;
  mask_video_base64: string;
  mask_width: number;
  model: string;
  propagated: number;
  source_fps: number;
  timings_s: unknown;
};

function base64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

export async function segmentClip(
  file: Blob,
  fileName: string,
  prompt: SegmentPrompt,
): Promise<SegmentResult> {
  const form = new FormData();
  form.append('file', file, fileName);
  form.append('prompt', JSON.stringify(prompt));

  const response = await fetch('/api/segment', { body: form, method: 'POST' });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `segmentation failed (${response.status})`);
  }

  const data = (await response.json()) as SegmentApiResponse;
  return {
    createdAt: Date.now(),
    device: data.device,
    engine: data.engine,
    frames: data.frames,
    maskHeight: data.mask_height,
    maskVideo: base64ToBlob(data.mask_video_base64, 'video/mp4'),
    maskWidth: data.mask_width,
    model: data.model,
    propagated: data.propagated,
    sourceFps: data.source_fps,
    timings: data.timings_s,
  };
}
