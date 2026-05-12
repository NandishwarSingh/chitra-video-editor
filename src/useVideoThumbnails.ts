import { useEffect, useRef, useState } from 'react';
import { createMediaFingerprint } from './mediaEngine';
import { performanceMonitor } from './performanceMonitor';
import { createThumbnailCacheKey, getCachedThumbnail, putCachedThumbnail } from './projectStore';
import type { ThumbnailWorkerResponse } from './workers/thumbnailWorker';

export type TimelineThumbnail = {
  index: number;
  src: string;
  time: number;
};

const THUMBNAIL_WIDTH = 168;
const MAX_THUMBNAILS = 120;

// When the same asset (fingerprint) is referenced by multiple clips on the
// timeline, only the first clip's hook should run the seek/encode pass.
// Subsequent hooks await the in-flight generation and then read from the
// (now populated) IndexedDB cache.
const inflightGenerationByFingerprint = new Map<string, Promise<void>>();

export type UseVideoThumbnailOptions = {
  priorityIndexes?: number[];
};

function waitForEvent(target: HTMLVideoElement, event: keyof HTMLVideoElementEventMap) {
  return new Promise<void>((resolve, reject) => {
    const onResolve = () => {
      cleanup();
      resolve();
    };
    const onReject = () => {
      cleanup();
      reject(new Error(`Video failed while waiting for ${event}`));
    };
    const cleanup = () => {
      target.removeEventListener(event, onResolve);
      target.removeEventListener('error', onReject);
    };

    target.addEventListener(event, onResolve, { once: true });
    target.addEventListener('error', onReject, { once: true });
  });
}

function waitForIdle() {
  return new Promise<void>((resolve) => {
    const requestIdleCallback = window.requestIdleCallback;

    if (requestIdleCallback) {
      requestIdleCallback(() => resolve(), { timeout: 80 });
      return;
    }

    globalThis.setTimeout(resolve, 8);
  });
}

type SeekState = { primed: boolean };

async function seek(video: HTMLVideoElement, time: number, state: SeekState) {
  if (state.primed && Math.abs(video.currentTime - time) < 0.03) {
    return;
  }

  state.primed = true;
  video.currentTime = time;
  await waitForEvent(video, 'seeked');
}

function createThumbnailWorker() {
  if (!('Worker' in window) || !('OffscreenCanvas' in window) || !('createImageBitmap' in window)) {
    return null;
  }

  return new Worker(new URL('./workers/thumbnailWorker.ts', import.meta.url), { type: 'module' });
}

function encodeWithWorker(worker: Worker, bitmap: ImageBitmap, width: number, height: number, time: number, id: number) {
  return new Promise<Blob>((resolve, reject) => {
    const onMessage = (event: MessageEvent<ThumbnailWorkerResponse>) => {
      if (event.data.id !== id) {
        return;
      }

      worker.removeEventListener('message', onMessage);

      if (event.data.type === 'error') {
        reject(new Error(event.data.message));
        return;
      }

      resolve(event.data.blob);
    };

    worker.addEventListener('message', onMessage);
    worker.postMessage({ bitmap, height, id, time, width }, [bitmap]);
  });
}

async function encodeOnMainThread(video: HTMLVideoElement, width: number, height: number) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: false });

  if (!context) {
    throw new Error('Unable to create thumbnail canvas context.');
  }

  canvas.width = width;
  canvas.height = height;
  context.drawImage(video, 0, 0, width, height);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
          return;
        }

        reject(new Error('Unable to encode thumbnail.'));
      },
      'image/jpeg',
      0.68,
    );
  });
}

export function getTimelineThumbnailCount(duration: number) {
  if (!Number.isFinite(duration) || duration <= 0) {
    return 0;
  }

  return Math.max(6, Math.min(MAX_THUMBNAILS, Math.ceil(duration / 2)));
}

export function createThumbnailTimes(duration: number) {
  const count = getTimelineThumbnailCount(duration);

  return Array.from({ length: count }, (_, index) => {
    const time = count === 1 ? 0 : (duration * index) / (count - 1);
    return Math.min(duration - 0.05, time);
  });
}

export function createPriorityThumbnailOrder(total: number, priorityIndexes: number[] = []) {
  const prioritized = new Set(priorityIndexes.filter((index) => index >= 0 && index < total));
  const ordered = [...prioritized];

  for (let index = 0; index < total; index += 1) {
    if (!prioritized.has(index)) {
      ordered.push(index);
    }
  }

  return ordered;
}

