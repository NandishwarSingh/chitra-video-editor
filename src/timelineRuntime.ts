import { MutableRefObject, useCallback, useEffect, useRef } from 'react';
import { performanceMonitor } from './performanceMonitor';

type VideoElementWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: VideoFrameRequestCallback) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export type TimelineRuntimeOptions = {
  duration: number;
  getCurrentTimelineTime?: () => number | null;
  hasMedia: boolean;
  inPoint: number;
  isPlaying: boolean;
  loopRange: boolean;
  outPoint: number;
  pixelOffset?: number;
  pixelsPerSecond?: number;
  playhead: number;
  setIsPlaying: (isPlaying: boolean) => void;
  setPlayhead: (time: number | ((previous: number) => number)) => void;
  timelineTimeToVideoTime?: (time: number) => number | null;
  videoRef: MutableRefObject<HTMLVideoElement | null>;
};

export function useTimelineRuntime({
  duration,
  getCurrentTimelineTime,
  hasMedia,
  inPoint,
  isPlaying,
  loopRange,
  outPoint,
  pixelOffset = 0,
  pixelsPerSecond,
  playhead,
  setIsPlaying,
  setPlayhead,
  timelineTimeToVideoTime,
  videoRef,
}: TimelineRuntimeOptions) {
  const playheadRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const visualTimeRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const videoFrameRef = useRef<number | null>(null);
  const lastCommitRef = useRef(0);

  const applyVisualTime = useCallback(
    (time: number) => {
      const trackWidth = playheadRef.current?.parentElement?.clientWidth ?? 0;
      const contentWidth = Math.max(1, trackWidth - pixelOffset);
      const rawX = pixelOffset + (pixelsPerSecond ? time * pixelsPerSecond : contentWidth * ((duration > 0 ? time / duration : 0)));
      const x = trackWidth > 0 ? Math.min(Math.max(rawX, 1), Math.max(1, trackWidth - 1)) : 1;
      const progress = contentWidth > 0 ? (x - pixelOffset) / contentWidth : duration > 0 ? time / duration : 0;

      visualTimeRef.current = time;

      if (playheadRef.current) {
        playheadRef.current.style.transform = `translate3d(${x}px, 0, 0) translateX(-50%)`;
      }

      if (progressRef.current) {
        progressRef.current.style.transform = `scaleX(${Math.min(Math.max(progress, 0), 1)})`;
      }
    },
    [duration, pixelOffset, pixelsPerSecond],
  );

  const commitCoarseTime = useCallback(
    (time: number) => {
      const now = performance.now();

      if (now - lastCommitRef.current < 80) {
        return;
      }

      lastCommitRef.current = now;
      setPlayhead((previous) => (Math.abs(previous - time) > 0.02 ? time : previous));
    },
    [setPlayhead],
  );

  const cancelLoops = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    const video = videoRef.current as VideoElementWithFrameCallback | null;

    if (videoFrameRef.current !== null && video?.cancelVideoFrameCallback) {
      video.cancelVideoFrameCallback(videoFrameRef.current);
      videoFrameRef.current = null;
    }
  }, [videoRef]);

  const syncFromVideo = useCallback(() => {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    const currentTime = getCurrentTimelineTime?.() ?? video.currentTime;

    if (currentTime >= outPoint && outPoint > inPoint) {
      if (loopRange) {
        const videoTime = timelineTimeToVideoTime?.(inPoint) ?? inPoint;
        if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
          video.currentTime = videoTime;
        }
        applyVisualTime(inPoint);
        setPlayhead(inPoint);
        return;
      }

      video.pause();
      const videoTime = timelineTimeToVideoTime?.(outPoint) ?? outPoint;
      if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
        video.currentTime = videoTime;
      }
      applyVisualTime(outPoint);
      setIsPlaying(false);
      setPlayhead(outPoint);
      return;
    }

    applyVisualTime(currentTime);
    commitCoarseTime(currentTime);
  }, [
    applyVisualTime,
    commitCoarseTime,
    getCurrentTimelineTime,
    inPoint,
    loopRange,
    outPoint,
    setIsPlaying,
    setPlayhead,
    timelineTimeToVideoTime,
    videoRef,
  ]);

  useEffect(() => {
    if (!isPlaying) {
      applyVisualTime(playhead);
    }
  }, [applyVisualTime, isPlaying, playhead]);

  useEffect(() => {
    if (!isPlaying || !hasMedia) {
      cancelLoops();
      return;
    }

    const video = videoRef.current as VideoElementWithFrameCallback | null;

    if (!video) {
      return;
    }

    if (video.requestVideoFrameCallback) {
      const onVideoFrame: VideoFrameRequestCallback = () => {
        syncFromVideo();
        videoFrameRef.current = video.requestVideoFrameCallback?.(onVideoFrame) ?? null;
      };

      videoFrameRef.current = video.requestVideoFrameCallback(onVideoFrame);
    } else {
      const tick = () => {
        syncFromVideo();
        rafRef.current = requestAnimationFrame(tick);
      };

      rafRef.current = requestAnimationFrame(tick);
    }

    return cancelLoops;
  }, [cancelLoops, hasMedia, isPlaying, syncFromVideo, videoRef]);

  const seekTo = useCallback(
    (time: number) => {
      const nextTime = Math.min(Math.max(time, 0), duration || 0);
      const video = videoRef.current;

      performanceMonitor.markSeekStart();
      applyVisualTime(nextTime);
      setPlayhead(nextTime);

      const videoTime = timelineTimeToVideoTime?.(nextTime) ?? nextTime;

      if (video && Number.isFinite(videoTime) && video.readyState >= HTMLMediaElement.HAVE_METADATA) {
        video.currentTime = videoTime;
      }
    },
    [applyVisualTime, duration, setPlayhead, timelineTimeToVideoTime, videoRef],
  );

  const getVisualTime = useCallback(() => visualTimeRef.current, []);

  const markSeekEnd = useCallback(() => {
    performanceMonitor.markSeekEnd();

    const video = videoRef.current;

    const timelineTime = getCurrentTimelineTime?.() ?? video?.currentTime;

    if (video && timelineTime !== undefined && timelineTime !== null) {
      applyVisualTime(timelineTime);
      setPlayhead(timelineTime);
    }
  }, [applyVisualTime, getCurrentTimelineTime, setPlayhead, videoRef]);

  return {
    applyVisualTime,
    getVisualTime,
    markSeekEnd,
    playheadRef,
    progressRef,
    seekTo,
  };
}
