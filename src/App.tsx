import {
  Activity,
  ArrowLeft,
  Copy,
  Download,
  FileArchive,
  Film,
  FolderOpen,
  Magnet,
  Maximize2,
  Music,
  Pause,
  Pencil,
  Play,
  Plus,
  Scissors,
  Search,
  Settings,
  StepBack,
  StepForward,
  Trash2,
  Type,
  Upload,
  Volume2,
  VolumeX,
  Wand2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ChangeEvent,
  CSSProperties,
  Dispatch,
  DragEvent as ReactDragEvent,
  KeyboardEvent,
  PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { ChatPanel } from './ChatPanel';
import { DEFAULT_EFFECT_SETTINGS, hasActiveEffects } from './effects';
import { createEditArrayFromRuntime, stringifyEditArray } from './editArrayLanguage';
import {
  createMediaFingerprint,
  createTypedMediaFile,
  detectMediaCapabilities,
  detectMediaKind,
  isSupportedMediaFile,
  shouldUsePreviewProxy,
} from './mediaEngine';
import { performanceMonitor, usePerformanceSnapshot } from './performanceMonitor';
import { usePreviewCompositor } from './previewCompositor';
import {
  DEFAULT_TEXT_TRACK_ID,
  collectSnapTargets,
  getActiveTextOverlays,
  getAssetById,
  getAudioClipsAtTime,
  getAudioTracksTopFirst,
  getClipAtTime,
  getClipDuration,
  getClipEnd,
  getDefaultAudioTrackId,
  getDefaultVideoTrackId,
  getFirstClipByTimelineOrder,
  getNextClipAfter,
  getNextTrackIndex,
  getProjectDuration,
  getSelectedClip,
  getSelectedText,
  getTrackById,
  getVideoClipsAtTime,
  getVideoTracksTopFirst,
  idleJobStatus,
  projectReducer,
  snapToTarget,
  type ClipTransform,
  type JobStatus,
  type ProjectAsset,
  type ProjectPresent,
  type TextOverlay,
  type TimelineClip,
  type TimelineTrack,
} from './projectModel';
import {
  PROJECT_PRESETS,
  createBlankProjectRecord,
  createProjectPackage,
  deleteStoredProject,
  duplicateStoredProject,
  deleteRuntimeAssetBlobs,
  hydrateProjectRecord,
  importProjectPackage,
  isProjectFullyHydrated,
  saveRuntimeProjectRecord,
  storeRuntimeAssetBlobs,
  storeRuntimePoster,
  type HydratedProject,
  type ProjectRecord,
  type ProjectSettings,
} from './projectPersistence';
import { createProxyCacheKey, deleteCachedProxy, getCachedProxy, listProjectRecords, putCachedProxy, putJobMetadata, putProjectRecord } from './projectStore';
import { runTranscodeJob } from './transcodeClient';
import { clamp, formatBytes, formatClock } from './time';
import { isClipReorderDrag } from './timelineInteractions';
import { useTimelineRuntime } from './timelineRuntime';
import { getTimelineCellWidth, getVirtualTimelineWidth } from './timelineVirtualization';
import { useVideoThumbnails, type TimelineThumbnail } from './useVideoThumbnails';

type DragMode =
  | { type: 'clip-move'; clipId: string; startTimelineStart: number; startTrackId: string; startX: number; startY: number }
  | { type: 'playhead'; wasPlaying: boolean }
  | { clipId: string; startTransform: ClipTransform; startX: number; startY: number; type: 'preview-clip-move' }
  | { clipId: string; startScale: number; startX: number; type: 'preview-clip-scale' }
  | { startEnd: number; startStart: number; startTrackId: string; startX: number; startY: number; textId: string; type: 'timeline-text-move' }
  | { startSize: number; startX: number; textId: string; type: 'preview-text-scale' }
  | { startTextX: number; startTextY: number; startX: number; startY: number; textId: string; type: 'preview-text-move' }
  | { type: 'trim-end'; clipId: string }
  | { type: 'trim-start'; clipId: string }
  | { type: 'text-trim-end'; textId: string }
  | { type: 'text-trim-start'; textId: string }
  | null;

type LoadedMetadata = {
  duration: number;
  height: number;
  posterUrl: string | null;
  width: number;
};

type FileWithRelativePath = File & {
  webkitRelativePath?: string;
};

type WindowWithWebKitAudioContext = Window &
  typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };

const FRAME_STEP = 1 / 30;
const ASSET_DRAG_TYPE = 'application/x-chitra-asset-id';
const SCRUB_PREVIEW_SEEK_INTERVAL_MS = 80;
const CLIP_REORDER_DRAG_THRESHOLD_PX = 6;
const TIMELINE_PIXELS_PER_SECOND = 92;
const TIMELINE_MIN_WIDTH = 760;
const TIMELINE_RULER_HEIGHT = 34;
const TIMELINE_TRACK_TOP = 42;
const TIMELINE_TRACK_HEIGHT = 64;
const TIMELINE_AUDIO_TRACK_HEIGHT = 48;
const TIMELINE_TRACK_GAP = 8;
const TIMELINE_TEXT_TRACK_HEIGHT = 42;
const TIMELINE_LABEL_WIDTH = 116;
const MAX_TIMELINE_CLIP_THUMBNAILS = 14;
// MediaElementAudioSourceNode can only be created ONCE per media element. The
// constructor throws on subsequent attempts, so we cache per element.
const mediaElementAudioSources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();

function createId(prefix: string) {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getImportedFileName(file: File) {
  return (file as FileWithRelativePath).webkitRelativePath?.trim() || file.name;
}

function getAudioContextConstructor() {
  return window.AudioContext ?? (window as WindowWithWebKitAudioContext).webkitAudioContext ?? null;
}

const AUDIO_METER_FLOOR_DB = -60;

function amplitudeToDbfs(amplitude: number) {
  if (!Number.isFinite(amplitude) || amplitude <= 0.000_125) {
    return AUDIO_METER_FLOOR_DB;
  }

  return Math.max(AUDIO_METER_FLOOR_DB, Math.min(0, 20 * Math.log10(amplitude)));
}

function dbfsToMeterPosition(dBFS: number) {
  return clamp(1 + dBFS / Math.abs(AUDIO_METER_FLOOR_DB), 0, 1);
}

function formatAudioMeterDb(dBFS: number) {
  if (dBFS <= AUDIO_METER_FLOOR_DB + 0.5) {
    return '-inf';
  }

  return `${Math.round(dBFS)} dB`;
}

function createAsset(file: File): ProjectAsset {
  const mediaFile = createTypedMediaFile(file, file.name, file.lastModified, file.type);
  const originalUrl = URL.createObjectURL(mediaFile);

  return {
    duration: 0,
    file: mediaFile,
    height: 0,
    id: createId('asset'),
    kind: detectMediaKind({ name: mediaFile.name, type: mediaFile.type }),
    name: getImportedFileName(file),
    originalUrl,
    playbackUrl: originalUrl,
    posterUrl: null,
    proxyStatus: idleJobStatus,
    proxyUrl: null,
    size: mediaFile.size,
    type: mediaFile.type,
    width: 0,
  };
}

function isClipTransformFullScreen(transform: ClipTransform): boolean {
  return (
    Math.abs(transform.x - 0.5) < 0.01 &&
    Math.abs(transform.y - 0.5) < 0.01 &&
    transform.scale >= 0.999
  );
}

function loadVideoMetadata(url: string): Promise<LoadedMetadata> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';

    const cleanup = () => {
      video.onloadedmetadata = null;
      video.onloadeddata = null;
      video.onerror = null;
    };

    video.onerror = () => {
      cleanup();
      reject(new Error('Unable to read video metadata.'));
    };

    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      const width = video.videoWidth || 0;
      const height = video.videoHeight || 0;

      video.onloadeddata = () => {
        let posterUrl: string | null = null;

        try {
          const canvas = document.createElement('canvas');
          const ratio = width && height ? width / height : 16 / 9;
          canvas.width = 220;
          canvas.height = Math.round(canvas.width / ratio);
          const context = canvas.getContext('2d');
          context?.drawImage(video, 0, 0, canvas.width, canvas.height);
          posterUrl = canvas.toDataURL('image/jpeg', 0.72);
        } catch {
          posterUrl = null;
        }

        cleanup();
        resolve({ duration, height, posterUrl, width });
      };

      try {
        video.currentTime = Math.min(0.2, Math.max(0, duration - 0.05));
      } catch {
        cleanup();
        resolve({ duration, height, posterUrl: null, width });
      }
    };

    video.src = url;
  });
}

function loadAudioMetadata(url: string): Promise<LoadedMetadata> {
  return new Promise((resolve, reject) => {
    const audio = document.createElement('audio');
    audio.preload = 'metadata';

    const cleanup = () => {
      audio.onloadedmetadata = null;
      audio.onerror = null;
    };

    audio.onerror = () => {
      cleanup();
      reject(new Error('Unable to read audio metadata.'));
    };

    audio.onloadedmetadata = () => {
      const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
      cleanup();
      resolve({ duration, height: 0, posterUrl: null, width: 0 });
    };

    audio.src = url;
  });
}

async function assertPlayableVideoUrl(url: string) {
  const metadata = await loadVideoMetadata(url);

  if (metadata.duration <= 0 || metadata.width <= 0 || metadata.height <= 0) {
    throw new Error('Generated media is not playable.');
  }

  return metadata;
}

function waitForVideoMetadata(video: HTMLMediaElement, timeoutMs = 5000) {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    let timeout: number;
    let onLoadedMetadata: () => void;
    let onError: () => void;
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('error', onError);
    };
    onLoadedMetadata = () => {
      cleanup();
      resolve();
    };
    onError = () => {
      cleanup();
      reject(new Error('Unable to load preview media.'));
    };

    timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('Preview media did not become playable in time.'));
    }, timeoutMs);
    video.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
    video.addEventListener('error', onError, { once: true });
    video.load();
  });
}

function seekVideoSafely(video: HTMLMediaElement, time: number) {
  const safeTime = Number.isFinite(video.duration) && video.duration > 0 ? clamp(time, 0, Math.max(0, video.duration - 0.02)) : Math.max(0, time);

  try {
    video.currentTime = safeTime;
    return true;
  } catch {
    return false;
  }
}

function getClipAsset(project: ProjectPresent, clip: TimelineClip | null) {
  return clip ? getAssetById(project, clip.assetId) : null;
}

type PreviewLayerVideoProps = {
  asset: ProjectAsset;
  clip: TimelineClip;
  isPlaying: boolean;
  localTime: number;
  playbackRate: number;
  style: CSSProperties;
};

function PreviewLayerVideo({ asset, clip, isPlaying, localTime, playbackRate, style }: PreviewLayerVideoProps) {
  const layerVideoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = layerVideoRef.current;

    if (!video) {
      return;
    }

    video.playbackRate = playbackRate;
    video.muted = true;
    video.volume = 0;

    const targetTime = clip.sourceIn + localTime;
    if (Math.abs(video.currentTime - targetTime) > 0.08) {
      seekVideoSafely(video, targetTime);
    }

    if (isPlaying) {
      void video.play().catch(() => {
        // Secondary preview layers are best-effort; the primary layer owns transport.
      });
    } else {
      video.pause();
    }
  }, [clip.sourceIn, isPlaying, localTime, playbackRate]);

  useEffect(() => {
    // Release the decoder when this layer unmounts. Without this, browsers
    // (especially Safari) keep the H.264 decoder warm long after the element
    // is gone, eating memory and decoder slots.
    const video = layerVideoRef.current;
    return () => {
      if (!video) {
        return;
      }
      try {
        video.pause();
        video.removeAttribute('src');
        video.load();
      } catch {
        // best effort; if the element is already detached, ignore
      }
    };
  }, []);

  return <video className="preview-layer-video" playsInline preload="metadata" ref={layerVideoRef} src={asset.playbackUrl} style={style} />;
}

type PreviewLayerAudioProps = {
  asset: ProjectAsset;
  clip: TimelineClip;
  isPlaying: boolean;
  localTime: number;
  playbackRate: number;
};

function PreviewLayerAudio({ asset, clip, isPlaying, localTime, playbackRate }: PreviewLayerAudioProps) {
  const layerAudioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const audio = layerAudioRef.current;

    if (!audio) {
      return;
    }

    audio.playbackRate = playbackRate;
    audio.muted = clip.muted;
    audio.volume = clip.muted ? 0 : Math.min(1, clip.volume);

    const targetTime = clip.sourceIn + localTime;
    if (Math.abs(audio.currentTime - targetTime) > 0.08) {
      try {
        audio.currentTime = targetTime;
      } catch {
        // Audio not ready yet; will sync on next pass.
      }
    }

    if (isPlaying) {
      void audio.play().catch(() => {
        // Audio playback can be rejected (autoplay policy / not ready); retry on next prop change.
      });
    } else {
      audio.pause();
    }
  }, [clip.muted, clip.sourceIn, clip.volume, isPlaying, localTime, playbackRate]);

  return <audio preload="auto" ref={layerAudioRef} src={asset.playbackUrl} />;
}

function pickTimelineClipThumbnails(thumbnails: Array<TimelineThumbnail | null>, clip: TimelineClip) {
  const loaded = thumbnails.filter((thumbnail): thumbnail is TimelineThumbnail => Boolean(thumbnail));
  const inRange = loaded.filter((thumbnail) => thumbnail.time >= clip.sourceIn - 0.05 && thumbnail.time <= clip.sourceOut + 0.05);
  const candidates = inRange.length > 0 ? inRange : loaded;

  if (candidates.length <= MAX_TIMELINE_CLIP_THUMBNAILS) {
    return candidates;
  }

  const picked: TimelineThumbnail[] = [];
  const usedIndexes = new Set<number>();

  for (let index = 0; index < MAX_TIMELINE_CLIP_THUMBNAILS; index += 1) {
    const candidateIndex = Math.round((index * (candidates.length - 1)) / (MAX_TIMELINE_CLIP_THUMBNAILS - 1));

    if (!usedIndexes.has(candidateIndex)) {
      usedIndexes.add(candidateIndex);
      picked.push(candidates[candidateIndex]);
    }
  }

  return picked;
}

type TimelineClipThumbnailStripProps = {
  asset: ProjectAsset | null;
  clip: TimelineClip;
};

function TimelineClipThumbnailStrip({ asset, clip }: TimelineClipThumbnailStripProps) {
  const { thumbnails } = useVideoThumbnails(asset?.file ?? null, asset?.originalUrl ?? null, asset?.duration ?? 0);
  const visibleThumbnails = useMemo(() => pickTimelineClipThumbnails(thumbnails, clip), [clip, thumbnails]);

  if (!asset) {
    return null;
  }

  if (visibleThumbnails.length === 0) {
    return (
      <span aria-hidden="true" className="clip-thumbnail-strip is-empty">
        {asset.posterUrl ? <img alt="" src={asset.posterUrl} /> : <span />}
      </span>
    );
  }

  return (
    <span aria-hidden="true" className="clip-thumbnail-strip">
      {visibleThumbnails.map((thumbnail) => (
        <img alt="" key={`${thumbnail.index}:${thumbnail.time}`} src={thumbnail.src} />
      ))}
    </span>
  );
}

type EditorWorkspaceProps = {
  hydratedProject: HydratedProject;
  onBackToDashboard: () => void;
  onProjectExport: (record: ProjectRecord) => Promise<void>;
  onRecordSaved: (record: ProjectRecord) => void;
  record: ProjectRecord;
};

