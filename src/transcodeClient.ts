import type { EffectSettings } from './effects';
import type { TimelineExportClip, TimelineExportTextOverlay } from './transcodeCommands';

export type TranscodeKind = 'generate-proxy' | 'export-mp4' | 'export-timeline-mp4';

export type TranscodeProgress = {
  progress: number;
  time: number;
};

export type TranscodeComplete = {
  blob: Blob;
  kind: TranscodeKind;
  outputBytes: number;
  tookMs: number;
};

export type RunTranscodeJobOptions = {
  assets?: Array<{ file: File; id: string; kind?: 'audio' | 'video' }>;
  clips?: TimelineExportClip[];
  duration?: number;
  effects?: EffectSettings;
  file?: File;
  inPoint?: number;
  kind: TranscodeKind;
  onProgress?: (progress: TranscodeProgress) => void;
  outputFps?: number;
  outputHeight?: number;
  outputWidth?: number;
  outPoint?: number;
  targetHeight?: number;
  textOverlays?: TimelineExportTextOverlay[];
};

export type RunningTranscodeJob = {
  cancel: () => void;
  promise: Promise<TranscodeComplete>;
};

type TranscodeWorkerMessage =
  | {
      type: 'progress';
      jobId: string;
      progress: number;
      time: number;
    }
  | {
      type: 'complete';
      jobId: string;
      blob: Blob;
      kind: TranscodeKind;
      outputBytes: number;
      tookMs: number;
    }
  | {
      type: 'error';
      jobId: string;
      message: string;
    };

function createTranscodeWorker() {
  return new Worker(new URL('./workers/transcodeWorker.ts', import.meta.url), { type: 'module' });
}

export function runTranscodeJob({
  assets = [],
  clips = [],
  duration,
  effects,
  file,
  inPoint = 0,
  kind,
  onProgress,
  outputFps,
  outputHeight,
  outputWidth,
  outPoint = 0,
  targetHeight = 720,
  textOverlays = [],
}: RunTranscodeJobOptions): RunningTranscodeJob {
  const worker = createTranscodeWorker();
  const sourceName = file?.name ?? `${assets.length}-assets`;
  const sourceModified = file?.lastModified ?? Date.now();
  const jobId = `${kind}:${sourceName}:${sourceModified}:${Date.now()}`;
  let rejectPromise: ((reason?: unknown) => void) | null = null;

  const promise = new Promise<TranscodeComplete>((resolve, reject) => {
    rejectPromise = reject;
    worker.onmessage = (event: MessageEvent<TranscodeWorkerMessage>) => {
      const message = event.data;

      if (message.jobId !== jobId) {
        return;
      }

      if (message.type === 'progress') {
        onProgress?.({
          progress: Math.min(Math.max(message.progress || 0, 0), 1),
          time: message.time || 0,
        });
        return;
      }

      worker.terminate();

      if (message.type === 'error') {
        reject(new Error(message.message));
        return;
      }

      resolve({
        blob: message.blob,
        kind: message.kind,
        outputBytes: message.outputBytes,
        tookMs: message.tookMs,
      });
    };

    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || 'Transcode worker failed.'));
    };

    worker.postMessage({
      assets,
      clips,
      duration,
      effects,
      file,
      inPoint,
      jobId,
      kind,
      outputFps,
      outputHeight,
      outputWidth,
      outPoint,
      targetHeight,
      textOverlays,
      type: 'run',
    });
  });

  return {
    cancel: () => {
      worker.postMessage({ jobId, type: 'cancel' });
      worker.terminate();
      rejectPromise?.(new DOMException('Transcode job cancelled.', 'AbortError'));
    },
    promise,
  };
}
