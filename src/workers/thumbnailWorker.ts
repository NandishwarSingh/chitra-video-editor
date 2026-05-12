export type ThumbnailWorkerRequest = {
  bitmap: ImageBitmap;
  height: number;
  id: number;
  time: number;
  width: number;
};

export type ThumbnailWorkerResponse =
  | {
      blob: Blob;
      id: number;
      time: number;
      tookMs: number;
      type: 'thumbnail';
    }
  | {
      id: number;
      message: string;
      type: 'error';
    };

const worker = self as unknown as {
  onmessage: ((event: MessageEvent<ThumbnailWorkerRequest>) => void) | null;
  postMessage: (message: ThumbnailWorkerResponse) => void;
};

worker.onmessage = async (event: MessageEvent<ThumbnailWorkerRequest>) => {
  const startedAt = performance.now();
  const { bitmap, height, id, time, width } = event.data;

  try {
    if (!('OffscreenCanvas' in worker)) {
      bitmap.close();
      worker.postMessage({
        id,
        message: 'OffscreenCanvas is not available in this browser.',
        type: 'error',
      } satisfies ThumbnailWorkerResponse);
      return;
    }

    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { alpha: false });

    if (!context) {
      bitmap.close();
      worker.postMessage({
        id,
        message: 'Unable to create thumbnail canvas context.',
        type: 'error',
      } satisfies ThumbnailWorkerResponse);
      return;
    }

    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const blob = await canvas.convertToBlob({
      quality: 0.68,
      type: 'image/jpeg',
    });

    worker.postMessage({
      blob,
      id,
      time,
      tookMs: performance.now() - startedAt,
      type: 'thumbnail',
    } satisfies ThumbnailWorkerResponse);
  } catch (error) {
    bitmap.close();
    worker.postMessage({
      id,
      message: error instanceof Error ? error.message : 'Thumbnail worker failed.',
      type: 'error',
    } satisfies ThumbnailWorkerResponse);
  }
};