function EditorWorkspace({
  hydratedProject,
  onBackToDashboard,
  onProjectExport,
  onRecordSaved,
  record,
}: EditorWorkspaceProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const projectNameInputRef = useRef<HTMLInputElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const previewFrameRef = useRef<HTMLDivElement>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const viewerStageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioPrimaryRef = useRef<HTMLAudioElement>(null);
  const activeMediaRef = useRef<HTMLMediaElement | null>(null);

  const attachVideoRef = useCallback((element: HTMLVideoElement | null) => {
    videoRef.current = element;
    activeMediaRef.current = element;
  }, []);

  const attachAudioPrimaryRef = useCallback((element: HTMLAudioElement | null) => {
    audioPrimaryRef.current = element;
    activeMediaRef.current = element;
  }, []);
  const activePlaybackRef = useRef<{
    clipEnd: number;
    clipId: string;
    clipStart: number;
    sourceIn: number;
    sourceOut: number;
  } | null>(null);
  const audioAnalyserRef = useRef<AnalyserNode | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioMeterDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const audioMeterFillRef = useRef<HTMLDivElement>(null);
  const audioMeterGainRef = useRef({ muted: false, volume: 1 });
  const audioMeterPeakRef = useRef<HTMLDivElement>(null);
  const audioMeterReadoutRef = useRef<HTMLSpanElement>(null);
  const exportJobCancelRef = useRef<(() => void) | null>(null);
  const lastScrubPreviewSeekAtRef = useRef(0);
  const metadataJobsRef = useRef(new Set<string>());
  const objectUrlsRef = useRef<string[]>([]);
  const previousActiveClipIdRef = useRef<string | null>(null);
  const proxyJobsRef = useRef(new Set<string>());
  const revokeObjectUrlsTimerRef = useRef<number | null>(null);
  const savedRecordRef = useRef(record);
  const allowEmptyProjectSaveRef = useRef(false);
  const dragModeRef = useRef<DragMode>(null);
  const pendingDragActionRef = useRef<Parameters<typeof projectReducer>[1] | null>(null);
  const dragRafIdRef = useRef<number | null>(null);

  const [project, dispatch] = useReducer(projectReducer, hydratedProject.history, (value) => value);
  const [exportStatus, setExportStatus] = useState<JobStatus>(idleJobStatus);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isTimelineDropTarget, setIsTimelineDropTarget] = useState(false);
  const [isTheater, setIsTheater] = useState(false);
  const [canAutosave, setCanAutosave] = useState(hydratedProject.canAutosave);
  const [importNotice, setImportNotice] = useState<string | null>(hydratedProject.recoveryMessage);
  const [projectName, setProjectName] = useState(record.name);
  const [projectSettings, setProjectSettings] = useState<ProjectSettings>(record.settings);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [playhead, setPlayhead] = useState(0);
  const [saveStatus, setSaveStatus] = useState<'failed' | 'saved' | 'saving'>('saved');
  const [showProjectSettings, setShowProjectSettings] = useState(false);
  const [showPerfHud, setShowPerfHud] = useState(() => new URLSearchParams(window.location.search).has('perf'));
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [rightPanelTab, setRightPanelTab] = useState<'chat' | 'inspector'>('inspector');
  const [snapEnabled, setSnapEnabled] = useState(true);
  const snapIndicatorRef = useRef<HTMLDivElement>(null);

  const present = project.present;
  const duration = useMemo(() => getProjectDuration(present), [present]);
  const activeLayerTimelines = useMemo(() => getVideoClipsAtTime(present, playhead), [present, playhead]);
  const activeAudioLayerTimelines = useMemo(() => getAudioClipsAtTime(present, playhead), [present, playhead]);
  const activeTextOverlays = useMemo(() => getActiveTextOverlays(present, playhead), [present, playhead]);
  const activeTimeline = useMemo(
    () =>
      activeLayerTimelines[activeLayerTimelines.length - 1] ??
      activeAudioLayerTimelines[activeAudioLayerTimelines.length - 1] ??
      null,
    [activeLayerTimelines, activeAudioLayerTimelines],
  );
  const activePrimaryKind: 'audio' | 'video' | 'none' =
    activeLayerTimelines.length > 0 ? 'video' : activeAudioLayerTimelines.length > 0 ? 'audio' : 'none';
  const getActiveMediaElement = useCallback((): HTMLMediaElement | null => {
    return activeMediaRef.current;
  }, []);
  const selectedClip = useMemo(() => getSelectedClip(present), [present]);
  const selectedText = useMemo(() => getSelectedText(present), [present]);
  const selectedAsset = useMemo(() => getAssetById(present, present.selectedAssetId), [present]);
  const activeClip = activeTimeline?.clip ?? null;
  const activeAsset = useMemo(() => getClipAsset(present, activeClip), [activeClip, present]);
  const selectedClipAsset = useMemo(() => getClipAsset(present, selectedClip), [present, selectedClip]);
  const activeEffectSettings = activeClip?.effects ?? DEFAULT_EFFECT_SETTINGS;
  const activeEffects = hasActiveEffects(activeEffectSettings);
  const hasTimeline = present.clips.length > 0 && duration > 0;
  const isProxyRunning = present.assets.some((asset) => asset.proxyStatus.state === 'running');
  const timelineCellWidth = getTimelineCellWidth(timelineZoom);
  const timelinePixelsPerSecond = TIMELINE_PIXELS_PER_SECOND * timelineZoom;
  const videoTracks = useMemo(() => getVideoTracksTopFirst(present), [present.tracks]);
  const audioTracks = useMemo(() => getAudioTracksTopFirst(present), [present.tracks]);
  const textTracks = useMemo(
    () => [...present.tracks].filter((track) => track.kind === 'text').sort((a, b) => b.index - a.index),
    [present.tracks],
  );
  const videoTracksHeight = videoTracks.length * (TIMELINE_TRACK_HEIGHT + TIMELINE_TRACK_GAP);
  const audioTracksHeight = audioTracks.length * (TIMELINE_AUDIO_TRACK_HEIGHT + TIMELINE_TRACK_GAP);
  const textTracksHeight = textTracks.length * (TIMELINE_TEXT_TRACK_HEIGHT + TIMELINE_TRACK_GAP);
  const audioTracksTop = TIMELINE_TRACK_TOP + videoTracksHeight;
  const textTracksTop = audioTracksTop + audioTracksHeight;
  const timelineContentHeight = textTracksTop + Math.max(textTracksHeight, 0) + 24;
  const timelineWidth = Math.max(
    TIMELINE_MIN_WIDTH,
    getVirtualTimelineWidth(Math.ceil(duration || 1), timelineZoom),
    Math.ceil(TIMELINE_LABEL_WIDTH + (duration + 5) * timelinePixelsPerSecond),
  );
  const capabilities = useMemo(() => detectMediaCapabilities(), []);
  const clipVirtualizer = useVirtualizer({
    count: present.clips.length,
    estimateSize: () => timelineCellWidth * 2,
    getScrollElement: () => timelineScrollRef.current,
    horizontal: true,
    overscan: 4,
    useFlushSync: false,
  });
  const virtualThumbnails = clipVirtualizer.getVirtualItems();
  const editArray = useMemo(
    () => (showProjectSettings ? createEditArrayFromRuntime(present, projectSettings, projectName) : null),
    [present, projectName, projectSettings, showProjectSettings],
  );
  const editArrayText = useMemo(() => (editArray ? stringifyEditArray(editArray) : ''), [editArray]);
  const [viewerSize, setViewerSize] = useState({ height: 0, width: 0 });
  const previewFrameStyle = useMemo(() => {
    const mediaWidth = Math.max(1, activeAsset?.width || projectSettings.width || 16);
    const mediaHeight = Math.max(1, activeAsset?.height || projectSettings.height || 9);

    if (viewerSize.width <= 0 || viewerSize.height <= 0) {
      return {
        aspectRatio: `${mediaWidth} / ${mediaHeight}`,
        maxHeight: '100%',
        maxWidth: '100%',
      };
    }

    const scale = Math.min(viewerSize.width / mediaWidth, viewerSize.height / mediaHeight);

    return {
      height: `${Math.max(1, Math.floor(mediaHeight * scale))}px`,
      width: `${Math.max(1, Math.floor(mediaWidth * scale))}px`,
    };
  }, [activeAsset?.height, activeAsset?.width, projectSettings.height, projectSettings.width, viewerSize.height, viewerSize.width]);
  const getClipTransformStyle = useCallback((clip: TimelineClip | null): CSSProperties => {
    const transform = clip?.transform ?? { scale: 1, x: 0.5, y: 0.5 };

    return {
      transform: `translate3d(${(transform.x - 0.5) * 100}%, ${(transform.y - 0.5) * 100}%, 0) scale(${transform.scale})`,
    };
  }, []);
  const activeClipTransformStyle = useMemo(() => getClipTransformStyle(activeClip), [activeClip, getClipTransformStyle]);

  const { isGpuPreviewActive } = usePreviewCompositor({
    canvasRef: previewCanvasRef,
    effects: activeEffectSettings,
    enabled: hasTimeline && activeEffects && activePrimaryKind === 'video',
    videoRef,
  });

  const timelineTimeToVideoTime = useCallback(
    (time: number) => {
      const active = getClipAtTime(present, time);

      return active ? active.clip.sourceIn + active.localTime : null;
    },
    [present],
  );

  const getCurrentTimelineTime = useCallback(() => {
    const media = getActiveMediaElement();
    const active = activePlaybackRef.current;

    if (!media || !active) {
      return playhead;
    }

    return clamp(active.clipStart + (media.currentTime - active.sourceIn), 0, duration || 0);
  }, [duration, getActiveMediaElement, playhead]);

  const { applyVisualTime, getVisualTime, markSeekEnd, playheadRef, progressRef, seekTo } = useTimelineRuntime({
    duration,
    getCurrentTimelineTime,
    hasMedia: hasTimeline,
    inPoint: 0,
    isPlaying,
    loopRange: false,
    outPoint: duration,
    pixelOffset: TIMELINE_LABEL_WIDTH,
    pixelsPerSecond: timelinePixelsPerSecond,
    playhead,
    setIsPlaying,
    setPlayhead,
    timelineTimeToVideoTime,
    videoRef: activeMediaRef,
  });

  const projectStatus = useMemo(() => {
    if (exportStatus.state === 'running') {
      return { detail: `${exportStatus.progress}%`, label: 'Exporting' };
    }

    if (exportStatus.state === 'error') {
      return { detail: exportStatus.error ?? 'Retry export', label: 'Export failed' };
    }

    if (exportStatus.state === 'complete') {
      return { detail: 'Downloaded MP4', label: 'Export complete' };
    }

    if (importNotice) {
      return { detail: importNotice, label: 'Import note' };
    }

    const activeProxy = present.assets.find((asset) => asset.proxyStatus.state === 'running');

    if (activeProxy) {
      return { detail: `${activeProxy.proxyStatus.progress}%`, label: 'Preparing proxy' };
    }

    if (isPlaying) {
      return { detail: `${formatClock(playhead)} / ${formatClock(duration)}`, label: 'Playing' };
    }

    return {
      detail: hasTimeline ? `${present.clips.length} clips | ${formatClock(duration)}` : 'Import clips',
      label: 'Ready',
    };
  }, [duration, exportStatus, hasTimeline, importNotice, isPlaying, playhead, present.assets, present.clips.length]);

  const setDragMode = useCallback((mode: DragMode) => {
    dragModeRef.current = mode;
  }, []);

  // Coalesces drag-time dispatches (MOVE_CLIP, UPDATE_TEXT, TRIM_CLIP) so a
  // 144 Hz pointer stream produces at most one reducer pass per animation
  // frame. Only the latest action survives — earlier ones reflect stale
  // positions anyway.
  const flushPendingDragAction = useCallback(() => {
    dragRafIdRef.current = null;
    const pending = pendingDragActionRef.current;
    pendingDragActionRef.current = null;
    if (pending) {
      dispatch(pending);
    }
  }, []);

  const dispatchDragAction = useCallback(
    (action: Parameters<typeof projectReducer>[1]) => {
      pendingDragActionRef.current = action;
      if (dragRafIdRef.current !== null) {
        return;
      }
      dragRafIdRef.current = window.requestAnimationFrame(flushPendingDragAction);
    },
    [flushPendingDragAction],
  );

  const cancelPendingDragAction = useCallback(() => {
    if (dragRafIdRef.current !== null) {
      window.cancelAnimationFrame(dragRafIdRef.current);
      dragRafIdRef.current = null;
    }
    pendingDragActionRef.current = null;
  }, []);

  const hideSnapIndicator = useCallback(() => {
    const indicator = snapIndicatorRef.current;
    if (indicator) {
      indicator.style.opacity = '0';
    }
  }, []);

  const showSnapIndicatorAt = useCallback(
    (time: number) => {
      const indicator = snapIndicatorRef.current;
      if (!indicator) {
        return;
      }
      const x = TIMELINE_LABEL_WIDTH + time * timelinePixelsPerSecond;
      indicator.style.transform = `translate3d(${x}px, 0, 0)`;
      indicator.style.opacity = '1';
    },
    [timelinePixelsPerSecond],
  );

  const resolveSnap = useCallback(
    (desired: number, options: { event?: PointerEvent<HTMLElement>; excludeClipId?: string; excludeTextId?: string; includeOtherEdge?: number }): number => {
      if (!snapEnabled) {
        hideSnapIndicator();
        return desired;
      }

      const event = options.event;
      if (event && (event.metaKey || event.ctrlKey)) {
        hideSnapIndicator();
        return desired;
      }

      const tolerance = 8 / Math.max(1, timelinePixelsPerSecond);
      const targets = collectSnapTargets(present, {
        excludeClipId: options.excludeClipId ?? null,
        excludeTextId: options.excludeTextId ?? null,
        includePlayhead: playhead,
      });

      let candidates = targets;
      // When the user is sliding an edge, also let the OTHER edge of the same
      // clip/overlay attract — useful for shrinking/growing without losing
      // the visible "other side" anchor.
      if (typeof options.includeOtherEdge === 'number' && Number.isFinite(options.includeOtherEdge)) {
        candidates = [...targets, options.includeOtherEdge].sort((a, b) => a - b);
      }

      const result = snapToTarget(desired, candidates, tolerance);
      if (result.target !== null) {
        showSnapIndicatorAt(result.target);
      } else {
        hideSnapIndicator();
      }
      return result.value;
    },
    [hideSnapIndicator, playhead, present, showSnapIndicatorAt, snapEnabled, timelinePixelsPerSecond],
  );

  const getCurrentEditTime = useCallback(() => clamp(getVisualTime(), 0, duration || 0), [duration, getVisualTime]);

  const openFolderImport = useCallback(() => {
    setImportNotice(null);
    folderInputRef.current?.click();
  }, []);

  const registerObjectUrl = useCallback((url: string | null) => {
    if (!url?.startsWith('blob:') || objectUrlsRef.current.includes(url)) {
      return;
    }

    objectUrlsRef.current.push(url);
  }, []);

  const paintAudioMeter = useCallback((meterPos: number, peakPos: number, dBFS: number) => {
    const safeLevel = clamp(meterPos, 0, 1);
    const safePeak = clamp(peakPos, 0, 1);

    if (audioMeterFillRef.current) {
      audioMeterFillRef.current.style.clipPath = `inset(${((1 - safeLevel) * 100).toFixed(2)}% 0 0 0)`;
    }

    if (audioMeterPeakRef.current) {
      audioMeterPeakRef.current.style.top = `${((1 - safePeak) * 100).toFixed(1)}%`;
    }

    if (audioMeterReadoutRef.current) {
      audioMeterReadoutRef.current.textContent = formatAudioMeterDb(dBFS);
    }
  }, []);

  const loadFiles = useCallback((files: FileList | File[]) => {
    const incomingFiles = Array.from(files);
    const mediaFiles = incomingFiles.filter(isSupportedMediaFile);
    const unsupportedCount = incomingFiles.length - mediaFiles.length;

    if (incomingFiles.length === 0) {
      setImportNotice(null);
      return;
    }

    if (mediaFiles.length === 0) {
      setImportNotice('No supported video or audio files in the selection.');
      return;
    }

    if (unsupportedCount > 0) {
      setImportNotice(`${unsupportedCount} unsupported file${unsupportedCount === 1 ? '' : 's'} skipped. Video and audio files are supported.`);
    } else {
      setImportNotice(null);
    }

    const assets = mediaFiles.map(createAsset);
    assets.forEach((asset) => registerObjectUrl(asset.originalUrl));
    setSaveStatus('saving');
    void Promise.all(assets.map((asset) => storeRuntimeAssetBlobs(record.id, asset)))
      .then(() => {
        setCanAutosave(true);
        dispatch({ assets, type: 'ADD_ASSETS' });
      })
      .catch(() => {
        assets.forEach((asset) => URL.revokeObjectURL(asset.originalUrl));
        setSaveStatus('failed');
      });
  }, [record.id, registerObjectUrl]);

  const addAssetToTimeline = useCallback((assetId: string | null, timelineStart?: number, trackId?: string) => {
    if (!assetId) {
      return;
    }

    const asset = getAssetById(present, assetId);

    if (!asset || asset.duration <= 0) {
      return;
    }

    let resolvedTrackId = trackId;

    if (!resolvedTrackId) {
      if (asset.kind === 'audio') {
        const existingAudioTrack = getDefaultAudioTrackId(present);
        if (existingAudioTrack) {
          resolvedTrackId = existingAudioTrack;
        } else {
          const newTrack: TimelineTrack = {
            id: createId('audio'),
            index: getNextTrackIndex(present, 'audio'),
            kind: 'audio',
            locked: false,
            muted: false,
            name: `Audio ${getNextTrackIndex(present, 'audio') + 1}`,
            visible: true,
          };
          dispatch({ track: newTrack, type: 'ADD_TRACK' });
          resolvedTrackId = newTrack.id;
        }
      } else {
        resolvedTrackId = present.selectedTrackId ?? getDefaultVideoTrackId(present);
      }
    } else {
      const targetTrack = present.tracks.find((track) => track.id === resolvedTrackId);
      if (targetTrack && targetTrack.kind !== asset.kind) {
        setImportNotice(`Cannot place ${asset.kind} asset on a ${targetTrack.kind} track.`);
        return;
      }
    }

    dispatch({
      assetId,
      clipId: createId('clip'),
      timelineStart,
      trackId: resolvedTrackId,
      type: 'ADD_ASSET_TO_TIMELINE',
    });
  }, [present]);

  const deleteAssetFromLibrary = useCallback(
    (assetId: string) => {
      const asset = getAssetById(present, assetId);

      if (!asset) {
        return;
      }

      const dependentClipCount = present.clips.filter((clip) => clip.assetId === assetId).length;

      if (
        dependentClipCount > 0 &&
        !window.confirm(`Delete "${asset.name}" from the media library? This also removes ${dependentClipCount} timeline clip${dependentClipCount === 1 ? '' : 's'} and ripples that track.`)
      ) {
        return;
      }

      allowEmptyProjectSaveRef.current = present.assets.length === 1;
      const action = { assetId, type: 'DELETE_ASSET' } as const;
      const nextProject = projectReducer({ future: [], past: [], present }, action).present;
      dispatch(action);
      setSaveStatus('saving');
      void saveRuntimeProjectRecord(savedRecordRef.current, nextProject, projectName, projectSettings, {
        allowAssetLoss: allowEmptyProjectSaveRef.current,
      })
        .then((nextRecord) => {
          allowEmptyProjectSaveRef.current = false;
          savedRecordRef.current = nextRecord;
          onRecordSaved(nextRecord);
          setSaveStatus('saved');
          void deleteRuntimeAssetBlobs(record.id, assetId);
        })
        .catch(() => {
          setSaveStatus('failed');
        });
      setImportNotice(
        dependentClipCount > 0
          ? `Removed ${asset.name} and ${dependentClipCount} timeline clip${dependentClipCount === 1 ? '' : 's'}.`
          : `Removed ${asset.name} from media.`,
      );
    },
    [onRecordSaved, present, projectName, projectSettings, record.id],
  );

  const getTimelineTimeFromClientX = useCallback(
    (clientX: number) => {
      if (!timelineRef.current) {
        return 0;
      }

      const rect = timelineRef.current.getBoundingClientRect();
      const x = Math.max(0, clientX - rect.left - TIMELINE_LABEL_WIDTH);

      return Math.max(0, x / timelinePixelsPerSecond);
    },
    [timelinePixelsPerSecond],
  );

  const getTimelineTrackIdFromClientY = useCallback(
    (clientY: number, assetKind: 'audio' | 'text' | 'video' = 'video') => {
      const rect = timelineRef.current?.getBoundingClientRect();
      const fallbackId =
        assetKind === 'audio'
          ? getDefaultAudioTrackId(present) ?? present.selectedTrackId ?? getDefaultVideoTrackId(present)
          : assetKind === 'text'
            ? textTracks[0]?.id ?? present.tracks.find((track) => track.kind === 'text')?.id ?? DEFAULT_TEXT_TRACK_ID
            : present.selectedTrackId ?? getDefaultVideoTrackId(present);

      if (!rect) {
        return fallbackId;
      }

      const y = clientY - rect.top;

      if (assetKind === 'audio') {
        if (audioTracks.length === 0) {
          return fallbackId;
        }
        const audioIndex = clamp(
          Math.floor((y - audioTracksTop) / (TIMELINE_AUDIO_TRACK_HEIGHT + TIMELINE_TRACK_GAP)),
          0,
          Math.max(0, audioTracks.length - 1),
        );
        return audioTracks[audioIndex]?.id ?? fallbackId;
      }

      if (assetKind === 'text') {
        if (textTracks.length === 0) {
          return fallbackId;
        }
        const textIndex = clamp(
          Math.floor((y - textTracksTop) / (TIMELINE_TEXT_TRACK_HEIGHT + TIMELINE_TRACK_GAP)),
          0,
          Math.max(0, textTracks.length - 1),
        );
        return textTracks[textIndex]?.id ?? fallbackId;
      }

      if (videoTracks.length === 0) {
        return fallbackId;
      }

      const index = clamp(
        Math.floor((y - TIMELINE_TRACK_TOP) / (TIMELINE_TRACK_HEIGHT + TIMELINE_TRACK_GAP)),
        0,
        Math.max(0, videoTracks.length - 1),
      );

      return videoTracks[index]?.id ?? fallbackId;
    },
    [audioTracks, audioTracksTop, present, textTracks, textTracksTop, videoTracks],
  );

  const addTextOverlay = useCallback(() => {
    if (!hasTimeline) {
      return;
    }

    const start = clamp(getCurrentEditTime(), 0, Math.max(0, duration - 0.1));
    const targetTextTrack =
      (present.selectedTrackId && present.tracks.find((track) => track.id === present.selectedTrackId)?.kind === 'text'
        ? present.selectedTrackId
        : null) ?? present.tracks.find((track) => track.kind === 'text')?.id ?? '';

    dispatch({
      overlay: {
        align: 'center',
        end: Math.min(duration, start + 3),
        id: createId('text'),
        size: 34,
        start,
        text: 'Text',
        trackId: targetTextTrack,
        x: 0.5,
        y: 0.18,
      },
      type: 'ADD_TEXT',
    });
  }, [duration, getCurrentEditTime, hasTimeline, present]);

  const deleteTrack = useCallback(
    (trackId: string) => {
      const track = present.tracks.find((candidate) => candidate.id === trackId);

      if (!track) {
        return;
      }

      const remainingVideoTracks = present.tracks.filter((candidate) => candidate.kind === 'video' && candidate.id !== trackId);

      if (track.kind === 'video' && remainingVideoTracks.length === 0) {
        setImportNotice('Cannot delete the last video track. Add another video track first.');
        return;
      }

      const dependentClipCount = present.clips.filter((clip) => clip.trackId === trackId).length;
      const confirmMessage =
        dependentClipCount > 0
          ? `Delete "${track.name}"? This also removes ${dependentClipCount} clip${dependentClipCount === 1 ? '' : 's'} on this track.`
          : `Delete "${track.name}"?`;

      if (!window.confirm(confirmMessage)) {
        return;
      }

      dispatch({ trackId, type: 'DELETE_TRACK' });
    },
    [present],
  );

  const addVideoTrack = useCallback(() => {
    const index = getNextTrackIndex(present, 'video');

    dispatch({
      track: {
        id: createId('video'),
        index,
        kind: 'video',
        locked: false,
        muted: false,
        name: `Video ${index + 1}`,
        visible: true,
      },
      type: 'ADD_TRACK',
    });
  }, [present]);

  const addAudioTrack = useCallback(() => {
    const index = getNextTrackIndex(present, 'audio');

    dispatch({
      track: {
        id: createId('audio'),
        index,
        kind: 'audio',
        locked: false,
        muted: false,
        name: `Audio ${index + 1}`,
        visible: true,
      },
      type: 'ADD_TRACK',
    });
  }, [present]);

  const addTextTrack = useCallback(() => {
    const index = getNextTrackIndex(present, 'text');

    dispatch({
      track: {
        id: createId('text'),
        index,
        kind: 'text',
        locked: false,
        muted: false,
        name: `Text ${index + 1}`,
        visible: true,
      },
      type: 'ADD_TRACK',
    });
  }, [present]);

  const updatePreviewDirectManipulation = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const mode = dragModeRef.current;
      const rect = previewFrameRef.current?.getBoundingClientRect();

      if (!mode || !rect || rect.width <= 0 || rect.height <= 0) {
        return;
      }

      if (mode.type === 'preview-text-move') {
        dispatchDragAction({
          patch: {
            x: clamp(mode.startTextX + (event.clientX - mode.startX) / rect.width, 0.02, 0.98),
            y: clamp(mode.startTextY + (event.clientY - mode.startY) / rect.height, 0.02, 0.98),
          },
          record: false,
          textId: mode.textId,
          type: 'UPDATE_TEXT',
        });
        return;
      }

      if (mode.type === 'preview-text-scale') {
        dispatchDragAction({
          patch: {
            size: clamp(mode.startSize + (event.clientX - mode.startX) * 0.3, 12, 96),
          },
          record: false,
          textId: mode.textId,
          type: 'UPDATE_TEXT',
        });
        return;
      }

      if (mode.type === 'preview-clip-move') {
        dispatchDragAction({
          clipId: mode.clipId,
          record: false,
          transform: {
            x: clamp(mode.startTransform.x + (event.clientX - mode.startX) / rect.width, 0, 1),
            y: clamp(mode.startTransform.y + (event.clientY - mode.startY) / rect.height, 0, 1),
          },
          type: 'UPDATE_CLIP_TRANSFORM',
        });
        return;
      }

      if (mode.type === 'preview-clip-scale') {
        dispatchDragAction({
          clipId: mode.clipId,
          record: false,
          transform: {
            scale: clamp(mode.startScale + (event.clientX - mode.startX) / 160, 0.25, 4),
          },
          type: 'UPDATE_CLIP_TRANSFORM',
        });
      }
    },
    [dispatchDragAction],
  );

  const endPreviewDirectManipulation = useCallback(() => {
    const mode = dragModeRef.current;

    if (
      mode?.type === 'preview-text-move' ||
      mode?.type === 'preview-text-scale' ||
      mode?.type === 'preview-clip-move' ||
      mode?.type === 'preview-clip-scale'
    ) {
      // Flush any throttled drag dispatch before we drop the drag mode so the
      // last position actually lands in the reducer.
      if (dragRafIdRef.current !== null) {
        window.cancelAnimationFrame(dragRafIdRef.current);
        dragRafIdRef.current = null;
        const pending = pendingDragActionRef.current;
        pendingDragActionRef.current = null;
        if (pending) {
          dispatch(pending);
        }
      }
      setDragMode(null);
    }
  }, [setDragMode]);

  const splitAtPlayhead = useCallback(() => {
    if (!hasTimeline) {
      return;
    }

    const editTime = getCurrentEditTime();

    if (selectedText) {
      dispatch({ newTextId: createId('text'), playhead: editTime, textId: selectedText.id, type: 'SPLIT_TEXT' });
      return;
    }

    if (selectedClip) {
      const clipEnd = getClipEnd(selectedClip);
      if (editTime > selectedClip.timelineStart && editTime < clipEnd) {
        dispatch({
          clipId: selectedClip.id,
          newClipId: createId('clip'),
          playhead: editTime,
          type: 'SPLIT_CLIP',
        });
        return;
      }
    }

    dispatch({ newClipId: createId('clip'), playhead: editTime, type: 'SPLIT_CLIP' });
  }, [getCurrentEditTime, hasTimeline, selectedClip, selectedText]);

  const deleteSelected = useCallback(() => {
    dispatch({ type: 'DELETE_SELECTED' });
  }, []);

  const pausePlayback = useCallback(() => {
    getActiveMediaElement()?.pause();
    setIsPlaying(false);
  }, [getActiveMediaElement]);

  // Build (or repair) the persistent audio graph that makes both playback and
  // the dB meter work. MUST be called inside a user-gesture handler the first
  // time — that's when the AudioContext is created so it starts in 'running'
  // state rather than 'suspended'.
  //
  // Topology:
  //   <video>/<audio>  ──createMediaElementSource──▶  source
  //   source           ──connect──▶                   analyser
  //   analyser         ──connect──▶                   context.destination
  //
  // createMediaElementSource hijacks the element's native audio output, so the
  // chain MUST reach destination — otherwise the audio is silent. The analyser
  // is a pass-through, so inserting it in-line lets us meter without
  // disrupting playback. We only build the analyser once and keep it for the
  // life of the editor.
  const ensureAudioMeterChain = useCallback(() => {
    let context = audioContextRef.current;

    if (!context) {
      const Constructor = getAudioContextConstructor();
      if (!Constructor) {
        return null;
      }
      context = new Constructor();
      audioContextRef.current = context;
    }

    // Idempotent: only resumes if not already running. On iOS/Safari this
    // call has to happen inside a user gesture; the resume Promise is
    // intentionally not awaited so we stay synchronous in the gesture chain.
    if (context.state !== 'running') {
      void context.resume().catch(() => undefined);
    }

    let analyser = audioAnalyserRef.current;
    if (!analyser) {
      analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.82;
      analyser.connect(context.destination);
      audioAnalyserRef.current = analyser;
      audioMeterDataRef.current = new Uint8Array(analyser.fftSize);
    }

    const media = getActiveMediaElement();
    if (media) {
      let source = mediaElementAudioSources.get(media);
      if (!source) {
        try {
          source = context.createMediaElementSource(media);
          mediaElementAudioSources.set(media, source);
        } catch {
          return analyser;
        }
      }
      // connect() is idempotent on identical (source, destination) pairs, so
      // calling this on every gesture / clip change is safe.
      try {
        source.connect(analyser);
      } catch {
        // already connected
      }
    }

    return analyser;
  }, [getActiveMediaElement]);

  const playPlayback = useCallback(async () => {
    if (!hasTimeline) {
      return;
    }

    const startTime = playhead >= duration ? 0 : playhead;
    let active = getClipAtTime(present, startTime);

    if (!active) {
      const fallback = getFirstClipByTimelineOrder(present);

      if (!fallback) {
        return;
      }

      active = {
        clip: fallback,
        clipEnd: getClipEnd(fallback),
        clipStart: fallback.timelineStart,
        localTime: 0,
        track: getTrackById(present, fallback.trackId),
      };
    }

    const targetPlayhead = active.clipStart + active.localTime;

    if (Math.abs(playhead - targetPlayhead) > 0.001) {
      setPlayhead(targetPlayhead);
      // Yield so React can commit the (possibly new) <video> element before we await on it.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }

    const media = getActiveMediaElement();

    if (!media) {
      setIsPlaying(false);
      return;
    }

    try {
      await waitForVideoMetadata(media);
      seekVideoSafely(media, active.clip.sourceIn + active.localTime);
      media.playbackRate = playbackRate;
      await media.play();
      setIsPlaying(true);
    } catch {
      setIsPlaying(false);
    }
  }, [duration, getActiveMediaElement, hasTimeline, playbackRate, playhead, present]);

  const togglePlayback = useCallback(() => {
    // This is the user-gesture chain. Building the audio graph HERE (rather
    // than in a useEffect) is what guarantees the AudioContext starts in
    // 'running' state instead of 'suspended' — which is why audio used to be
    // silent after createMediaElementSource hijacked the element's output.
    ensureAudioMeterChain();

    if (isPlaying) {
      pausePlayback();
      return;
    }

    void playPlayback();
  }, [ensureAudioMeterChain, isPlaying, pausePlayback, playPlayback]);

  const stepBy = useCallback(
    (amount: number) => {
      pausePlayback();
      seekTo(clamp(playhead + amount, 0, duration || 0));
    },
    [duration, pausePlayback, playhead, seekTo],
  );

  const exportProject = useCallback(async () => {
    if (!hasTimeline || exportStatus.state === 'running') {
      return;
    }

    if (isProxyRunning) {
      setExportStatus({ error: null, progress: 0, state: 'idle' });
      setImportNotice('Finish proxy preparation before exporting. This keeps FFmpeg jobs from colliding on the same media.');
      return;
    }

    exportJobCancelRef.current?.();
    setExportStatus({ error: null, progress: 0, state: 'running' });
    performanceMonitor.markTranscodeStart('export');

    const job = runTranscodeJob({
      assets: present.assets.map((asset) => ({ file: asset.file, id: asset.id, kind: asset.kind })),
      clips: present.clips,
      kind: 'export-timeline-mp4',
      onProgress: ({ progress }) => {
        performanceMonitor.markTranscodeProgress('export', progress);
        setExportStatus({ error: null, progress: Math.round(progress * 100), state: 'running' });
      },
      outputFps: projectSettings.fps,
      outputHeight: projectSettings.height,
      outputWidth: projectSettings.width,
      textOverlays: present.textOverlays,
    });

    exportJobCancelRef.current = job.cancel;

    try {
      const result = await job.promise;
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'chitra-export.mp4';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      performanceMonitor.markTranscodeComplete('export', result.tookMs);
      setExportStatus({ error: null, progress: 100, state: 'complete' });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setExportStatus({ error: null, progress: 0, state: 'idle' });
        performanceMonitor.markTranscodeFailed('export');
        return;
      }

      performanceMonitor.markTranscodeFailed('export');
      setExportStatus({
        error: error instanceof Error ? error.message : 'Timeline export failed.',
        progress: 0,
        state: 'error',
      });
    } finally {
      exportJobCancelRef.current = null;
    }
  }, [exportStatus.state, hasTimeline, isProxyRunning, present.assets, present.clips, present.textOverlays, projectSettings]);

  const cancelExport = useCallback(() => {
    exportJobCancelRef.current?.();
    exportJobCancelRef.current = null;
    performanceMonitor.markTranscodeFailed('export');
    setExportStatus({ error: null, progress: 0, state: 'idle' });
  }, []);

  const exportCurrentProjectPackage = useCallback(async () => {
    try {
      setSaveStatus('saving');
      const nextRecord = await saveRuntimeProjectRecord(savedRecordRef.current, present, projectName, projectSettings, {
        allowAssetLoss: allowEmptyProjectSaveRef.current,
      });
      allowEmptyProjectSaveRef.current = false;
      savedRecordRef.current = nextRecord;
      onRecordSaved(nextRecord);
      setSaveStatus('saved');
      await onProjectExport(nextRecord);
    } catch {
      setSaveStatus('failed');
    }
  }, [onProjectExport, onRecordSaved, present, projectName, projectSettings]);


  const updateFromPointer = useCallback(
    (event: PointerEvent<HTMLDivElement>, mode: DragMode = dragModeRef.current) => {
      if (!timelineRef.current || !mode || (duration <= 0 && mode.type !== 'clip-move')) {
        return null;
      }

      const time = mode.type === 'clip-move' ? getTimelineTimeFromClientX(event.clientX) : clamp(getTimelineTimeFromClientX(event.clientX), 0, duration);

      if (mode.type === 'playhead') {
        applyVisualTime(time);
        setPlayhead(time);

        const now = performance.now();
        if (now - lastScrubPreviewSeekAtRef.current > SCRUB_PREVIEW_SEEK_INTERVAL_MS) {
          lastScrubPreviewSeekAtRef.current = now;
          const videoTime = timelineTimeToVideoTime(time);
          const media = getActiveMediaElement();
          if (media && videoTime !== null) {
            seekVideoSafely(media, videoTime);
          }
        }
      } else if (mode.type === 'clip-move') {
        if (isClipReorderDrag(mode.startX, mode.startY, event.clientX, event.clientY, CLIP_REORDER_DRAG_THRESHOLD_PX)) {
          const deltaSeconds = (event.clientX - mode.startX) / timelinePixelsPerSecond;
          const startingTrack = present.tracks.find((track) => track.id === mode.startTrackId);
          const dragKind: 'audio' | 'video' = startingTrack?.kind === 'audio' ? 'audio' : 'video';
          const draggedClip = present.clips.find((c) => c.id === mode.clipId);
          const clipDuration = draggedClip ? getClipDuration(draggedClip) : 0;
          const rawStart = Math.max(0, mode.startTimelineStart + deltaSeconds);
          const snappedStart = resolveSnap(rawStart, {
            event,
            excludeClipId: mode.clipId,
            includeOtherEdge: rawStart + clipDuration,
          });
          dispatchDragAction({
            clipId: mode.clipId,
            record: false,
            timelineStart: snappedStart,
            trackId: getTimelineTrackIdFromClientY(event.clientY, dragKind),
            type: 'MOVE_CLIP',
          });
        }
      } else if (mode.type === 'timeline-text-move') {
        if (isClipReorderDrag(mode.startX, mode.startY, event.clientX, event.clientY, CLIP_REORDER_DRAG_THRESHOLD_PX)) {
          const overlayDuration = Math.max(0.1, mode.startEnd - mode.startStart);
          const deltaSeconds = (event.clientX - mode.startX) / timelinePixelsPerSecond;
          const rawStart = clamp(mode.startStart + deltaSeconds, 0, Math.max(0, duration - overlayDuration));
          const nextStart = resolveSnap(rawStart, {
            event,
            excludeTextId: mode.textId,
            includeOtherEdge: rawStart + overlayDuration,
          });

          dispatchDragAction({
            patch: {
              end: nextStart + overlayDuration,
              start: nextStart,
              trackId: getTimelineTrackIdFromClientY(event.clientY, 'text'),
            },
            record: false,
            textId: mode.textId,
            type: 'UPDATE_TEXT',
          });
        }
      } else if (mode.type === 'trim-start' || mode.type === 'trim-end') {
        const clip = present.clips.find((candidate) => candidate.id === mode.clipId);

        if (clip) {
          const clipEnd = getClipEnd(clip);
          const otherEdge = mode.type === 'trim-start' ? clipEnd : clip.timelineStart;
          const snappedTime = resolveSnap(time, {
            event,
            excludeClipId: clip.id,
            includeOtherEdge: otherEdge,
          });
          const sourceTime = clip.sourceIn + (snappedTime - clip.timelineStart);
          dispatchDragAction({
            clipId: clip.id,
            edge: mode.type === 'trim-start' ? 'start' : 'end',
            sourceTime,
            type: 'TRIM_CLIP',
          });
        }
      } else if (mode.type === 'text-trim-start' || mode.type === 'text-trim-end') {
        const overlay = present.textOverlays.find((candidate) => candidate.id === mode.textId);

        if (overlay) {
          if (mode.type === 'text-trim-start') {
            const rawStart = clamp(time, 0, overlay.end - 0.1);
            const nextStart = resolveSnap(rawStart, {
              event,
              excludeTextId: overlay.id,
              includeOtherEdge: overlay.end,
            });
            dispatchDragAction({
              patch: { start: nextStart },
              record: false,
              textId: overlay.id,
              type: 'UPDATE_TEXT',
            });
          } else {
            const rawEnd = clamp(time, overlay.start + 0.1, duration);
            const nextEnd = resolveSnap(rawEnd, {
              event,
              excludeTextId: overlay.id,
              includeOtherEdge: overlay.start,
            });
            dispatchDragAction({
              patch: { end: nextEnd },
              record: false,
              textId: overlay.id,
              type: 'UPDATE_TEXT',
            });
          }
        }
      }

      return time;
    },
    [applyVisualTime, dispatchDragAction, duration, getTimelineTimeFromClientX, getTimelineTrackIdFromClientY, present, resolveSnap, timelinePixelsPerSecond, timelineTimeToVideoTime],
  );

  const onTimelinePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (duration <= 0) {
        return;
      }

      const mode: DragMode = { type: 'playhead', wasPlaying: isPlaying };
      setDragMode(mode);
      pausePlayback();
      updateFromPointer(event, mode);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [duration, isPlaying, pausePlayback, setDragMode, updateFromPointer],
  );

  const onClipPointerDown = useCallback(
    (event: PointerEvent<HTMLButtonElement>, clipId: string) => {
      event.stopPropagation();
      const clip = present.clips.find((candidate) => candidate.id === clipId);

      if (!clip) {
        return;
      }

      dispatch({ clipId, type: 'SELECT_CLIP' });
      const mode: DragMode = {
        clipId,
        startTimelineStart: clip.timelineStart,
        startTrackId: clip.trackId,
        startX: event.clientX,
        startY: event.clientY,
        type: 'clip-move',
      };
      setDragMode(mode);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [present.clips, setDragMode],
  );

  const onTrimPointerDown = useCallback(
    (event: PointerEvent<HTMLSpanElement>, clipId: string, edge: 'start' | 'end') => {
      event.stopPropagation();
      dispatch({ clipId, type: 'SELECT_CLIP' });
      const mode: DragMode = { clipId, type: edge === 'start' ? 'trim-start' : 'trim-end' };
      setDragMode(mode);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [setDragMode],
  );

  const onTextTrimPointerDown = useCallback(
    (event: PointerEvent<HTMLSpanElement>, textId: string, edge: 'start' | 'end') => {
      event.stopPropagation();
      dispatch({ textId, type: 'SELECT_TEXT' });
      const mode: DragMode = { textId, type: edge === 'start' ? 'text-trim-start' : 'text-trim-end' };
      setDragMode(mode);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [setDragMode],
  );

  const onTimelineTextPointerDown = useCallback(
    (event: PointerEvent<HTMLButtonElement>, overlay: TextOverlay) => {
      event.stopPropagation();
      dispatch({ textId: overlay.id, type: 'SELECT_TEXT' });
      setDragMode({
        startEnd: overlay.end,
        startStart: overlay.start,
        startTrackId: overlay.trackId,
        startX: event.clientX,
        startY: event.clientY,
        textId: overlay.id,
        type: 'timeline-text-move',
      });
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [setDragMode],
  );

  const onPreviewTextPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>, overlay: TextOverlay) => {
      event.stopPropagation();
      dispatch({ textId: overlay.id, type: 'SELECT_TEXT' });
      setDragMode({
        startTextX: overlay.x,
        startTextY: overlay.y,
        startX: event.clientX,
        startY: event.clientY,
        textId: overlay.id,
        type: 'preview-text-move',
      });
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [setDragMode],
  );

  const onPreviewTextScalePointerDown = useCallback(
    (event: PointerEvent<HTMLSpanElement>, overlay: TextOverlay) => {
      event.stopPropagation();
      dispatch({ textId: overlay.id, type: 'SELECT_TEXT' });
      setDragMode({
        startSize: overlay.size,
        startX: event.clientX,
        textId: overlay.id,
        type: 'preview-text-scale',
      });
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [setDragMode],
  );

  const onPreviewClipPointerDown = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      if (!activeClip) {
        return;
      }

      event.stopPropagation();
      dispatch({ clipId: activeClip.id, type: 'SELECT_CLIP' });
      setDragMode({
        clipId: activeClip.id,
        startTransform: activeClip.transform ?? { scale: 1, x: 0.5, y: 0.5 },
        startX: event.clientX,
        startY: event.clientY,
        type: 'preview-clip-move',
      });
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [activeClip, setDragMode],
  );

  const onPreviewClipScalePointerDown = useCallback(
    (event: PointerEvent<HTMLSpanElement>) => {
      if (!activeClip) {
        return;
      }

      event.stopPropagation();
      dispatch({ clipId: activeClip.id, type: 'SELECT_CLIP' });
      setDragMode({
        clipId: activeClip.id,
        startScale: activeClip.transform?.scale ?? 1,
        startX: event.clientX,
        type: 'preview-clip-scale',
      });
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [activeClip, setDragMode],
  );

  const onTimelinePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const mode = dragModeRef.current;
      if (!mode) {
        return;
      }

      updateFromPointer(event, mode);
    },
    [updateFromPointer],
  );

  const onTimelinePointerUp = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const mode = dragModeRef.current;
      const time = updateFromPointer(event, mode);

      // Discard any throttled drag dispatch — the pointerup dispatch below
      // carries the final snapped value and is the one that records history.
      cancelPendingDragAction();

      if (mode?.type === 'clip-move' && time !== null) {
        if (!isClipReorderDrag(mode.startX, mode.startY, event.clientX, event.clientY, CLIP_REORDER_DRAG_THRESHOLD_PX)) {
          setDragMode(null);
          hideSnapIndicator();
          return;
        }

        const deltaSeconds = (event.clientX - mode.startX) / timelinePixelsPerSecond;
        const startingTrack = present.tracks.find((track) => track.id === mode.startTrackId);
        const dragKind: 'audio' | 'video' = startingTrack?.kind === 'audio' ? 'audio' : 'video';
        const draggedClip = present.clips.find((c) => c.id === mode.clipId);
        const clipDuration = draggedClip ? getClipDuration(draggedClip) : 0;
        const rawStart = Math.max(0, mode.startTimelineStart + deltaSeconds);
        const snappedStart = resolveSnap(rawStart, {
          event,
          excludeClipId: mode.clipId,
          includeOtherEdge: rawStart + clipDuration,
        });
        dispatch({
          clipId: mode.clipId,
          timelineStart: snappedStart,
          trackId: getTimelineTrackIdFromClientY(event.clientY, dragKind),
          type: 'MOVE_CLIP',
        });
      }

      if (mode?.type === 'timeline-text-move') {
        if (!isClipReorderDrag(mode.startX, mode.startY, event.clientX, event.clientY, CLIP_REORDER_DRAG_THRESHOLD_PX)) {
          setDragMode(null);
          hideSnapIndicator();
          return;
        }

        const overlayDuration = Math.max(0.1, mode.startEnd - mode.startStart);
        const deltaSeconds = (event.clientX - mode.startX) / timelinePixelsPerSecond;
        const rawStart = clamp(mode.startStart + deltaSeconds, 0, Math.max(0, duration - overlayDuration));
        const nextStart = resolveSnap(rawStart, {
          event,
          excludeTextId: mode.textId,
          includeOtherEdge: rawStart + overlayDuration,
        });

        dispatch({
          patch: {
            end: nextStart + overlayDuration,
            start: nextStart,
            trackId: getTimelineTrackIdFromClientY(event.clientY, 'text'),
          },
          textId: mode.textId,
          type: 'UPDATE_TEXT',
        });
      }

      if (mode?.type === 'playhead' && mode.wasPlaying) {
        void playPlayback();
      }

      hideSnapIndicator();
      setDragMode(null);
      markSeekEnd();
    },
    [cancelPendingDragAction, duration, getTimelineTrackIdFromClientY, hideSnapIndicator, markSeekEnd, playPlayback, present, resolveSnap, setDragMode, timelinePixelsPerSecond, updateFromPointer],
  );

  const onAssetDragStart = useCallback((event: ReactDragEvent<HTMLDivElement>, asset: ProjectAsset) => {
    if (asset.duration <= 0) {
      event.preventDefault();
      return;
    }

    dispatch({ assetId: asset.id, type: 'SELECT_ASSET' });
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData(ASSET_DRAG_TYPE, asset.id);
    event.dataTransfer.setData('text/plain', asset.id);
  }, []);

  const onTimelineDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    const types = Array.from(event.dataTransfer.types);

    if (!types.includes(ASSET_DRAG_TYPE) && event.dataTransfer.files.length === 0) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setIsTimelineDropTarget(true);
  }, []);

  const onTimelineDragLeave = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (event.currentTarget === event.target) {
      setIsTimelineDropTarget(false);
    }
  }, []);

  const onTimelineDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setIsDraggingOver(false);
      setIsTimelineDropTarget(false);

      const assetId = event.dataTransfer.getData(ASSET_DRAG_TYPE);

      if (assetId) {
        const asset = getAssetById(present, assetId);
        const kind = asset?.kind ?? 'video';
        const time = getTimelineTimeFromClientX(event.clientX);
        const trackId = getTimelineTrackIdFromClientY(event.clientY, kind);
        addAssetToTimeline(assetId, time, trackId);
        return;
      }

      if (event.dataTransfer.files.length > 0) {
        loadFiles(event.dataTransfer.files);
      }
    },
    [addAssetToTimeline, getTimelineTimeFromClientX, getTimelineTrackIdFromClientY, loadFiles, present],
  );

  const onPreviewLoadedMetadata = useCallback(() => {
    const active = getClipAtTime(present, playhead);
    const media = getActiveMediaElement();

    if (!active || !media) {
      return;
    }

    seekVideoSafely(media, active.clip.sourceIn + active.localTime);
    media.playbackRate = playbackRate;

    if (isPlaying) {
      void media.play();
    }
  }, [getActiveMediaElement, isPlaying, playbackRate, playhead, present]);

  const onPreviewPlaybackError = useCallback(() => {
    if (!activeAsset || activeAsset.playbackUrl === activeAsset.originalUrl) {
      return;
    }

    dispatch({
      assetId: activeAsset.id,
      metadata: {
        playbackUrl: activeAsset.originalUrl,
        proxyStatus: {
          error: 'Preview proxy failed; using original media.',
          progress: 0,
          state: 'error',
        },
        proxyUrl: null,
      },
      type: 'UPDATE_ASSET',
    });
    setImportNotice('Preview proxy failed; Chitra switched back to the original media.');
  }, [activeAsset]);

  const onPreviewTimeUpdate = useCallback(() => {
    const media = getActiveMediaElement();
    const active = activePlaybackRef.current;

    if (!media || !active || !isPlaying) {
      return;
    }

    if (media.currentTime >= active.sourceOut - 0.025) {
      const audioStillActive = getAudioClipsAtTime(present, active.clipEnd).length > 0;
      const nextClip = getNextClipAfter(present, active.clipEnd);

      if (!audioStillActive && (!nextClip || active.clipEnd >= duration - 0.025)) {
        media.pause();
        applyVisualTime(duration);
        setPlayhead(duration);
        setIsPlaying(false);
        return;
      }

      // Audio that started before the video ends should keep playing.
      // When only a gap to the next clip remains, jump to it.
      const nextTime = audioStillActive
        ? active.clipEnd
        : Math.max(active.clipEnd, nextClip?.timelineStart ?? duration);
      applyVisualTime(nextTime);
      setPlayhead(nextTime);
    }
  }, [applyVisualTime, duration, getActiveMediaElement, isPlaying, present]);

  const onFileInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      if (event.target.files) {
        loadFiles(event.target.files);
        event.target.value = '';
      }
    },
    [loadFiles],
  );

  const onAppKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      const isTextInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';

      if (event.metaKey || event.ctrlKey) {
        if (event.key.toLowerCase() === 'z') {
          event.preventDefault();
          dispatch({ type: event.shiftKey ? 'REDO' : 'UNDO' });
        }

        if (event.key.toLowerCase() === 'e') {
          event.preventDefault();
          void exportProject();
        }
        return;
      }

      if (isTextInput) {
        return;
      }

      if (event.code === 'Space') {
        event.preventDefault();
        togglePlayback();
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        deleteSelected();
      } else if (event.key.toLowerCase() === 'b' || event.key.toLowerCase() === 's') {
        event.preventDefault();
        splitAtPlayhead();
      } else if (event.key.toLowerCase() === 't') {
        event.preventDefault();
        addTextOverlay();
      }
    },
    [addTextOverlay, deleteSelected, exportProject, splitAtPlayhead, togglePlayback],
  );

  useEffect(() => {
    folderInputRef.current?.setAttribute('webkitdirectory', '');
    folderInputRef.current?.setAttribute('directory', '');
  }, []);

  useEffect(() => {
    const node = viewerStageRef.current;

    if (!node) {
      return;
    }

    const updateViewerSize = () => {
      const rect = node.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);

      setViewerSize((current) => (current.width === width && current.height === height ? current : { height, width }));
    };

    updateViewerSize();
    window.addEventListener('resize', updateViewerSize);

    if (!('ResizeObserver' in window)) {
      return () => window.removeEventListener('resize', updateViewerSize);
    }

    const observer = new ResizeObserver(updateViewerSize);
    observer.observe(node);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateViewerSize);
    };
  }, []);

  useEffect(() => {
    activePlaybackRef.current = activeTimeline
      ? {
          clipEnd: activeTimeline.clipEnd,
          clipId: activeTimeline.clip.id,
          clipStart: activeTimeline.clipStart,
          sourceIn: activeTimeline.clip.sourceIn,
          sourceOut: activeTimeline.clip.sourceOut,
        }
      : null;
  }, [activeTimeline]);

  useEffect(() => {
    const media = getActiveMediaElement();

    if (!media || !activeTimeline) {
      return;
    }

    media.volume = activeTimeline.clip.muted ? 0 : clamp(activeTimeline.clip.volume, 0, 1);
    media.muted = activeTimeline.clip.muted;
    media.playbackRate = playbackRate;
  }, [activeTimeline, getActiveMediaElement, playbackRate]);

  useEffect(() => {
    audioMeterGainRef.current = {
      muted: activeTimeline?.clip.muted ?? false,
      volume: clamp(activeTimeline?.clip.volume ?? 1, 0, 1),
    };
  }, [activeTimeline?.clip.muted, activeTimeline?.clip.volume]);

  // When the active media element changes (clip transition, asset swap),
  // wire its source into the existing audio graph. This only takes effect
  // AFTER ensureAudioMeterChain has been called once from a user gesture —
  // before that, there's no AudioContext and no analyser, and the element
  // is playing through its native audio output (also fine).
  useEffect(() => {
    if (!activeAsset) {
      return;
    }
    if (!audioContextRef.current || !audioAnalyserRef.current) {
      return;
    }
    ensureAudioMeterChain();
  }, [activeAsset, ensureAudioMeterChain]);

  // Surface a 'N/A' readout when Web Audio is unavailable at all (very rare,
  // e.g. some older browsers). This runs once.
  useEffect(() => {
    if (!getAudioContextConstructor() && audioMeterReadoutRef.current) {
      audioMeterReadoutRef.current.textContent = 'N/A';
    }
  }, []);

  // Tear down the singleton AudioContext when the editor unmounts.
  useEffect(() => {
    return () => {
      const context = audioContextRef.current;
      audioAnalyserRef.current = null;
      audioMeterDataRef.current = null;
      audioContextRef.current = null;
      if (context) {
        void context.close().catch(() => undefined);
      }
    };
  }, []);

  useEffect(() => {
    let animationFrame = 0;
    let lastPaintAt = 0;
    let peakPosition = 0;
    let peakDb = AUDIO_METER_FLOOR_DB;

    const tick = () => {
      // Pause the meter while the tab is hidden — the analyser samples 30+
      // times a second and the work is invisible anyway. Resume on
      // 'visibilitychange'.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        animationFrame = window.requestAnimationFrame(() => tick());
        return;
      }

      const analyser = audioAnalyserRef.current;
      const data = audioMeterDataRef.current;
      let meterPos = 0;
      let dBFS = AUDIO_METER_FLOOR_DB;

      if (isPlaying && analyser && data) {
        analyser.getByteTimeDomainData(data);

        let sum = 0;
        for (const value of data) {
          const centered = (value - 128) / 128;
          sum += centered * centered;
        }

        const rms = Math.sqrt(sum / data.length);
        const gain = audioMeterGainRef.current;
        const adjustedAmplitude = gain.muted ? 0 : Math.min(1, rms * gain.volume);

        dBFS = amplitudeToDbfs(adjustedAmplitude);
        meterPos = dbfsToMeterPosition(dBFS);
      }

      if (isPlaying) {
        peakPosition = Math.max(meterPos, peakPosition * 0.94);
        peakDb = Math.max(dBFS, peakDb - 0.6);
      } else {
        peakPosition = peakPosition * 0.86;
        peakDb = Math.max(AUDIO_METER_FLOOR_DB, peakDb - 1.5);
      }

      const now = performance.now();

      if (now - lastPaintAt > 40 || !isPlaying) {
        paintAudioMeter(meterPos, peakPosition, dBFS);
        lastPaintAt = now;
      }

      if (isPlaying || peakPosition > 0.01) {
        animationFrame = window.requestAnimationFrame(() => tick());
      } else {
        paintAudioMeter(0, 0, AUDIO_METER_FLOOR_DB);
      }
    };

    if (isPlaying) {
      void audioContextRef.current?.resume().catch(() => undefined);
    }

    tick();

    return () => window.cancelAnimationFrame(animationFrame);
  }, [activeAsset?.playbackUrl, isPlaying, paintAudioMeter]);

  useEffect(() => {
    const media = getActiveMediaElement();
    const previousClipId = previousActiveClipIdRef.current;
    const nextClipId = activeTimeline?.clip.id ?? null;
    const clipChanged = previousClipId !== nextClipId;
    previousActiveClipIdRef.current = nextClipId;

    if (!media || !activeTimeline || !activeAsset) {
      return;
    }

    if (!isPlaying || clipChanged) {
      const targetTime = activeTimeline.clip.sourceIn + activeTimeline.localTime;

      if (Math.abs(media.currentTime - targetTime) > 0.05) {
        seekVideoSafely(media, targetTime);
      }
    }

    if (isPlaying && clipChanged) {
      void media.play();
    }
  }, [activeAsset, activeTimeline, getActiveMediaElement, isPlaying]);

  useEffect(() => {
    setPlayhead((current) => clamp(current, 0, duration || 0));
  }, [duration]);

  useEffect(() => {
    performanceMonitor.setRenderedTimelineItems(Math.min(present.clips.length, virtualThumbnails.length || present.clips.length), present.clips.length);
  }, [present.clips.length, virtualThumbnails.length]);

  useEffect(() => {
    savedRecordRef.current = record;
    setProjectName(record.name);
    setProjectSettings(record.settings);
  }, [record]);

  const onRecordSavedRef = useRef(onRecordSaved);
  useEffect(() => {
    onRecordSavedRef.current = onRecordSaved;
  }, [onRecordSaved]);

  useEffect(() => {
    if (!canAutosave) {
      setSaveStatus('failed');
      return;
    }

    const saveTimer = window.setTimeout(() => {
      setSaveStatus('saving');
      void saveRuntimeProjectRecord(savedRecordRef.current, present, projectName, projectSettings, {
        allowAssetLoss: allowEmptyProjectSaveRef.current,
      })
        .then((nextRecord) => {
          allowEmptyProjectSaveRef.current = false;
          savedRecordRef.current = nextRecord;
          onRecordSavedRef.current(nextRecord);
          setSaveStatus('saved');
        })
        .catch(() => {
          setSaveStatus('failed');
        });
    }, 750);

    return () => window.clearTimeout(saveTimer);
  }, [canAutosave, present, projectName, projectSettings]);

  useEffect(() => {
    if (revokeObjectUrlsTimerRef.current !== null) {
      window.clearTimeout(revokeObjectUrlsTimerRef.current);
      revokeObjectUrlsTimerRef.current = null;
    }

    hydratedProject.objectUrls.forEach(registerObjectUrl);

    return () => {
      exportJobCancelRef.current?.();
      if (dragRafIdRef.current !== null) {
        window.cancelAnimationFrame(dragRafIdRef.current);
        dragRafIdRef.current = null;
      }
      pendingDragActionRef.current = null;
      const urlsToRevoke = [...objectUrlsRef.current];

      if (revokeObjectUrlsTimerRef.current !== null) {
        window.clearTimeout(revokeObjectUrlsTimerRef.current);
      }

      revokeObjectUrlsTimerRef.current = window.setTimeout(() => {
        urlsToRevoke.forEach((url) => URL.revokeObjectURL(url));
        objectUrlsRef.current = objectUrlsRef.current.filter((url) => !urlsToRevoke.includes(url));
        revokeObjectUrlsTimerRef.current = null;
      }, 1000);
    };
  }, [hydratedProject.objectUrls, registerObjectUrl]);

  useEffect(() => {
    for (const asset of present.assets) {
      if (asset.duration > 0 || metadataJobsRef.current.has(asset.id)) {
        continue;
      }

      metadataJobsRef.current.add(asset.id);
      const loader = asset.kind === 'audio' ? loadAudioMetadata : loadVideoMetadata;
      loader(asset.originalUrl)
        .then(async (metadata) => {
          if (metadata.posterUrl) {
            registerObjectUrl(metadata.posterUrl);
            await storeRuntimePoster(record.id, asset.id, metadata.posterUrl);
          }

          dispatch({
            assetId: asset.id,
            metadata: {
              duration: metadata.duration,
              height: metadata.height,
              posterUrl: metadata.posterUrl,
              width: metadata.width,
            },
            type: 'UPDATE_ASSET',
          });
        })
        .catch((error) => {
          dispatch({
            assetId: asset.id,
            metadata: {
              proxyStatus: {
                error: error instanceof Error ? error.message : 'Metadata load failed.',
                progress: 0,
                state: 'error',
              },
            },
            type: 'UPDATE_ASSET',
          });
        });
    }

    if (!canAutosave && isProjectFullyHydrated(present)) {
      setCanAutosave(true);
    }
  }, [canAutosave, present, record.id, registerObjectUrl]);

  useEffect(() => {
    if (proxyJobsRef.current.size > 0) {
      return;
    }

    const nextAsset = present.assets.find(
      (asset) =>
        asset.kind === 'video' &&
        asset.duration > 0 &&
        shouldUsePreviewProxy(asset.file, asset.width, asset.height) &&
        asset.proxyStatus.state === 'idle' &&
        !proxyJobsRef.current.has(asset.id),
    );

    if (!nextAsset) {
      return;
    }

    const fingerprint = createMediaFingerprint(nextAsset.file, nextAsset.duration);
    const cacheKey = createProxyCacheKey(fingerprint, 720);
    proxyJobsRef.current.add(nextAsset.id);
    dispatch({
      assetId: nextAsset.id,
      metadata: { proxyStatus: { error: null, progress: 0, state: 'running' } },
      type: 'UPDATE_ASSET',
    });
    performanceMonitor.markTranscodeStart('proxy');

    getCachedProxy(cacheKey)
      .then(async (cached) => {
        if (cached) {
          const url = URL.createObjectURL(cached);
          try {
            await assertPlayableVideoUrl(url);
          } catch {
            URL.revokeObjectURL(url);
            throw new Error('Cached proxy was not playable.');
          }

          registerObjectUrl(url);
          performanceMonitor.markTranscodeComplete('proxy', 0);
          dispatch({
            assetId: nextAsset.id,
            metadata: {
              playbackUrl: url,
              proxyStatus: { error: null, progress: 100, state: 'complete' },
              proxyUrl: url,
            },
            type: 'UPDATE_ASSET',
          });
          return null;
        }

        const job = runTranscodeJob({
          duration: nextAsset.duration,
          effects: DEFAULT_EFFECT_SETTINGS,
          file: nextAsset.file,
          inPoint: 0,
          kind: 'generate-proxy',
          onProgress: ({ progress }) => {
            performanceMonitor.markTranscodeProgress('proxy', progress);
            dispatch({
              assetId: nextAsset.id,
              metadata: {
                proxyStatus: { error: null, progress: Math.round(progress * 100), state: 'running' },
              },
              type: 'UPDATE_ASSET',
            });
          },
          outPoint: nextAsset.duration,
          targetHeight: 720,
        });

        return job.promise.then(async (result) => {
          const url = URL.createObjectURL(result.blob);
          try {
            await assertPlayableVideoUrl(url);
          } catch {
            URL.revokeObjectURL(url);
            throw new Error('Generated proxy was not playable.');
          }

          await putCachedProxy(cacheKey, result.blob);
          await putJobMetadata(cacheKey, {
            generatedAt: Date.now(),
            originalBytes: nextAsset.size,
            outputBytes: result.outputBytes,
            tookMs: result.tookMs,
          });
          registerObjectUrl(url);
          performanceMonitor.markTranscodeComplete('proxy', result.tookMs);
          dispatch({
            assetId: nextAsset.id,
            metadata: {
              playbackUrl: url,
              proxyStatus: { error: null, progress: 100, state: 'complete' },
              proxyUrl: url,
            },
            type: 'UPDATE_ASSET',
          });
        });
      })
      .catch((error) => {
        performanceMonitor.markTranscodeFailed('proxy');
        void deleteCachedProxy(cacheKey);
        dispatch({
          assetId: nextAsset.id,
          metadata: {
            playbackUrl: nextAsset.originalUrl,
            proxyUrl: null,
            proxyStatus: {
              error: error instanceof Error ? error.message : 'Proxy generation failed.',
              progress: 0,
              state: 'error',
            },
          },
          type: 'UPDATE_ASSET',
        });
      })
      .finally(() => {
        proxyJobsRef.current.delete(nextAsset.id);
      });
  }, [present.assets, registerObjectUrl]);

  return (
    <div
      className={`editor-shell${isDraggingOver ? ' is-dragging' : ''}${isTheater ? ' is-theater' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        setIsDraggingOver(true);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setIsDraggingOver(false);
        loadFiles(event.dataTransfer.files);
      }}
      onKeyDown={onAppKeyDown}
      tabIndex={-1}
    >
      <input className="file-input" multiple onChange={onFileInputChange} ref={fileInputRef} type="file" />
      <input className="file-input" onChange={onFileInputChange} ref={folderInputRef} type="file" />

      <header className="topbar">
        <div className="brand-lockup">
          <button className="icon-button small" onClick={onBackToDashboard} title="Back to dashboard" type="button">
            <ArrowLeft size={15} />
          </button>
          <span className="brand-mark">
            <Film size={17} />
          </span>
          <div>
            <h1>Chitra</h1>
            <input
              className="project-name-input"
              onChange={(event) => setProjectName(event.target.value)}
              ref={projectNameInputRef}
              value={projectName}
            />
          </div>
        </div>

        <div className="project-state">
          <strong>{projectStatus.label}</strong>
          <span>{saveStatus === 'saving' ? 'Saving' : saveStatus === 'failed' ? 'Save failed' : 'Saved'} | {projectStatus.detail}</span>
        </div>

        <div className="topbar-actions">
          <button
            className="icon-button"
            onClick={() => setShowProjectSettings((value) => !value)}
            title="Project settings"
            type="button"
          >
            <Settings size={15} />
          </button>
          <button className="button secondary" onClick={() => void exportCurrentProjectPackage()} type="button">
            <FileArchive size={15} />
            Project
          </button>
          {exportStatus.state === 'running' ? (
            <button className="button secondary" onClick={cancelExport} type="button">
              <X size={15} />
              Cancel
            </button>
          ) : (
            <button className="button" disabled={!hasTimeline || isProxyRunning} onClick={() => void exportProject()} type="button">
              <Download size={15} />
              {isProxyRunning ? 'Preparing' : 'Export MP4'}
            </button>
          )}
        </div>
      </header>

      {showProjectSettings ? (
        <ProjectSettingsPanel
          editArrayText={editArrayText}
          onClose={() => setShowProjectSettings(false)}
          onSettingsChange={setProjectSettings}
          settings={projectSettings}
        />
      ) : null}

      <main className="workspace">
        <aside className="panel media-bin">
          <div className="panel-header">
            <div>
              <h2>Media</h2>
              <span>{present.assets.length} assets</span>
            </div>
            <div className="panel-actions">
              <button
                aria-label="Import video files"
                className="icon-button small"
                onClick={() => fileInputRef.current?.click()}
                title="Import video files"
                type="button"
              >
                <Upload size={15} />
              </button>
              <button
                aria-label="Import a folder"
                className="icon-button small"
                onClick={openFolderImport}
                title="Import a folder"
                type="button"
              >
                <FolderOpen size={15} />
              </button>
            </div>
          </div>

          {present.assets.length === 0 ? (
            <button className="import-drop" onClick={() => fileInputRef.current?.click()} type="button">
              <Upload size={20} />
              <strong>Import videos</strong>
              <span>Drop files here, click to browse, or use the folder button above.</span>
            </button>
          ) : (
            <div className="asset-list">
              {present.assets.map((asset) => (
                <div
                  className={`asset-row${asset.id === present.selectedAssetId ? ' is-selected' : ''}`}
                  draggable={asset.duration > 0}
                  key={asset.id}
                  onDragStart={(event) => onAssetDragStart(event, asset)}
                  title={asset.duration > 0 ? 'Drag to timeline' : 'Reading media metadata'}
                >
                  <button
                    className="asset-main"
                    onClick={() => dispatch({ assetId: asset.id, type: 'SELECT_ASSET' })}
                    type="button"
                  >
                    <span className="asset-poster">
                      {asset.posterUrl ? (
                        <img alt="" src={asset.posterUrl} />
                      ) : asset.kind === 'audio' ? (
                        <Music size={18} />
                      ) : (
                        <Film size={18} />
                      )}
                    </span>
                    <span>
                      <strong>{asset.name}</strong>
                      <small>
                        {asset.duration > 0 ? formatClock(asset.duration) : 'Reading'} | {formatBytes(asset.size)}
                      </small>
                    </span>
                  </button>
                  <button
                    aria-label={`Add ${asset.name} to timeline`}
                    className="icon-button small"
                    disabled={asset.duration <= 0}
                    onClick={() => addAssetToTimeline(asset.id)}
                    title="Add to timeline"
                    type="button"
                  >
                    <StepForward size={14} />
                  </button>
                  <button
                    aria-label={`Delete ${asset.name} from media library`}
                    className="icon-button small"
                    onClick={(event) => {
                      event.stopPropagation();
                      deleteAssetFromLibrary(asset.id);
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    title="Delete from media library"
                    type="button"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </aside>

        <section className="viewer-column">
          <div className="viewer-topline">
            <div>
              <strong>{activeAsset?.name ?? 'No active clip'}</strong>
              <span>{activeTimeline ? `${formatClock(activeTimeline.localTime)} in clip` : 'Build a timeline to preview'}</span>
            </div>
            <button className="icon-button small" onClick={() => setIsTheater((value) => !value)} title="Toggle viewer size" type="button">
              <Maximize2 size={15} />
            </button>
          </div>

          <div className={`viewer-stage${!hasTimeline ? ' is-empty' : ''}`} ref={viewerStageRef}>
            {hasTimeline && activeAsset ? (
              <div
                className="preview-frame"
                onPointerCancel={endPreviewDirectManipulation}
                onPointerMove={updatePreviewDirectManipulation}
                onPointerUp={endPreviewDirectManipulation}
                ref={previewFrameRef}
                style={previewFrameStyle}
              >
                {/* Skip layer videos entirely when the topmost active clip covers the canvas
                    (default 1:1 transform). With opaque video clips, anything below is fully
                    occluded — mounting their <video> elements just allocates idle decoders. */}
                {activeClip && !isClipTransformFullScreen(activeClip.transform)
                  ? activeLayerTimelines
                      .filter((timeline) => timeline.clip.id !== activeClip.id)
                      .map((timeline) => {
                        const layerAsset = getClipAsset(present, timeline.clip);

                        return layerAsset ? (
                          <PreviewLayerVideo
                            asset={layerAsset}
                            clip={timeline.clip}
                            isPlaying={isPlaying}
                            key={timeline.clip.id}
                            localTime={timeline.localTime}
                            playbackRate={playbackRate}
                            style={getClipTransformStyle(timeline.clip)}
                          />
                        ) : null;
                      })
                  : null}
                {activeAudioLayerTimelines
                  .filter((timeline) => !(activePrimaryKind === 'audio' && timeline.clip.id === activeTimeline?.clip.id))
                  .map((timeline) => {
                    const layerAsset = getClipAsset(present, timeline.clip);

                    return layerAsset ? (
                      <PreviewLayerAudio
                        asset={layerAsset}
                        clip={timeline.clip}
                        isPlaying={isPlaying}
                        key={timeline.clip.id}
                        localTime={timeline.localTime}
                        playbackRate={playbackRate}
                      />
                    ) : null;
                  })}
                {activeAsset.kind === 'video' ? (
                  <video
                    className={isGpuPreviewActive ? 'is-composited' : undefined}
                    key={activeAsset.playbackUrl}
                    onError={onPreviewPlaybackError}
                    onLoadedMetadata={onPreviewLoadedMetadata}
                    onSeeked={markSeekEnd}
                    onTimeUpdate={onPreviewTimeUpdate}
                    playsInline
                    preload="auto"
                    ref={attachVideoRef}
                    src={activeAsset.playbackUrl}
                    style={activeClipTransformStyle}
                  />
                ) : (
                  <>
                    <div className="audio-only-stage" aria-hidden="true">
                      <Music size={42} />
                      <strong>{activeAsset.name}</strong>
                      <span>Audio only</span>
                    </div>
                    <audio
                      key={activeAsset.playbackUrl}
                      onError={onPreviewPlaybackError}
                      onLoadedMetadata={onPreviewLoadedMetadata}
                      onSeeked={markSeekEnd}
                      onTimeUpdate={onPreviewTimeUpdate}
                      preload="auto"
                      ref={attachAudioPrimaryRef}
                      src={activeAsset.playbackUrl}
                    />
                  </>
                )}
                <canvas
                  className={`gpu-canvas${isGpuPreviewActive ? ' is-active' : ''}`}
                  ref={previewCanvasRef}
                  style={activeClipTransformStyle}
                />
                {activeClip && activePrimaryKind === 'video' ? (
                  <button
                    aria-label="Move selected clip on canvas"
                    className={`clip-transform-box${activeClip.id === present.selectedClipId ? ' is-selected' : ''}`}
                    onPointerDown={onPreviewClipPointerDown}
                    style={activeClipTransformStyle}
                    type="button"
                  >
                    <span
                      aria-hidden="true"
                      className="canvas-scale-handle clip-scale-handle"
                      onPointerDown={onPreviewClipScalePointerDown}
                    />
                  </button>
                ) : null}
                <div className="text-overlay-layer">
                  {activeTextOverlays.map((overlay) => (
                    <div
                      className={`preview-text align-${overlay.align}${overlay.id === present.selectedTextId ? ' is-selected' : ''}`}
                      key={overlay.id}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          dispatch({ textId: overlay.id, type: 'SELECT_TEXT' });
                        }
                      }}
                      onPointerDown={(event) => onPreviewTextPointerDown(event, overlay)}
                      role="button"
                      style={{
                        fontSize: `${overlay.size}px`,
                        left: `${overlay.x * 100}%`,
                        top: `${overlay.y * 100}%`,
                      }}
                      tabIndex={0}
                    >
                      {overlay.text}
                      <span
                        aria-hidden="true"
                        className="canvas-scale-handle text-scale-handle"
                        onPointerDown={(event) => onPreviewTextScalePointerDown(event, overlay)}
                      />
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <button className="empty-viewer" onClick={() => fileInputRef.current?.click()} type="button">
                <Film size={32} />
                <strong>Import clips to start editing</strong>
                <span>Then add them to the timeline, split, trim, reorder, add text, and export.</span>
              </button>
            )}
          </div>

          <div className="transport">
            <div className="transport-group">
              <button className="icon-button" disabled={!hasTimeline} onClick={() => stepBy(-FRAME_STEP)} title="Previous frame" type="button">
                <StepBack size={16} />
              </button>
              <button className="play-button" disabled={!hasTimeline} onClick={togglePlayback} title="Play / pause" type="button">
                {isPlaying ? <Pause size={18} /> : <Play size={18} />}
              </button>
              <button className="icon-button" disabled={!hasTimeline} onClick={() => stepBy(FRAME_STEP)} title="Next frame" type="button">
                <StepForward size={16} />
              </button>
            </div>

            <div className="time-readout">
              <strong>{formatClock(playhead)}</strong>
              <span>/ {formatClock(duration)}</span>
            </div>

            <div className="transport-group">
              <label className="select-control">
                <span>Rate</span>
                <select onChange={(event) => setPlaybackRate(Number(event.target.value))} value={playbackRate}>
                  <option value={0.5}>0.5x</option>
                  <option value={1}>1x</option>
                  <option value={1.5}>1.5x</option>
                  <option value={2}>2x</option>
                </select>
              </label>
            </div>
          </div>
        </section>

        <aside className="panel right-panel">
          <div className="right-panel-tabs" role="tablist">
            <button
              aria-selected={rightPanelTab === 'inspector'}
              className={`right-panel-tab${rightPanelTab === 'inspector' ? ' is-active' : ''}`}
              onClick={() => setRightPanelTab('inspector')}
              role="tab"
              type="button"
            >
              Inspector
            </button>
            <button
              aria-selected={rightPanelTab === 'chat'}
              className={`right-panel-tab${rightPanelTab === 'chat' ? ' is-active' : ''}`}
              onClick={() => setRightPanelTab('chat')}
              role="tab"
              type="button"
            >
              Chat
            </button>
          </div>
          <div className="right-panel-body">
            {rightPanelTab === 'inspector' ? (
              <Inspector
                addAssetToTimeline={() => addAssetToTimeline(selectedAsset?.id ?? null)}
                capabilities={capabilities}
                deleteSelected={deleteSelected}
                deleteAssetFromLibrary={deleteAssetFromLibrary}
                dispatch={dispatch}
                hasTimeline={hasTimeline}
                project={present}
                selectedAsset={selectedAsset}
                selectedClip={selectedClip}
                selectedClipAsset={selectedClipAsset}
                selectedText={selectedText}
                splitAtPlayhead={splitAtPlayhead}
              />
            ) : (
              <ChatPanel />
            )}
          </div>
        </aside>
      </main>

      <section className="timeline-panel">
        <div className="timeline-toolbar">
          <div className="timeline-title">
            <strong>Timeline</strong>
            <span>{present.clips.length} clips</span>
          </div>

          <div className="quick-actions">
            <button aria-label="Split at playhead" className="icon-button" disabled={!hasTimeline} onClick={splitAtPlayhead} title="Split at playhead" type="button">
              <Scissors size={15} />
            </button>
            <button aria-label="Add text overlay" className="icon-button" disabled={!hasTimeline} onClick={addTextOverlay} title="Add text overlay" type="button">
              <Type size={15} />
            </button>
            <button aria-label="Delete selected item" className="icon-button" disabled={!selectedClip && !selectedText} onClick={deleteSelected} title="Delete selected item" type="button">
              <Trash2 size={15} />
            </button>
          </div>

          <div className="timeline-tools">
            <button
              aria-label={snapEnabled ? 'Disable snapping' : 'Enable snapping'}
              className={`icon-button small${snapEnabled ? ' is-active' : ''}`}
              onClick={() => setSnapEnabled((value) => !value)}
              title={snapEnabled ? 'Snapping on — hold ⌘/Ctrl to bypass' : 'Snapping off'}
              type="button"
            >
              <Magnet size={15} />
            </button>
            <button aria-label="Zoom timeline out" className="icon-button small" onClick={() => setTimelineZoom((value) => clamp(value - 0.2, 0.5, 3))} title="Zoom timeline out" type="button">
              <ZoomOut size={15} />
            </button>
            <span>{Math.round(timelineZoom * 100)}%</span>
            <button aria-label="Zoom timeline in" className="icon-button small" onClick={() => setTimelineZoom((value) => clamp(value + 0.2, 0.5, 3))} title="Zoom timeline in" type="button">
              <ZoomIn size={15} />
            </button>
            <button aria-label="Toggle performance HUD" className={`icon-button small${showPerfHud ? ' is-active' : ''}`} onClick={() => setShowPerfHud((value) => !value)} title="Toggle performance HUD" type="button">
              <Activity size={15} />
            </button>
          </div>
        </div>

        <div className="timeline-body">
          <div className="timeline-scroll" ref={timelineScrollRef}>
            <div
              className={`timeline-canvas${isTimelineDropTarget ? ' is-drop-target' : ''}`}
              onDragLeave={onTimelineDragLeave}
              onDragOver={onTimelineDragOver}
              onDrop={onTimelineDrop}
              onPointerDown={onTimelinePointerDown}
              onPointerMove={onTimelinePointerMove}
              onPointerUp={onTimelinePointerUp}
              ref={timelineRef}
              style={
                {
                  '--timeline-label-width': `${TIMELINE_LABEL_WIDTH}px`,
                  height: `${timelineContentHeight}px`,
                  width: `${timelineWidth}px`,
                } as CSSProperties
              }
            >
            <div className="timeline-ruler">
              <div className="timeline-track-actions">
                <button
                  aria-label="Add video track"
                  className="icon-button small"
                  onClick={addVideoTrack}
                  onPointerDown={(event) => event.stopPropagation()}
                  title="Add video track"
                  type="button"
                >
                  <Film size={14} />
                </button>
                <button
                  aria-label="Add audio track"
                  className="icon-button small"
                  onClick={addAudioTrack}
                  onPointerDown={(event) => event.stopPropagation()}
                  title="Add audio track"
                  type="button"
                >
                  <Volume2 size={14} />
                </button>
                <button
                  aria-label="Add text track"
                  className="icon-button small"
                  onClick={addTextTrack}
                  onPointerDown={(event) => event.stopPropagation()}
                  title="Add text track"
                  type="button"
                >
                  <Type size={14} />
                </button>
              </div>
              {Array.from({ length: Math.max(2, Math.ceil(duration / 5) + 1) }, (_, index) => (
                <span key={index} style={{ left: `${TIMELINE_LABEL_WIDTH + index * 5 * timelinePixelsPerSecond}px` }}>
                  {formatClock(Math.min(index * 5, duration))}
                </span>
              ))}
            </div>

            <div className="timeline-progress" ref={progressRef} />
            <div className="timeline-playhead" ref={playheadRef}>
              <span />
            </div>
            <div aria-hidden="true" className="timeline-snap-indicator" ref={snapIndicatorRef} />

            {videoTracks.map((track, index) => {
              const top = TIMELINE_TRACK_TOP + index * (TIMELINE_TRACK_HEIGHT + TIMELINE_TRACK_GAP);
              const trackClips = present.clips.filter((clip) => clip.trackId === track.id);

              return (
                <div
                  className={`clip-track timeline-track-row${track.id === present.selectedTrackId ? ' is-selected' : ''}`}
                  data-track-id={track.id}
                  key={track.id}
                  onPointerDown={(event) => {
                    if (event.target === event.currentTarget) {
                      dispatch({ trackId: track.id, type: 'SELECT_TRACK' });
                    }
                  }}
                  style={{ top: `${top}px` }}
                >
                  <div className="track-label-shell">
                    <button
                      className="track-label"
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        dispatch({ trackId: track.id, type: 'SELECT_TRACK' });
                      }}
                      type="button"
                    >
                      <strong>{track.name}</strong>
                      <span>{track.visible ? 'Visible' : 'Hidden'}</span>
                    </button>
                    <button
                      aria-label={`Delete ${track.name}`}
                      className="track-delete"
                      disabled={track.kind === 'video' && videoTracks.length <= 1}
                      onClick={(event) => {
                        event.stopPropagation();
                        deleteTrack(track.id);
                      }}
                      onPointerDown={(event) => event.stopPropagation()}
                      title={track.kind === 'video' && videoTracks.length <= 1 ? 'Add another video track to delete this one' : 'Delete track'}
                      type="button"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                  {trackClips.length === 0 && present.clips.length === 0 && index === 0 ? (
                    <button className="empty-timeline" onClick={() => selectedAsset && addAssetToTimeline(selectedAsset.id, 0, track.id)} type="button">
                      Drag media here or select an asset and add it.
                    </button>
                  ) : null}
                  {trackClips.map((clip) => {
                    const asset = getClipAsset(present, clip);
                    const clipDuration = getClipDuration(clip);
                    const left = TIMELINE_LABEL_WIDTH + clip.timelineStart * timelinePixelsPerSecond;
                    const width = Math.max(70, clipDuration * timelinePixelsPerSecond);

                    return (
                      <button
                        className={`timeline-clip${clip.id === present.selectedClipId ? ' is-selected' : ''}`}
                        key={clip.id}
                        onPointerDown={(event) => onClipPointerDown(event, clip.id)}
                        style={{ left: `${left}px`, width: `${width}px` }}
                        type="button"
                      >
                        <TimelineClipThumbnailStrip asset={asset} clip={clip} />
                        <span className="trim-handle left" onPointerDown={(event) => onTrimPointerDown(event, clip.id, 'start')} />
                        <span className="clip-poster">
                          {asset?.posterUrl ? <img alt="" src={asset.posterUrl} /> : <Film size={16} />}
                        </span>
                        <span className="clip-label">
                          <strong>{asset?.name ?? 'Missing asset'}</strong>
                          <small>
                            {formatClock(clip.timelineStart)} | {formatClock(clip.sourceIn)} - {formatClock(clip.sourceOut)}
                          </small>
                        </span>
                        <span className="clip-audio">{clip.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}</span>
                        <span className="trim-handle right" onPointerDown={(event) => onTrimPointerDown(event, clip.id, 'end')} />
                      </button>
                    );
                  })}
                </div>
              );
            })}

            {audioTracks.map((track, index) => {
              const top = audioTracksTop + index * (TIMELINE_AUDIO_TRACK_HEIGHT + TIMELINE_TRACK_GAP);
              const trackClips = present.clips.filter((clip) => clip.trackId === track.id);

              return (
                <div
                  className={`audio-track timeline-track-row${track.id === present.selectedTrackId ? ' is-selected' : ''}`}
                  data-track-id={track.id}
                  key={track.id}
                  onPointerDown={(event) => {
                    if (event.target === event.currentTarget) {
                      dispatch({ trackId: track.id, type: 'SELECT_TRACK' });
                    }
                  }}
                  style={{ top: `${top}px`, height: `${TIMELINE_AUDIO_TRACK_HEIGHT}px` }}
                >
                  <div className="track-label-shell">
                    <button
                      className="track-label"
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        dispatch({ trackId: track.id, type: 'SELECT_TRACK' });
                      }}
                      type="button"
                    >
                      <strong>{track.name}</strong>
                      <span>{track.muted ? 'Muted' : 'Audible'}</span>
                    </button>
                    <button
                      aria-label={`Delete ${track.name}`}
                      className="track-delete"
                      onClick={(event) => {
                        event.stopPropagation();
                        deleteTrack(track.id);
                      }}
                      onPointerDown={(event) => event.stopPropagation()}
                      title="Delete track"
                      type="button"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                  {trackClips.map((clip) => {
                    const asset = getClipAsset(present, clip);
                    const clipDuration = getClipDuration(clip);
                    const left = TIMELINE_LABEL_WIDTH + clip.timelineStart * timelinePixelsPerSecond;
                    const width = Math.max(70, clipDuration * timelinePixelsPerSecond);

                    return (
                      <button
                        className={`timeline-clip timeline-clip-audio${clip.id === present.selectedClipId ? ' is-selected' : ''}`}
                        key={clip.id}
                        onPointerDown={(event) => onClipPointerDown(event, clip.id)}
                        style={{ left: `${left}px`, width: `${width}px` }}
                        type="button"
                      >
                        <span className="trim-handle left" onPointerDown={(event) => onTrimPointerDown(event, clip.id, 'start')} />
                        <span className="audio-clip-glyph">
                          <Music size={14} />
                        </span>
                        <span className="clip-label">
                          <strong>{asset?.name ?? 'Missing audio'}</strong>
                          <small>
                            {formatClock(clip.timelineStart)} | {formatClock(clip.sourceIn)} - {formatClock(clip.sourceOut)}
                          </small>
                        </span>
                        <span className="clip-audio">{clip.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}</span>
                        <span className="trim-handle right" onPointerDown={(event) => onTrimPointerDown(event, clip.id, 'end')} />
                      </button>
                    );
                  })}
                </div>
              );
            })}

            {textTracks.map((track, index) => {
              const top = textTracksTop + index * (TIMELINE_TEXT_TRACK_HEIGHT + TIMELINE_TRACK_GAP);
              const trackOverlays = present.textOverlays.filter((overlay) => overlay.trackId === track.id);

              return (
                <div
                  className={`text-track timeline-track-row${track.id === present.selectedTrackId ? ' is-selected' : ''}`}
                  data-track-id={track.id}
                  key={track.id}
                  onPointerDown={(event) => {
                    if (event.target === event.currentTarget) {
                      dispatch({ trackId: track.id, type: 'SELECT_TRACK' });
                    }
                  }}
                  style={{ top: `${top}px`, height: `${TIMELINE_TEXT_TRACK_HEIGHT}px` }}
                >
                  <div className="track-label-shell">
                    <button
                      className="track-label"
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        dispatch({ trackId: track.id, type: 'SELECT_TRACK' });
                      }}
                      type="button"
                    >
                      <strong>{track.name}</strong>
                      <span>{trackOverlays.length} overlays</span>
                    </button>
                    <button
                      aria-label={`Delete ${track.name}`}
                      className="track-delete"
                      onClick={(event) => {
                        event.stopPropagation();
                        deleteTrack(track.id);
                      }}
                      onPointerDown={(event) => event.stopPropagation()}
                      title="Delete track"
                      type="button"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                  {trackOverlays.map((overlay) => {
                    const overlayDuration = Math.max(0.1, overlay.end - overlay.start);
                    const left = TIMELINE_LABEL_WIDTH + overlay.start * timelinePixelsPerSecond;
                    const width = Math.max(70, overlayDuration * timelinePixelsPerSecond);

                    return (
                      <button
                        className={`timeline-clip timeline-clip-text${overlay.id === present.selectedTextId ? ' is-selected' : ''}`}
                        key={overlay.id}
                        onPointerDown={(event) => onTimelineTextPointerDown(event, overlay)}
                        style={{ left: `${left}px`, width: `${width}px` }}
                        type="button"
                      >
                        <span className="trim-handle left" onPointerDown={(event) => onTextTrimPointerDown(event, overlay.id, 'start')} />
                        <span className="text-clip-glyph">
                          <Type size={14} />
                        </span>
                        <span className="clip-label">
                          <strong>{overlay.text || 'Text'}</strong>
                          <small>
                            {formatClock(overlay.start)} - {formatClock(overlay.end)}
                          </small>
                        </span>
                        <span className="trim-handle right" onPointerDown={(event) => onTextTrimPointerDown(event, overlay.id, 'end')} />
                      </button>
                    );
                  })}
                </div>
              );
            })}
            </div>
          </div>
          <aside aria-label="Audio level meter" className="timeline-audio-meter" title="Audio level meter">
            <Volume2 size={14} />
            <div aria-hidden="true" className="audio-meter-track">
              <div className="audio-meter-fill" ref={audioMeterFillRef} />
              <div className="audio-meter-peak" ref={audioMeterPeakRef} />
            </div>
            <span ref={audioMeterReadoutRef}>-inf</span>
          </aside>
        </div>
      </section>

      {showPerfHud ? <PerformanceHud /> : null}
    </div>
  );
}

type AppRoute = { projectId: string; screen: 'editor' } | { screen: 'dashboard' };

function parseRoute(): AppRoute {
  const match = window.location.hash.match(/^#\/project\/(.+)$/);

  return match ? { projectId: decodeURIComponent(match[1]), screen: 'editor' } : { screen: 'dashboard' };
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function App() {
  const packageInputRef = useRef<HTMLInputElement>(null);
  const [activeRecord, setActiveRecord] = useState<ProjectRecord | null>(null);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [hydratedProject, setHydratedProject] = useState<HydratedProject | null>(null);
  const [isLoadingProject, setIsLoadingProject] = useState(false);
  const [records, setRecords] = useState<ProjectRecord[]>([]);
  const [route, setRoute] = useState<AppRoute>(() => parseRoute());

  const refreshRecords = useCallback(async () => {
    const nextRecords = await listProjectRecords();
    setRecords(nextRecords);
    return nextRecords;
  }, []);

  const openProject = useCallback((projectId: string) => {
    window.location.hash = `#/project/${encodeURIComponent(projectId)}`;
  }, []);

  const exportProjectBackup = useCallback(async (record: ProjectRecord) => {
    try {
      setDashboardError(null);
      downloadBlob(await createProjectPackage(record), `${record.name || 'chitra-project'}.chitra`);
    } catch (error) {
      setDashboardError(error instanceof Error ? error.message : 'Project export failed.');
    }
  }, []);

  const createProject = useCallback(
    async (name: string, settings: ProjectSettings) => {
      const record = createBlankProjectRecord(name, settings);
      await putProjectRecord(record);
      await refreshRecords();
      openProject(record.id);
    },
    [openProject, refreshRecords],
  );

  const renameProject = useCallback(
    async (record: ProjectRecord) => {
      const nextName = window.prompt('Project name', record.name);

      if (!nextName?.trim()) {
        return;
      }

      const nextRecord = {
        ...record,
        name: nextName.trim(),
        updatedAt: Date.now(),
      };
      await putProjectRecord(nextRecord);
      await refreshRecords();

      if (activeRecord?.id === record.id) {
        setActiveRecord(nextRecord);
      }
    },
    [activeRecord?.id, refreshRecords],
  );

  const duplicateProject = useCallback(
    async (record: ProjectRecord) => {
      try {
        setDashboardError(null);
        await duplicateStoredProject(record);
        await refreshRecords();
      } catch (error) {
        setDashboardError(error instanceof Error ? error.message : 'Project duplicate failed.');
      }
    },
    [refreshRecords],
  );

  const deleteProject = useCallback(
    async (record: ProjectRecord) => {
      if (!window.confirm(`Delete "${record.name}"? This removes the local project and embedded media.`)) {
        return;
      }

      await deleteStoredProject(record);
      await refreshRecords();

      if (activeRecord?.id === record.id) {
        setActiveRecord(null);
        setHydratedProject(null);
        window.location.hash = '#/';
      }
    },
    [activeRecord?.id, refreshRecords],
  );

  const importProjectBackup = useCallback(
    async (file: File) => {
      try {
        setDashboardError(null);
        const record = await importProjectPackage(file);
        await refreshRecords();
        openProject(record.id);
      } catch (error) {
        setDashboardError(error instanceof Error ? error.message : 'Project import failed.');
      }
    },
    [openProject, refreshRecords],
  );

  const onBackToDashboard = useCallback(() => {
    window.location.hash = '#/';
  }, []);

  const onRecordSaved = useCallback((record: ProjectRecord) => {
    setActiveRecord(record);
    setRecords((current) => [record, ...current.filter((candidate) => candidate.id !== record.id)]);
  }, []);

  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute());
    window.addEventListener('hashchange', onHashChange);

    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    void refreshRecords();
  }, [refreshRecords]);

  useEffect(() => {
    if (route.screen !== 'editor') {
      setActiveRecord(null);
      setHydratedProject(null);
      return;
    }

    let cancelled = false;
    setIsLoadingProject(true);
    setDashboardError(null);

    listProjectRecords()
      .then(async (nextRecords) => {
        setRecords(nextRecords);
        const record = nextRecords.find((candidate) => candidate.id === route.projectId) ?? null;

        if (!record) {
          throw new Error('Project not found.');
        }

        const hydrated = await hydrateProjectRecord(record);

        if (!cancelled) {
          setActiveRecord(record);
          setHydratedProject(hydrated);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setDashboardError(error instanceof Error ? error.message : 'Unable to open project.');
          window.location.hash = '#/';
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingProject(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [route]);

  if (route.screen === 'editor') {
    if (isLoadingProject || !activeRecord || !hydratedProject) {
      return (
        <div className="dashboard-shell">
          <div className="dashboard-empty">
            <Film size={30} />
            <strong>Opening project</strong>
            <span>Loading embedded media and timeline data.</span>
          </div>
        </div>
      );
    }

    return (
      <EditorWorkspace
        hydratedProject={hydratedProject}
        key={activeRecord.id}
        onBackToDashboard={onBackToDashboard}
        onProjectExport={exportProjectBackup}
        onRecordSaved={onRecordSaved}
        record={activeRecord}
      />
    );
  }

  return (
    <>
      <input
        accept=".chitra,application/octet-stream"
        className="file-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            void importProjectBackup(file);
          }
          event.target.value = '';
        }}
        ref={packageInputRef}
        type="file"
      />
      <ProjectDashboard
        error={dashboardError}
        onCreateProject={createProject}
        onDeleteProject={deleteProject}
        onDuplicateProject={duplicateProject}
        onExportProject={exportProjectBackup}
        onImportProject={() => packageInputRef.current?.click()}
        onOpenProject={openProject}
        onRenameProject={renameProject}
        records={records}
      />
    </>
  );
}

type ProjectDashboardProps = {
  error: string | null;
  onCreateProject: (name: string, settings: ProjectSettings) => Promise<void>;
  onDeleteProject: (record: ProjectRecord) => Promise<void>;
  onDuplicateProject: (record: ProjectRecord) => Promise<void>;
  onExportProject: (record: ProjectRecord) => Promise<void>;
  onImportProject: () => void;
  onOpenProject: (projectId: string) => void;
  onRenameProject: (record: ProjectRecord) => Promise<void>;
  records: ProjectRecord[];
};

function ProjectDashboard({
  error,
  onCreateProject,
  onDeleteProject,
  onDuplicateProject,
  onExportProject,
  onImportProject,
  onOpenProject,
  onRenameProject,
  records,
}: ProjectDashboardProps) {
  const [customSettings, setCustomSettings] = useState<ProjectSettings>(PROJECT_PRESETS.vertical);
  const [isCreating, setIsCreating] = useState(false);
  const [newProjectName, setNewProjectName] = useState('Untitled Project');
  const [preset, setPreset] = useState<'custom' | keyof typeof PROJECT_PRESETS>('vertical');
  const [query, setQuery] = useState('');
  const selectedSettings = preset === 'custom' ? customSettings : PROJECT_PRESETS[preset];
  const filteredRecords = records.filter((record) => record.name.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <main className="dashboard-shell">
      <header className="dashboard-topbar">
        <div className="brand-lockup">
          <span className="brand-mark">
            <Film size={17} />
          </span>
          <div>
            <h1>Chitra</h1>
            <p>Projects</p>
          </div>
        </div>
        <div className="dashboard-actions">
          <button className="button secondary" onClick={onImportProject} type="button">
            <FileArchive size={15} />
            Import .chitra
          </button>
          <button className="button" onClick={() => setIsCreating(true)} type="button">
            <Plus size={15} />
            New Project
          </button>
        </div>
      </header>

      <section className="dashboard-main">
        <div className="dashboard-hero">
          <div>
            <span>Local project library</span>
            <h2>Open, manage, and back up Chitra projects.</h2>
          </div>
          <form className="command-shell" onSubmit={(event) => event.preventDefault()}>
            <Search size={14} />
            <input onChange={(event) => setQuery(event.target.value)} placeholder="Search projects" value={query} />
            <span>{records.length}</span>
          </form>
        </div>

        {error ? (
          <div className="dashboard-error">
            <span>{error}</span>
          </div>
        ) : null}

        {filteredRecords.length === 0 ? (
          <div className="dashboard-empty">
            <Film size={30} />
            <strong>{records.length === 0 ? 'No projects yet' : 'No matching projects'}</strong>
            <span>Create a project or import a `.chitra` backup to begin.</span>
          </div>
        ) : (
          <div className="project-grid">
            {filteredRecords.map((record) => (
              <article className="project-card" key={record.id}>
                <button className="project-card-main" onClick={() => onOpenProject(record.id)} type="button">
                  <span>{record.settings.width} x {record.settings.height}</span>
                  <strong>{record.name}</strong>
                  <small>
                    {record.document.clips.length} clips | {record.document.assets.length} media | {new Date(record.updatedAt).toLocaleString()}
                  </small>
                </button>
                <div className="project-card-actions">
                  <button className="icon-button small" onClick={() => void onRenameProject(record)} title="Rename" type="button">
                    <Pencil size={14} />
                  </button>
                  <button className="icon-button small" onClick={() => void onDuplicateProject(record)} title="Duplicate" type="button">
                    <Copy size={14} />
                  </button>
                  <button className="icon-button small" onClick={() => void onExportProject(record)} title="Export .chitra" type="button">
                    <FileArchive size={14} />
                  </button>
                  <button className="icon-button small" onClick={() => void onDeleteProject(record)} title="Delete" type="button">
                    <Trash2 size={14} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {isCreating ? (
        <div className="modal-backdrop">
          <form
            className="project-modal"
            onSubmit={(event) => {
              event.preventDefault();
              void onCreateProject(newProjectName, selectedSettings).then(() => setIsCreating(false));
            }}
          >
            <div className="panel-header">
              <div>
                <h2>New Project</h2>
                <span>Choose the timeline format.</span>
              </div>
              <button className="icon-button small" onClick={() => setIsCreating(false)} type="button">
                <X size={15} />
              </button>
            </div>
            <label className="field">
              <span>Name</span>
              <input onChange={(event) => setNewProjectName(event.target.value)} value={newProjectName} />
            </label>
            <label className="field">
              <span>Preset</span>
              <select onChange={(event) => setPreset(event.target.value as typeof preset)} value={preset}>
                <option value="vertical">Vertical 1080 x 1920 30fps</option>
                <option value="landscape">Landscape 1920 x 1080 30fps</option>
                <option value="square">Square 1080 x 1080 30fps</option>
                <option value="custom">Custom</option>
              </select>
            </label>
            {preset === 'custom' ? (
              <div className="button-grid">
                <ControlNumber label="Width" max={7680} min={320} step={2} value={customSettings.width} onChange={(width) => setCustomSettings((settings) => ({ ...settings, width }))} />
                <ControlNumber label="Height" max={7680} min={320} step={2} value={customSettings.height} onChange={(height) => setCustomSettings((settings) => ({ ...settings, height }))} />
                <ControlNumber label="FPS" max={120} min={12} step={1} value={customSettings.fps} onChange={(fps) => setCustomSettings((settings) => ({ ...settings, fps }))} />
              </div>
            ) : null}
            <button className="button full-width" type="submit">
              <Plus size={15} />
              Create Project
            </button>
          </form>
        </div>
      ) : null}
    </main>
  );
}

type ProjectSettingsPanelProps = {
  editArrayText: string;
  onClose: () => void;
  onSettingsChange: (settings: ProjectSettings) => void;
  settings: ProjectSettings;
};

function ProjectSettingsPanel({ editArrayText, onClose, onSettingsChange, settings }: ProjectSettingsPanelProps) {
  const [copyState, setCopyState] = useState<'copied' | 'idle'>('idle');

  return (
    <aside className="settings-popover">
      <div className="panel-header">
        <div>
          <h2>Project Settings</h2>
          <span>Export format for this project.</span>
        </div>
        <button className="icon-button small" onClick={onClose} type="button">
          <X size={15} />
        </button>
      </div>
      <div className="button-grid">
        <button className="button secondary" onClick={() => onSettingsChange(PROJECT_PRESETS.vertical)} type="button">
          Vertical
        </button>
        <button className="button secondary" onClick={() => onSettingsChange(PROJECT_PRESETS.landscape)} type="button">
          Landscape
        </button>
      </div>
      <ControlNumber label="Width" max={7680} min={320} step={2} value={settings.width} onChange={(width) => onSettingsChange({ ...settings, width })} />
      <ControlNumber label="Height" max={7680} min={320} step={2} value={settings.height} onChange={(height) => onSettingsChange({ ...settings, height })} />
      <ControlNumber label="FPS" max={120} min={12} step={1} value={settings.fps} onChange={(fps) => onSettingsChange({ ...settings, fps })} />
      <div className="meta-grid">
        <span>Audio</span>
        <strong>{settings.sampleRate} Hz</strong>
      </div>

      <div className="settings-divider" />
      <div className="settings-section-header">
        <strong>Edit Array Language</strong>
        <span>Live serialization of this project.</span>
      </div>
      <textarea className="edit-array-textarea" readOnly spellCheck={false} value={editArrayText} />
      <button
        className="button secondary full-width"
        onClick={() => {
          void navigator.clipboard.writeText(editArrayText).then(() => {
            setCopyState('copied');
            window.setTimeout(() => setCopyState('idle'), 1400);
          });
        }}
        type="button"
      >
        <Copy size={15} />
        {copyState === 'copied' ? 'Copied' : 'Copy Edit Array'}
      </button>
    </aside>
  );
}

type InspectorProps = {
  addAssetToTimeline: () => void;
  capabilities: ReturnType<typeof detectMediaCapabilities>;
  deleteAssetFromLibrary: (assetId: string) => void;
  deleteSelected: () => void;
  dispatch: Dispatch<Parameters<typeof projectReducer>[1]>;
  hasTimeline: boolean;
  project: ProjectPresent;
  selectedAsset: ProjectAsset | null;
  selectedClip: TimelineClip | null;
  selectedClipAsset: ProjectAsset | null;
  selectedText: TextOverlay | null;
  splitAtPlayhead: () => void;
};

function Inspector({
  addAssetToTimeline,
  capabilities,
  deleteAssetFromLibrary,
  deleteSelected,
  dispatch,
  hasTimeline,
  project,
  selectedAsset,
  selectedClip,
  selectedClipAsset,
  selectedText,
  splitAtPlayhead,
}: InspectorProps) {
  if (selectedText) {
    const textDuration = Math.max(0.1, selectedText.end - selectedText.start);
    const projectDuration = getProjectDuration(project);
    const nudgeText = (deltaSeconds: number) => {
      const nextStart = Math.max(0, selectedText.start + deltaSeconds);
      dispatch({
        patch: { end: nextStart + textDuration, start: nextStart },
        textId: selectedText.id,
        type: 'UPDATE_TEXT',
      });
    };

    return (
      <>
        <div className="panel-header">
          <div>
            <h2>Text</h2>
            <span>{selectedText.text || 'Untitled overlay'}</span>
          </div>
          <Type size={16} />
        </div>
        <div className="control-stack">
          <div className="meta-grid">
            <span>Duration</span>
            <strong>{formatClock(textDuration)}</strong>
            <span>Range</span>
            <strong>{formatClock(selectedText.start)} - {formatClock(selectedText.end)}</strong>
            <span>Timeline</span>
            <strong>{formatClock(selectedText.start)}</strong>
          </div>

          <label className="field">
            <span>Content</span>
            <input
              onChange={(event) => dispatch({ patch: { text: event.target.value }, textId: selectedText.id, type: 'UPDATE_TEXT' })}
              value={selectedText.text}
            />
          </label>
          <label className="field">
            <span>Track</span>
            <select
              onChange={(event) =>
                dispatch({ patch: { trackId: event.target.value }, textId: selectedText.id, type: 'UPDATE_TEXT' })
              }
              value={selectedText.trackId}
            >
              {[...project.tracks]
                .filter((track) => track.kind === 'text')
                .sort((a, b) => b.index - a.index)
                .map((track) => (
                  <option key={track.id} value={track.id}>
                    {track.name}
                  </option>
                ))}
            </select>
          </label>
          <ControlNumber
            label="Timeline Start"
            max={projectDuration}
            min={0}
            step={0.05}
            value={selectedText.start}
            onChange={(value) =>
              dispatch({
                patch: { end: value + textDuration, start: value },
                textId: selectedText.id,
                type: 'UPDATE_TEXT',
              })
            }
          />
          <ControlNumber
            label="Duration"
            max={Math.max(projectDuration - selectedText.start, 0.1)}
            min={0.1}
            step={0.05}
            value={textDuration}
            onChange={(value) =>
              dispatch({
                patch: { end: selectedText.start + value },
                textId: selectedText.id,
                type: 'UPDATE_TEXT',
              })
            }
          />

          <div className="subhead">Canvas Position</div>
          <ControlNumber label="X" max={0.98} min={0.02} step={0.01} value={selectedText.x} onChange={(value) => dispatch({ patch: { x: value }, textId: selectedText.id, type: 'UPDATE_TEXT' })} />
          <ControlNumber label="Y" max={0.98} min={0.02} step={0.01} value={selectedText.y} onChange={(value) => dispatch({ patch: { y: value }, textId: selectedText.id, type: 'UPDATE_TEXT' })} />
          <ControlNumber label="Size" max={96} min={12} step={1} value={selectedText.size} onChange={(value) => dispatch({ patch: { size: value }, textId: selectedText.id, type: 'UPDATE_TEXT' })} />
          <label className="field">
            <span>Align</span>
            <select
              onChange={(event) =>
                dispatch({
                  patch: { align: event.target.value as TextOverlay['align'] },
                  textId: selectedText.id,
                  type: 'UPDATE_TEXT',
                })
              }
              value={selectedText.align}
            >
              <option value="left">Left</option>
              <option value="center">Center</option>
              <option value="right">Right</option>
            </select>
          </label>

          <div className="button-grid">
            <button
              className="button secondary"
              disabled={selectedText.start <= 0}
              onClick={() => nudgeText(-0.25)}
              type="button"
            >
              <StepBack size={15} />
              Nudge Left
            </button>
            <button className="button secondary" onClick={() => nudgeText(0.25)} type="button">
              <StepForward size={15} />
              Nudge Right
            </button>
          </div>
          <div className="button-grid">
            <button className="button secondary" onClick={splitAtPlayhead} type="button">
              <Scissors size={15} />
              Split
            </button>
            <button className="button secondary" onClick={deleteSelected} type="button">
              <Trash2 size={15} />
              Delete
            </button>
          </div>
        </div>
      </>
    );
  }

  if (selectedClip) {
    const clipDuration = getClipDuration(selectedClip);
    const selectedClipTrack = getTrackById(project, selectedClip.trackId);
    const isAudioClip = selectedClipTrack?.kind === 'audio' || selectedClipAsset?.kind === 'audio';
    const trackOptions = isAudioClip ? getAudioTracksTopFirst(project) : getVideoTracksTopFirst(project);

    return (
      <>
        <div className="panel-header">
          <div>
            <h2>{isAudioClip ? 'Audio Clip' : 'Clip'}</h2>
            <span>{selectedClipAsset?.name ?? 'Missing asset'}</span>
          </div>
          {isAudioClip ? <Music size={16} /> : <Scissors size={16} />}
        </div>
        <div className="control-stack">
          <div className="meta-grid">
            <span>Duration</span>
            <strong>{formatClock(clipDuration)}</strong>
            <span>Source</span>
            <strong>{formatClock(selectedClip.sourceIn)} - {formatClock(selectedClip.sourceOut)}</strong>
            <span>Timeline</span>
            <strong>{formatClock(selectedClip.timelineStart)}</strong>
          </div>

          <ControlNumber
            label="Timeline Start"
            max={getProjectDuration(project) + 60}
            min={0}
            step={0.05}
            value={selectedClip.timelineStart}
            onChange={(value) => dispatch({ clipId: selectedClip.id, timelineStart: value, type: 'MOVE_CLIP' })}
          />
          <label className="field">
            <span>Track</span>
            <select
              onChange={(event) => dispatch({ clipId: selectedClip.id, trackId: event.target.value, type: 'MOVE_CLIP' })}
              value={selectedClip.trackId}
            >
              {trackOptions.map((track) => (
                <option key={track.id} value={track.id}>
                  {track.name}
                </option>
              ))}
            </select>
          </label>

          <ControlNumber
            label="Source In"
            max={selectedClip.sourceOut - 0.1}
            min={0}
            step={0.05}
            value={selectedClip.sourceIn}
            onChange={(value) => dispatch({ clipId: selectedClip.id, edge: 'start', sourceTime: value, type: 'TRIM_CLIP' })}
          />
          <ControlNumber
            label="Source Out"
            max={selectedClipAsset?.duration || selectedClip.sourceOut}
            min={selectedClip.sourceIn + 0.1}
            step={0.05}
            value={selectedClip.sourceOut}
            onChange={(value) => dispatch({ clipId: selectedClip.id, edge: 'end', sourceTime: value, type: 'TRIM_CLIP' })}
          />

          {isAudioClip ? null : (
            <>
              <div className="subhead">Canvas Transform</div>
              <ControlNumber label="X" max={1} min={0} step={0.01} value={selectedClip.transform.x} onChange={(value) => dispatch({ clipId: selectedClip.id, transform: { x: value }, type: 'UPDATE_CLIP_TRANSFORM' })} />
              <ControlNumber label="Y" max={1} min={0} step={0.01} value={selectedClip.transform.y} onChange={(value) => dispatch({ clipId: selectedClip.id, transform: { y: value }, type: 'UPDATE_CLIP_TRANSFORM' })} />
              <ControlNumber label="Scale" max={4} min={0.25} step={0.01} value={selectedClip.transform.scale} onChange={(value) => dispatch({ clipId: selectedClip.id, transform: { scale: value }, type: 'UPDATE_CLIP_TRANSFORM' })} />
            </>
          )}

          <label className="toggle-row">
            <input
              checked={selectedClip.muted}
              onChange={(event) => dispatch({ clipId: selectedClip.id, patch: { muted: event.target.checked }, type: 'UPDATE_CLIP_AUDIO' })}
              type="checkbox"
            />
            <span>Mute clip audio</span>
          </label>
          <ControlNumber label="Volume" max={2} min={0} step={0.01} value={selectedClip.volume} onChange={(value) => dispatch({ clipId: selectedClip.id, patch: { volume: value }, type: 'UPDATE_CLIP_AUDIO' })} />
          <ControlNumber label="Fade In" max={clipDuration} min={0} step={0.05} value={selectedClip.fadeIn} onChange={(value) => dispatch({ clipId: selectedClip.id, patch: { fadeIn: value }, type: 'UPDATE_CLIP_AUDIO' })} />
          <ControlNumber label="Fade Out" max={clipDuration} min={0} step={0.05} value={selectedClip.fadeOut} onChange={(value) => dispatch({ clipId: selectedClip.id, patch: { fadeOut: value }, type: 'UPDATE_CLIP_AUDIO' })} />

          {isAudioClip ? null : (
            <>
              <div className="subhead">Effects</div>
              <ControlNumber label="Brightness" max={0.4} min={-0.4} step={0.01} value={selectedClip.effects.brightness} onChange={(value) => dispatch({ clipId: selectedClip.id, effects: { brightness: value }, type: 'UPDATE_CLIP_EFFECTS' })} />
              <ControlNumber label="Contrast" max={1.8} min={0.5} step={0.01} value={selectedClip.effects.contrast} onChange={(value) => dispatch({ clipId: selectedClip.id, effects: { contrast: value }, type: 'UPDATE_CLIP_EFFECTS' })} />
              <ControlNumber label="Saturation" max={2} min={0} step={0.01} value={selectedClip.effects.saturation} onChange={(value) => dispatch({ clipId: selectedClip.id, effects: { saturation: value }, type: 'UPDATE_CLIP_EFFECTS' })} />
            </>
          )}

          <div className="button-grid">
            <button
              className="button secondary"
              disabled={selectedClip.timelineStart <= 0}
              onClick={() => dispatch({ clipId: selectedClip.id, timelineStart: Math.max(0, selectedClip.timelineStart - 0.25), type: 'MOVE_CLIP' })}
              type="button"
            >
              <StepBack size={15} />
              Nudge Left
            </button>
            <button
              className="button secondary"
              onClick={() => dispatch({ clipId: selectedClip.id, timelineStart: selectedClip.timelineStart + 0.25, type: 'MOVE_CLIP' })}
              type="button"
            >
              <StepForward size={15} />
              Nudge Right
            </button>
          </div>
          <div className="button-grid">
            <button className="button secondary" onClick={splitAtPlayhead} type="button">
              <Scissors size={15} />
              Split
            </button>
            <button className="button secondary" onClick={deleteSelected} type="button">
              <Trash2 size={15} />
              Delete
            </button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="panel-header">
        <div>
          <h2>Inspector</h2>
          <span>{selectedAsset ? selectedAsset.name : 'Select an asset, clip, or text'}</span>
        </div>
        <Wand2 size={16} />
      </div>

      <div className="control-stack">
        {selectedAsset ? (
          <>
            <div className="meta-grid">
              <span>Duration</span>
              <strong>{formatClock(selectedAsset.duration)}</strong>
              <span>Resolution</span>
              <strong>{selectedAsset.width && selectedAsset.height ? `${selectedAsset.width} x ${selectedAsset.height}` : 'Reading'}</strong>
              <span>Size</span>
              <strong>{formatBytes(selectedAsset.size)}</strong>
              <span>Proxy</span>
              <strong>{selectedAsset.proxyStatus.state}</strong>
            </div>
            <button className="button full-width" disabled={selectedAsset.duration <= 0} onClick={addAssetToTimeline} type="button">
              <StepForward size={15} />
              Add To Timeline
            </button>
            <button className="button secondary full-width" onClick={() => deleteAssetFromLibrary(selectedAsset.id)} type="button">
              <Trash2 size={15} />
              Delete From Library
            </button>
          </>
        ) : (
          <div className="empty-inspector">No selection.</div>
        )}

        <div className="subhead">Engine</div>
        <div className="meta-grid">
          <span>WebGPU</span>
          <strong>{capabilities.webGpu ? 'Yes' : 'No'}</strong>
          <span>WebCodecs</span>
          <strong>{capabilities.webCodecs ? 'Yes' : 'No'}</strong>
          <span>WASM</span>
          <strong>{capabilities.wasm ? 'Yes' : 'No'}</strong>
          <span>Frame callback</span>
          <strong>{capabilities.requestVideoFrameCallback ? 'Yes' : 'No'}</strong>
        </div>
        <div className="subhead">Project</div>
        <div className="meta-grid">
          <span>Assets</span>
          <strong>{project.assets.length}</strong>
          <span>Clips</span>
          <strong>{project.clips.length}</strong>
          <span>Text</span>
          <strong>{project.textOverlays.length}</strong>
          <span>Timeline</span>
          <strong>{hasTimeline ? formatClock(getProjectDuration(project)) : 'Empty'}</strong>
        </div>
      </div>
    </>
  );
}

type ControlNumberProps = {
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  step: number;
  value: number;
};

function ControlNumber({ label, max, min, onChange, step, value }: ControlNumberProps) {
  return (
    <label className="field">
      <span>{label}</span>
      <div className="number-control">
        <input max={max} min={min} onChange={(event) => onChange(Number(event.target.value))} step={step} type="range" value={value} />
        <input max={max} min={min} onChange={(event) => onChange(Number(event.target.value))} step={step} type="number" value={Number.isFinite(value) ? value : 0} />
      </div>
    </label>
  );
}

function PerformanceHud() {
  const snapshot = usePerformanceSnapshot();

  return (
    <aside className="perf-hud">
      <div>
        <span>FPS</span>
        <strong>{snapshot.fps}</strong>
      </div>
      <div>
        <span>Drops</span>
        <strong>{snapshot.droppedFrames}</strong>
      </div>
      <div>
        <span>Long</span>
        <strong>{snapshot.longTasks}</strong>
      </div>
      <div>
        <span>Seek</span>
        <strong>{Math.round(snapshot.seekMs)}ms</strong>
      </div>
      <div>
        <span>Timeline</span>
        <strong>
          {snapshot.renderedTimelineItems}/{snapshot.totalTimelineItems}
        </strong>
      </div>
      <div>
        <span>Proxy</span>
        <strong>{snapshot.proxyProgress}%</strong>
      </div>
      <div>
        <span>Export</span>
        <strong>{snapshot.exportProgress}%</strong>
      </div>
      <div>
        <span>GPU</span>
        <strong>{snapshot.gpuPreviewActive ? 'On' : 'Off'}</strong>
      </div>
      <div>
        <span>Memory</span>
        <strong>{snapshot.memoryMb === null ? '-' : `${snapshot.memoryMb}MB`}</strong>
      </div>
    </aside>
  );
}

export default App;
