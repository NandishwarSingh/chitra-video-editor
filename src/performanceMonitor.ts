import { useSyncExternalStore } from 'react';

export type PerformanceSnapshot = {
  activeTranscodeJob: string | null;
  exportProgress: number;
  fps: number;
  droppedFrames: number;
  gpuPreviewActive: boolean;
  longTasks: number;
  proxyProgress: number;
  renderedTimelineItems: number;
  thumbnailCompleted: number;
  thumbnailQueued: number;
  thumbnailMs: number;
  seekMs: number;
  totalTimelineItems: number;
  transcodeMs: number;
  memoryMb: number | null;
};

type MutableSnapshot = PerformanceSnapshot & {
  frameSamples: number[];
  lastFrameTime: number;
  seekStartedAt: number | null;
  thumbnailStartedAt: number | null;
  transcodeStartedAt: number | null;
};

const initialSnapshot: MutableSnapshot = {
  activeTranscodeJob: null,
  exportProgress: 0,
  fps: 0,
  droppedFrames: 0,
  gpuPreviewActive: false,
  longTasks: 0,
  proxyProgress: 0,
  renderedTimelineItems: 0,
  thumbnailCompleted: 0,
  thumbnailQueued: 0,
  thumbnailMs: 0,
  seekMs: 0,
  totalTimelineItems: 0,
  transcodeMs: 0,
  memoryMb: null,
  frameSamples: [],
  lastFrameTime: 0,
  seekStartedAt: null,
  thumbnailStartedAt: null,
  transcodeStartedAt: null,
};

type PerformanceWithMemory = Performance & {
  memory?: {
    usedJSHeapSize: number;
  };
};

class PerformanceMonitor {
  private snapshot = { ...initialSnapshot };
  private publicSnapshot: PerformanceSnapshot = {
    activeTranscodeJob: initialSnapshot.activeTranscodeJob,
    droppedFrames: initialSnapshot.droppedFrames,
    exportProgress: initialSnapshot.exportProgress,
    fps: initialSnapshot.fps,
    gpuPreviewActive: initialSnapshot.gpuPreviewActive,
    longTasks: initialSnapshot.longTasks,
    memoryMb: initialSnapshot.memoryMb,
    proxyProgress: initialSnapshot.proxyProgress,
    renderedTimelineItems: initialSnapshot.renderedTimelineItems,
    seekMs: initialSnapshot.seekMs,
    thumbnailCompleted: initialSnapshot.thumbnailCompleted,
    thumbnailMs: initialSnapshot.thumbnailMs,
    thumbnailQueued: initialSnapshot.thumbnailQueued,
    totalTimelineItems: initialSnapshot.totalTimelineItems,
    transcodeMs: initialSnapshot.transcodeMs,
  };
  private listeners = new Set<() => void>();
  private rafId: number | null = null;
  private observer: PerformanceObserver | null = null;
  private lastFrameEmitAt = 0;

  constructor() {
    this.startFrameLoop();
    this.startLongTaskObserver();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): PerformanceSnapshot => this.publicSnapshot;

  markSeekStart() {
    this.snapshot.seekStartedAt = performance.now();
  }

  markSeekEnd() {
    if (this.snapshot.seekStartedAt === null) {
      return;
    }

    this.snapshot.seekMs = performance.now() - this.snapshot.seekStartedAt;
    this.snapshot.seekStartedAt = null;
    this.emit();
  }

  setThumbnailQueue(queued: number) {
    this.snapshot.thumbnailQueued = queued;
    this.snapshot.thumbnailStartedAt = queued > 0 ? performance.now() : null;
    this.emit();
  }

  markThumbnailComplete(count: number) {
    this.snapshot.thumbnailCompleted = count;

    if (this.snapshot.thumbnailStartedAt !== null) {
      this.snapshot.thumbnailMs = performance.now() - this.snapshot.thumbnailStartedAt;
    }

    this.emit();
  }

  markTranscodeStart(kind: 'proxy' | 'export') {
    this.snapshot.activeTranscodeJob = kind;
    this.snapshot.transcodeMs = 0;

    if (kind === 'proxy') {
      this.snapshot.proxyProgress = 0;
    } else {
      this.snapshot.exportProgress = 0;
    }

    this.snapshot.transcodeStartedAt = performance.now();
    this.emit();
  }