export function useVideoThumbnails(
  file: File | null,
  sourceUrl: string | null,
  duration: number,
  options: UseVideoThumbnailOptions = {},
) {
  const [thumbnails, setThumbnails] = useState<Array<TimelineThumbnail | null>>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const priorityIndexesRef = useRef<number[]>([]);
  const urlsRef = useRef<string[]>([]);

  useEffect(() => {
    priorityIndexesRef.current = options.priorityIndexes ?? [];
  }, [options.priorityIndexes]);

  useEffect(() => {
    let cancelled = false;
    let thumbnailId = 0;
    const worker = createThumbnailWorker();
    const video = document.createElement('video');
    const nextObjectUrls: string[] = [];

    urlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    urlsRef.current = [];
    setThumbnails([]);

    if (!file || !sourceUrl || !Number.isFinite(duration) || duration <= 0) {
      setIsGenerating(false);
      performanceMonitor.setThumbnailQueue(0);
      return;
    }

    const mediaFingerprint = createMediaFingerprint(file, duration);
    const url = sourceUrl;
    const times = createThumbnailTimes(duration);
    performanceMonitor.setThumbnailQueue(times.length);

    const width = THUMBNAIL_WIDTH;

    async function consumeFromCache(): Promise<Array<TimelineThumbnail | null> | null> {
      const cachedBlobs = await Promise.all(
        times.map((time) => getCachedThumbnail(createThumbnailCacheKey(mediaFingerprint, time, width))),
      );

      if (cachedBlobs.some((blob) => !blob)) {
        return null;
      }

      const built: Array<TimelineThumbnail | null> = cachedBlobs.map((blob, index) => {
        const src = URL.createObjectURL(blob as Blob);
        nextObjectUrls.push(src);
        return { index, src, time: times[index] };
      });

      return built;
    }

    async function runFullGeneration() {
      video.src = url;
      video.muted = true;
      video.preload = 'metadata';
      video.playsInline = true;

      const seekState: SeekState = { primed: false };

      await waitForEvent(video, 'loadedmetadata');

      if (cancelled) {
        return;
      }

      const aspectRatio = video.videoWidth > 0 && video.videoHeight > 0 ? video.videoWidth / video.videoHeight : 16 / 9;
      const height = Math.round(THUMBNAIL_WIDTH / aspectRatio);
      const nextThumbnails: Array<TimelineThumbnail | null> = Array.from({ length: times.length }, () => null);
      const order = createPriorityThumbnailOrder(times.length, priorityIndexesRef.current);
      let completed = 0;

      for (const index of order) {
        if (cancelled) {
          return;
        }

        const time = times[index];
        const cacheKey = createThumbnailCacheKey(mediaFingerprint, time, width);
        let blob = await getCachedThumbnail(cacheKey);

        if (!blob) {
          await seek(video, time, seekState);

          if (cancelled) {
            return;
          }

          if (worker && 'createImageBitmap' in window) {
            try {
              const bitmap = await createImageBitmap(video);
              blob = await encodeWithWorker(worker, bitmap, width, height, time, thumbnailId);
            } catch {
              blob = await encodeOnMainThread(video, width, height);
            }
          } else {
            blob = await encodeOnMainThread(video, width, height);
          }

          await putCachedThumbnail(cacheKey, blob);
        }

        if (cancelled) {
          return;
        }

        const src = URL.createObjectURL(blob);
        nextObjectUrls.push(src);
        nextThumbnails[index] = { index, src, time };
        thumbnailId += 1;
        completed += 1;
        performanceMonitor.markThumbnailComplete(completed);

        if (completed <= 2 || completed % 3 === 0 || completed === times.length) {
          setThumbnails([...nextThumbnails]);
          await waitForIdle();
        }
      }
    }

    async function generate() {
      setIsGenerating(true);

      // Wait for any other in-flight generation for this fingerprint so the
      // IDB cache is populated. This avoids duplicate seek/encode passes when
      // many clips share the same asset.
      const inflight = inflightGenerationByFingerprint.get(mediaFingerprint);
      if (inflight) {
        try {
          await inflight;
        } catch {
          // primary generator failed — fall through and try our own path
        }
      }

      if (cancelled) {
        return;
      }

      // Best case: every thumbnail is already cached → no video decode pass.
      const cached = await consumeFromCache();
      if (cancelled) {
        return;
      }
      if (cached) {
        setThumbnails(cached);
        performanceMonitor.markThumbnailComplete(cached.length);
        setIsGenerating(false);
        return;
      }

      // No prior cache. Run the full pass and register so concurrent hooks
      // know to wait.
      const generation = runFullGeneration();
      inflightGenerationByFingerprint.set(mediaFingerprint, generation);
      try {
        await generation;
      } finally {
        if (inflightGenerationByFingerprint.get(mediaFingerprint) === generation) {
          inflightGenerationByFingerprint.delete(mediaFingerprint);
        }
      }

      setIsGenerating(false);
    }

    generate().catch(() => {
      if (!cancelled) {
        setIsGenerating(false);
      }
    });

    return () => {
      cancelled = true;
      worker?.terminate();
      video.removeAttribute('src');
      video.load();
      nextObjectUrls.forEach((url) => URL.revokeObjectURL(url));
      urlsRef.current = [];
      performanceMonitor.setThumbnailQueue(0);
    };
  }, [duration, file, sourceUrl]);

  useEffect(() => {
    urlsRef.current = thumbnails.flatMap((thumbnail) => (thumbnail ? [thumbnail.src] : []));
  }, [thumbnails]);

  return { thumbnails, isGenerating };
}