  markTranscodeProgress(kind: 'proxy' | 'export', progress: number) {
    const nextProgress = Math.round(Math.min(Math.max(progress, 0), 1) * 100);

    if (kind === 'proxy') {
      this.snapshot.proxyProgress = nextProgress;
    } else {
      this.snapshot.exportProgress = nextProgress;
    }

    if (this.snapshot.transcodeStartedAt !== null) {
      this.snapshot.transcodeMs = performance.now() - this.snapshot.transcodeStartedAt;
    }

    this.emit();
  }

  markTranscodeComplete(kind: 'proxy' | 'export', tookMs: number) {
    if (kind === 'proxy') {
      this.snapshot.proxyProgress = 100;
    } else {
      this.snapshot.exportProgress = 100;
    }

    this.snapshot.activeTranscodeJob = null;
    this.snapshot.transcodeMs = tookMs;
    this.snapshot.transcodeStartedAt = null;
    this.emit();
  }

  markTranscodeFailed(kind: 'proxy' | 'export') {
    if (kind === 'proxy') {
      this.snapshot.proxyProgress = 0;
    } else {
      this.snapshot.exportProgress = 0;
    }

    this.snapshot.activeTranscodeJob = null;
    this.snapshot.transcodeStartedAt = null;
    this.emit();
  }

  setGpuPreviewActive(active: boolean) {
    if (this.snapshot.gpuPreviewActive === active) {
      return;
    }

    this.snapshot.gpuPreviewActive = active;
    this.emit();
  }

  setRenderedTimelineItems(rendered: number, total: number) {
    if (this.snapshot.renderedTimelineItems === rendered && this.snapshot.totalTimelineItems === total) {
      return;
    }

    this.snapshot.renderedTimelineItems = rendered;
    this.snapshot.totalTimelineItems = total;
    this.emit();
  }

  private startFrameLoop() {
    if (typeof requestAnimationFrame !== 'function') {
      return;
    }

    const tick = (time: number) => {
      if (this.snapshot.lastFrameTime > 0) {
        const delta = time - this.snapshot.lastFrameTime;
        this.snapshot.frameSamples.push(delta);

        if (this.snapshot.frameSamples.length > 60) {
          this.snapshot.frameSamples.shift();
        }

        if (delta > 34) {
          this.snapshot.droppedFrames += 1;
        }

        const average = this.snapshot.frameSamples.reduce((sum, sample) => sum + sample, 0) / this.snapshot.frameSamples.length;
        this.snapshot.fps = average > 0 ? Math.round(1000 / average) : 0;
      }

      this.snapshot.lastFrameTime = time;
      this.updateMemory();

      if (time - this.lastFrameEmitAt > 250) {
        this.lastFrameEmitAt = time;
        this.emit();
      }

      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }

  private startLongTaskObserver() {
    if (typeof window === 'undefined' || !('PerformanceObserver' in window)) {
      return;
    }

    try {
      this.observer = new PerformanceObserver((entries) => {
        this.snapshot.longTasks += entries.getEntries().length;
        this.emit();
      });
      this.observer.observe({ entryTypes: ['longtask'] });
    } catch {
      this.observer = null;
    }
  }

  private updateMemory() {
    const memory = (performance as PerformanceWithMemory).memory;
    this.snapshot.memoryMb = memory ? Math.round(memory.usedJSHeapSize / 1024 / 1024) : null;
  }

  private emit() {
    this.publicSnapshot = {
      activeTranscodeJob: this.snapshot.activeTranscodeJob,
      exportProgress: this.snapshot.exportProgress,
      fps: this.snapshot.fps,
      droppedFrames: this.snapshot.droppedFrames,
      gpuPreviewActive: this.snapshot.gpuPreviewActive,
      longTasks: this.snapshot.longTasks,
      proxyProgress: this.snapshot.proxyProgress,
      renderedTimelineItems: this.snapshot.renderedTimelineItems,
      thumbnailCompleted: this.snapshot.thumbnailCompleted,
      thumbnailQueued: this.snapshot.thumbnailQueued,
      thumbnailMs: this.snapshot.thumbnailMs,
      seekMs: this.snapshot.seekMs,
      totalTimelineItems: this.snapshot.totalTimelineItems,
      transcodeMs: this.snapshot.transcodeMs,
      memoryMb: this.snapshot.memoryMb,
    };

    this.listeners.forEach((listener) => listener());
  }

  stop() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    this.observer?.disconnect();
  }
}

export const performanceMonitor = new PerformanceMonitor();

export function usePerformanceSnapshot() {
  return useSyncExternalStore(performanceMonitor.subscribe, performanceMonitor.getSnapshot, performanceMonitor.getSnapshot);
}
