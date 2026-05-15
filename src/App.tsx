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
  Mic,
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
import { ChatPanel, type ChatToolCall, type ChatToolResult } from './ChatPanel';
import { DEFAULT_EFFECT_SETTINGS, hasActiveEffects } from './effects';
import { createEditArrayFromRuntime, stringifyEditArray } from './editArrayLanguage';
import { compileEditArrayProgram } from './editCompiler';
import { executeEditPlan } from './editRuntime';
import { transcribeFile } from './transcribe';
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
  DEFAULT_TEXT_OVERLAY,
  TEXT_FONT_FAMILIES,
  buildTimelineIndex,
  getActiveTextOverlaysFromIndex,
  getAudioClipsAtTimeFromIndex,
  getClipsAtTimeFromIndex,
  getVideoClipsAtTimeFromIndex,
  idleJobStatus,
  projectReducer,
  snapToTarget,
  type ClipTransform,
  type JobStatus,
  type ProjectAsset,
  type ProjectPresent,
  type TextFontFamilyId,
  type TextOverlay,
  type TimelineClip,
  type TimelineTrack,
} from './projectModel';
import {
  SUBTITLE_TEMPLATES,
  findSubtitleTemplate,
  generateSubtitleCues,
  type SubtitleMode,
  type SubtitleTemplateId,
} from './subtitles';
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
import {
  createProxyCacheKey,
  deleteCachedProxy,
  getAssetBeatsTolerant,
  getAssetTranscript,
  getCachedProxy,
  listProjectRecords,
  putAssetBeats,
  putAssetTranscript,
  putCachedProxy,
  putJobMetadata,
  putProjectRecord,
  type StoredAssetTranscript,
  type StoredBeatData,
} from './projectStore';
import { detectBeats } from './beatDetection';
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
  | { centerX: number; centerY: number; clipId: string; startAngle: number; startRotation: number; type: 'preview-clip-rotate' }
  | { startEnd: number; startStart: number; startTrackId: string; startX: number; startY: number; textId: string; type: 'timeline-text-move' }
  | { startSize: number; startX: number; textId: string; type: 'preview-text-scale' }
  | { centerX: number; centerY: number; startAngle: number; startRotation: number; textId: string; type: 'preview-text-rotate' }
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
const TIMELINE_AUDIO_TRACK_HEIGHT = 64;
const TIMELINE_TRACK_GAP = 8;
const TIMELINE_TEXT_TRACK_HEIGHT = 64;
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
  const wasPlayingRef = useRef(false);
  const lastClipIdRef = useRef<string>(clip.id);
  const lastSeekAtRef = useRef(0);

  useEffect(() => {
    const video = layerVideoRef.current;

    if (!video) {
      return;
    }

    video.playbackRate = playbackRate;
    video.muted = true;
    video.volume = 0;

    const clipChanged = lastClipIdRef.current !== clip.id;
    lastClipIdRef.current = clip.id;
    const playStarting = isPlaying && !wasPlayingRef.current;
    wasPlayingRef.current = isPlaying;

    const targetTime = clip.sourceIn + localTime;
    const drift = Math.abs(video.currentTime - targetTime);
    const now = performance.now();

    // Match PreviewLayerAudio: avoid constant re-seeking that thrashes the
    // decoder. The visual offset of a secondary layer is imperceptible at
    // sub-300 ms drift, and rate-limiting prevents stutter on heavier clips.
    const shouldSync =
      playStarting ||
      clipChanged ||
      (drift > 0.3 && now - lastSeekAtRef.current > 800);

    if (shouldSync) {
      seekVideoSafely(video, targetTime);
      lastSeekAtRef.current = now;
    }

    if (isPlaying) {
      void video.play().catch(() => {
        // Secondary preview layers are best-effort; the primary layer owns transport.
      });
    } else {
      video.pause();
    }
  }, [clip.id, clip.sourceIn, isPlaying, localTime, playbackRate]);

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
  const wasPlayingRef = useRef(false);
  const lastClipIdRef = useRef<string>(clip.id);
  const lastSeekAtRef = useRef(0);

  useEffect(() => {
    const audio = layerAudioRef.current;

    if (!audio) {
      return;
    }

    audio.playbackRate = playbackRate;
    audio.muted = clip.muted;
    audio.volume = clip.muted ? 0 : Math.min(1, clip.volume);

    const clipChanged = lastClipIdRef.current !== clip.id;
    lastClipIdRef.current = clip.id;
    const playStarting = isPlaying && !wasPlayingRef.current;
    wasPlayingRef.current = isPlaying;

    const targetTime = clip.sourceIn + localTime;
    const drift = Math.abs(audio.currentTime - targetTime);
    const now = performance.now();

    // The audio element plays at its own steady rate once started. The React
    // playhead, driven by the main video's `timeupdate` events, advances in
    // 100–250 ms hops, so a tight tolerance forces constant seek-glitch cycles
    // even when the audio is actually in sync. Only re-seek on transitions
    // (play start, clip change) or when drift is large enough to be audible,
    // and rate-limit drift corrections to avoid stutter.
    const shouldSync =
      playStarting ||
      clipChanged ||
      (drift > 0.3 && now - lastSeekAtRef.current > 800);

    if (shouldSync) {
      try {
        audio.currentTime = targetTime;
        lastSeekAtRef.current = now;
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
  }, [clip.id, clip.muted, clip.sourceIn, clip.volume, isPlaying, localTime, playbackRate]);

  return <audio preload="auto" ref={layerAudioRef} src={asset.playbackUrl} />;
}

const TEXT_FONT_STACK_BY_ID = new Map(TEXT_FONT_FAMILIES.map((font) => [font.id, font.stack]));

// Per-row virtualization: slice the pre-sorted clip list to only those whose
// [timelineStart, timelineEnd] overlap the viewport time window. Binary search
// for the first clip whose end >= viewport.start, then linearly walk forward
// until start > viewport.end. With sorted input this is O(log n + visible).
function filterClipsInViewport(sortedClips: TimelineClip[], viewport: { end: number; start: number }): TimelineClip[] {
  if (sortedClips.length === 0) return sortedClips;
  if (!Number.isFinite(viewport.end)) return sortedClips;

  let lo = 0;
  let hi = sortedClips.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const clip = sortedClips[mid];
    const end = clip.timelineStart + Math.max(0, clip.sourceOut - clip.sourceIn);
    if (end < viewport.start) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  const visible: TimelineClip[] = [];
  for (let i = lo; i < sortedClips.length; i += 1) {
    const clip = sortedClips[i];
    if (clip.timelineStart > viewport.end) break;
    visible.push(clip);
  }
  return visible;
}

function filterTextOverlaysInViewport(sortedOverlays: TextOverlay[], viewport: { end: number; start: number }): TextOverlay[] {
  if (sortedOverlays.length === 0) return sortedOverlays;
  if (!Number.isFinite(viewport.end)) return sortedOverlays;

  let lo = 0;
  let hi = sortedOverlays.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedOverlays[mid].end < viewport.start) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  const visible: TextOverlay[] = [];
  for (let i = lo; i < sortedOverlays.length; i += 1) {
    const overlay = sortedOverlays[i];
    if (overlay.start > viewport.end) break;
    visible.push(overlay);
  }
  return visible;
}

type TimelineDownbeat = {
  assetId: string;
  clipKind: 'audio' | 'video' | 'text' | 'unknown';
  time: number;
};

type TimelineBeatGridProps = {
  beatPositions: number[];
  downbeatPositions: TimelineDownbeat[];
  pixelsPerSecond: number;
  labelWidth: number;
  visible: boolean;
  viewport: { end: number; start: number };
};

// Curated palette of accent hues that read well on the slate background.
// Hash the asset id into this list so each asset gets a stable but distinct
// colour without falling back to ugly auto-generated HSL ramps.
const BEAT_MARKER_PALETTE = [
  '#f5cb47', // warm amber
  '#5d9eff', // accent blue
  '#7be88f', // mint
  '#ff8aa0', // coral
  '#c89aff', // lavender
  '#5fe0d4', // teal
  '#ffb066', // peach
  '#86d6ff', // sky
] as const;

function hashStringToIndex(input: string, modulo: number): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % modulo;
}

function colorForAsset(assetId: string): string {
  return BEAT_MARKER_PALETTE[hashStringToIndex(assetId, BEAT_MARKER_PALETTE.length)];
}

// Renders downbeat markers as a thin band along the top of the timeline ruler.
// Each asset gets its own colour (stable across reloads, hashed from asset id)
// and a tiny media-kind glyph so multi-source beat grids stay legible.
function TimelineBeatGrid({ downbeatPositions, pixelsPerSecond, labelWidth, visible, viewport }: TimelineBeatGridProps) {
  if (!visible || downbeatPositions.length === 0) return null;

  const minTime = Number.isFinite(viewport.start) ? viewport.start : 0;
  const maxTime = Number.isFinite(viewport.end) ? viewport.end : Number.POSITIVE_INFINITY;

  // Bar numbering counts downbeats per-asset so each colour group restarts at 1.
  const orderByAsset = new Map<string, Map<number, number>>();
  for (const downbeat of downbeatPositions) {
    let perAsset = orderByAsset.get(downbeat.assetId);
    if (!perAsset) {
      perAsset = new Map();
      orderByAsset.set(downbeat.assetId, perAsset);
    }
    if (!perAsset.has(downbeat.time)) {
      perAsset.set(downbeat.time, perAsset.size + 1);
    }
  }

  const inView = downbeatPositions.filter(
    (downbeat) => downbeat.time >= minTime - 0.5 && downbeat.time <= maxTime + 0.5,
  );

  return (
    <div aria-hidden="true" className="timeline-beat-grid">
      {inView.map((downbeat) => {
        const left = labelWidth + downbeat.time * pixelsPerSecond;
        const colour = colorForAsset(downbeat.assetId);
        const bar = orderByAsset.get(downbeat.assetId)?.get(downbeat.time) ?? 1;
        const icon =
          downbeat.clipKind === 'audio' ? <Music size={9} strokeWidth={2.25} />
          : downbeat.clipKind === 'video' ? <Film size={9} strokeWidth={2.25} />
          : downbeat.clipKind === 'text' ? <Type size={9} strokeWidth={2.25} />
          : null;
        return (
          <span
            className="beat-tick is-downbeat"
            key={`${downbeat.assetId}-${downbeat.time}`}
            style={{ '--beat-color': colour, left: `${left}px` } as CSSProperties}
          >
            <em>
              {icon}
              <span>{bar}</span>
            </em>
          </span>
        );
      })}
    </div>
  );
}

function getFontStack(id: TextFontFamilyId): string {
  return TEXT_FONT_STACK_BY_ID.get(id) ?? TEXT_FONT_FAMILIES[0].stack;
}

function applyTextCase(text: string, textCase: TextOverlay['textCase']): string {
  if (textCase === 'upper') return text.toUpperCase();
  if (textCase === 'lower') return text.toLowerCase();
  return text;
}

function buildPreviewTextStyle(overlay: TextOverlay): CSSProperties {
  const transforms: string[] = [];
  if (overlay.align === 'center') {
    transforms.push('translate(-50%, -50%)');
  } else if (overlay.align === 'right') {
    transforms.push('translate(-100%, -50%)');
  } else {
    transforms.push('translateY(-50%)');
  }
  if (overlay.rotation) transforms.push(`rotate(${overlay.rotation}deg)`);
  if (overlay.skewX || overlay.skewY) transforms.push(`skew(${overlay.skewX}deg, ${overlay.skewY}deg)`);

  const shadowParts: string[] = [];
  if (overlay.shadowBlur > 0 || overlay.shadowOffsetX !== 0 || overlay.shadowOffsetY !== 0) {
    shadowParts.push(`${overlay.shadowOffsetX}px ${overlay.shadowOffsetY}px ${overlay.shadowBlur}px ${overlay.shadowColor}`);
  }

  const style: CSSProperties = {
    color: overlay.color,
    fontFamily: getFontStack(overlay.fontFamily),
    fontSize: `${overlay.size}px`,
    fontStyle: overlay.italic ? 'italic' : 'normal',
    fontWeight: overlay.bold ? 800 : 500,
    left: `${overlay.x * 100}%`,
    letterSpacing: `${overlay.letterSpacing}px`,
    lineHeight: overlay.lineHeight,
    opacity: overlay.opacity,
    textAlign: overlay.align,
    textDecoration: overlay.underline ? 'underline' : 'none',
    textShadow: shadowParts.join(', ') || 'none',
    top: `${overlay.y * 100}%`,
    transform: transforms.join(' '),
  };

  if (overlay.backgroundColor && overlay.backgroundColor !== 'transparent' && !overlay.backgroundColor.endsWith('00')) {
    style.background = overlay.backgroundColor;
    style.padding = '6px 12px';
    style.borderRadius = '4px';
  }

  if (overlay.strokeWidth > 0) {
    (style as CSSProperties & { WebkitTextStrokeColor?: string; WebkitTextStrokeWidth?: string }).WebkitTextStrokeColor = overlay.strokeColor;
    (style as CSSProperties & { WebkitTextStrokeColor?: string; WebkitTextStrokeWidth?: string }).WebkitTextStrokeWidth = `${overlay.strokeWidth}px`;
  }

  return style;
}

type AssetCardProps = {
  asset: ProjectAsset;
  onAddToTimeline: () => void;
  onDelete: () => void;
  onDragStart: (event: ReactDragEvent<HTMLDivElement>) => void;
  onSelect: () => void;
  selected: boolean;
};

/**
 * Asset library tile. Two thumbnail strategies:
 *  1. If the asset has a cached `posterUrl` (data: or blob:), use it as a
 *     plain <img>. Cheap and always cache-warm after import.
 *  2. If that image fails OR is missing entirely, hot-grab a frame from the
 *     asset's playback URL via a hidden <video> element so the user still
 *     sees their footage. Falls back to a kind-tinted gradient only if both
 *     paths fail (e.g. audio-only asset where there's no frame to grab).
 */
function AssetCard({ asset, onAddToTimeline, onDelete, onDragStart, onSelect, selected }: AssetCardProps) {
  const [posterError, setPosterError] = useState(false);
  const [liveThumb, setLiveThumb] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    setPosterError(false);
    setLiveThumb(null);
  }, [asset.posterUrl, asset.playbackUrl]);

  // When the poster fails or is missing for a VIDEO asset, attach a hidden
  // <video> that decodes a single frame ~0.5 s in. We capture it to a 2D
  // canvas and convert to a data URL — same trick the import path uses for
  // the initial poster, run lazily here as a backstop.
  useEffect(() => {
    if (liveThumb || asset.kind !== 'video') return;
    if (asset.posterUrl && !posterError) return;
    if (!asset.playbackUrl) return;
    let cancelled = false;
    const video = document.createElement('video');
    videoRef.current = video;
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.preload = 'metadata';
    video.playsInline = true;
    video.src = asset.playbackUrl;
    const onSeeked = () => {
      if (cancelled) return;
      try {
        const canvas = document.createElement('canvas');
        const w = video.videoWidth || 320;
        const h = video.videoHeight || 180;
        canvas.width = Math.min(320, w);
        canvas.height = Math.round(canvas.width * (h / Math.max(1, w)));
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const url = canvas.toDataURL('image/jpeg', 0.7);
        if (!cancelled) setLiveThumb(url);
      } catch {
        // CORS or decoder error — leave the gradient fallback in place.
      }
    };
    const onMetadata = () => {
      try {
        video.currentTime = Math.min(0.5, Math.max(0, (video.duration || 1) * 0.1));
      } catch {
        // Some browsers reject seeks before the first frame; the loadeddata
        // handler below covers that case.
      }
    };
    video.addEventListener('loadedmetadata', onMetadata, { once: true });
    video.addEventListener('loadeddata', onMetadata, { once: true });
    video.addEventListener('seeked', onSeeked, { once: true });
    return () => {
      cancelled = true;
      video.removeEventListener('loadedmetadata', onMetadata);
      video.removeEventListener('loadeddata', onMetadata);
      video.removeEventListener('seeked', onSeeked);
      try {
        video.pause();
        video.removeAttribute('src');
        video.load();
      } catch {
        // ignore — element is being garbage-collected
      }
    };
  }, [asset.kind, asset.playbackUrl, asset.posterUrl, liveThumb, posterError]);

  const usePoster = !!asset.posterUrl && !posterError;
  const useLive = !usePoster && !!liveThumb;

  return (
    <div
      className={`asset-card${selected ? ' is-selected' : ''}`}
      draggable={asset.duration > 0}
      onDragStart={onDragStart}
      title={asset.name}
    >
      <button className="asset-card-thumb" onClick={onSelect} type="button">
        {usePoster ? (
          <img
            alt={asset.name}
            draggable={false}
            onError={() => setPosterError(true)}
            src={asset.posterUrl ?? ''}
          />
        ) : useLive ? (
          <img alt={asset.name} draggable={false} src={liveThumb ?? ''} />
        ) : (
          <div className={`asset-card-fallback asset-card-fallback-${asset.kind}`}>
            {asset.kind === 'audio' ? <Music size={26} /> : <Film size={26} />}
          </div>
        )}
        <span className="asset-card-kind" aria-hidden="true">
          {asset.kind === 'audio' ? <Music size={11} /> : <Film size={11} />}
        </span>
        <span className="asset-card-duration">{asset.duration > 0 ? formatClock(asset.duration) : '…'}</span>
        <span className="asset-card-overlay" aria-hidden="true">
          <strong>{asset.name}</strong>
          <em>{formatBytes(asset.size)}</em>
        </span>
      </button>
      <div className="asset-card-actions">
        <button
          aria-label={`Add ${asset.name} to timeline`}
          className="icon-button small"
          disabled={asset.duration <= 0}
          onClick={onAddToTimeline}
          title="Add to timeline"
          type="button"
        >
          <StepForward size={13} />
        </button>
        <button
          aria-label={`Delete ${asset.name} from media library`}
          className="icon-button small"
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
          onPointerDown={(event) => event.stopPropagation()}
          title="Delete from media library"
          type="button"
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
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
    // Audio primary owns the master clock when an audio clip is active.
    // Only adopt the video element when audio primary isn't mounted.
    if (element && !audioPrimaryRef.current) {
      activeMediaRef.current = element;
    } else if (!element && activeMediaRef.current === videoRef.current) {
      activeMediaRef.current = audioPrimaryRef.current;
    }
  }, []);

  const attachAudioPrimaryRef = useCallback((element: HTMLAudioElement | null) => {
    audioPrimaryRef.current = element;
    if (element) {
      activeMediaRef.current = element;
    } else if (videoRef.current) {
      activeMediaRef.current = videoRef.current;
    }
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
  // Perf HUD is now opt-in only via the `?perf` URL flag — no toolbar button.
  const showPerfHud = useMemo(() => new URLSearchParams(window.location.search).has('perf'), []);
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [rightPanelTab, setRightPanelTab] = useState<'chat' | 'inspector'>('inspector');
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [beatMarkersVisible, setBeatMarkersVisible] = useState(true);
  const [bulkTextEdit, setBulkTextEdit] = useState(false);
  // Cached transcripts keyed by asset fingerprint. Lives in App so both the
  // Inspector (display + transcribe button) and the chat context builder can
  // read it without prop-drilling. Mirror also lives in IndexedDB so reloads
  // don't lose work.
  const [assetTranscripts, setAssetTranscripts] = useState<Record<string, StoredAssetTranscript>>({});
  const [transcribingFingerprints, setTranscribingFingerprints] = useState<Set<string>>(() => new Set());
  const [transcribeError, setTranscribeError] = useState<string | null>(null);
  // Beat-detection cache — same shape as transcripts but stored separately so
  // we can run/refresh them independently. Survives reload via IndexedDB.
  const [assetBeats, setAssetBeats] = useState<Record<string, StoredBeatData>>({});
  const [detectingBeatsFingerprints, setDetectingBeatsFingerprints] = useState<Set<string>>(() => new Set());
  const [beatError, setBeatError] = useState<string | null>(null);
  const snapIndicatorRef = useRef<HTMLDivElement>(null);

  const present = project.present;
  const duration = useMemo(() => getProjectDuration(present), [present]);
  // Memoized timeline index — built once per state change rather than once per
  // playhead frame. Indexed selectors below are O(log clips) instead of O(n).
  const timelineIndex = useMemo(() => buildTimelineIndex(present), [present.clips, present.textOverlays, present.tracks]);
  const activeLayerTimelines = useMemo(
    () => getVideoClipsAtTimeFromIndex(timelineIndex, present.tracks, playhead),
    [present.tracks, timelineIndex, playhead],
  );
  const activeAudioLayerTimelines = useMemo(
    () => getAudioClipsAtTimeFromIndex(timelineIndex, present.tracks, playhead),
    [present.tracks, timelineIndex, playhead],
  );
  const activeTextOverlays = useMemo(
    () => getActiveTextOverlaysFromIndex(timelineIndex, present.textOverlays, playhead),
    [present.textOverlays, timelineIndex, playhead],
  );
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

  // Ref-mirror of state that ChatPanel snapshots at submit time. Refs (vs.
  // props) keep the panel from re-rendering on every playhead tick.
  const chatContextRef = useRef({
    activeClipId: activeClip?.id ?? null,
    assetBeats,
    assetTranscripts,
    playhead,
    present,
    projectName,
    projectSettings,
  });
  chatContextRef.current = {
    activeClipId: activeClip?.id ?? null,
    assetBeats,
    assetTranscripts,
    playhead,
    present,
    projectName,
    projectSettings,
  };
  const getChatContext = useCallback(() => {
    const snapshot = chatContextRef.current;
    if (snapshot.present.clips.length === 0) {
      return null;
    }
    // Build transcript excerpts. No truncation: the full per-clip transcript
    // (every in-range segment with its timestamps) is sent. DeepSeek V4 Flash
    // has a 128k context window so a multi-minute take fits comfortably.
    // The chat path will get slower / more expensive on very long content,
    // but the user explicitly asked for unclipped context.
    const transcripts: Array<{
      assetId: string;
      clipId: string;
      excerpt: string;
      language: string | null;
    }> = [];
    const selectedClipId = snapshot.present.selectedClipId;

    const formatExcerpt = (transcript: StoredAssetTranscript, clip: TimelineClip): string => {
      const segments = transcript.segments
        .filter((seg) => seg.end >= clip.sourceIn - 0.25 && seg.start <= clip.sourceOut + 0.25)
        .map((seg) => `[${seg.start.toFixed(2)}-${seg.end.toFixed(2)}] ${seg.text.trim()}`);
      if (segments.length === 0) return transcript.text;
      return segments.join('\n');
    };

    const addTranscriptFor = (clip: TimelineClip) => {
      const asset = snapshot.present.assets.find((a) => a.id === clip.assetId);
      if (!asset) return;
      const fingerprint = createMediaFingerprint(asset.file, asset.duration);
      const transcript = snapshot.assetTranscripts[fingerprint];
      if (!transcript) return;
      const excerpt = formatExcerpt(transcript, clip);
      if (!excerpt) return;
      transcripts.push({ assetId: asset.id, clipId: clip.id, excerpt, language: transcript.language });
    };

    // Selected clip first so it leads the prompt's transcript section.
    const selectedClip = selectedClipId
      ? snapshot.present.clips.find((c) => c.id === selectedClipId) ?? null
      : null;
    if (selectedClip) addTranscriptFor(selectedClip);

    // Every other clip overlapping the playhead.
    for (const clip of snapshot.present.clips) {
      if (clip.id === selectedClipId) continue;
      const overlapping =
        snapshot.playhead >= clip.timelineStart &&
        snapshot.playhead <= clip.timelineStart + (clip.sourceOut - clip.sourceIn) + 4;
      if (!overlapping) continue;
      addTranscriptFor(clip);
    }
    // Beat-grid context: list every clip that has beats and a small set of
    // timeline-projected beat positions near the playhead. The model uses
    // these to land cuts on beats via apply_eal.
    const beatContext: Array<{
      assetId: string;
      bpm: number | null;
      clipId: string;
      clipKind: 'audio' | 'video' | 'text' | 'unknown';
      timelineBeats: number[];
      timelineDownbeats: number[];
    }> = [];
    // Iterate clips so the selected clip is always emitted first — guarantees
    // its beat grid lands in the context, even when the playhead is elsewhere.
    const clipsForBeats = selectedClip
      ? [selectedClip, ...snapshot.present.clips.filter((c) => c.id !== selectedClipId)]
      : snapshot.present.clips;
    for (const clip of clipsForBeats) {
      const asset = snapshot.present.assets.find((a) => a.id === clip.assetId);
      if (!asset) continue;
      const track = snapshot.present.tracks.find((t) => t.id === clip.trackId);
      const clipKind: 'audio' | 'video' | 'text' | 'unknown' = (track?.kind ?? asset.kind ?? 'unknown') as
        | 'audio'
        | 'video'
        | 'text'
        | 'unknown';
      const fp = createMediaFingerprint(asset.file, asset.duration);
      const data = snapshot.assetBeats[fp];
      if (!data) continue;
      const clipDuration = Math.max(0, clip.sourceOut - clip.sourceIn);
      const project = (sourceTime: number) => clip.timelineStart + (sourceTime - clip.sourceIn);
      const onTimeline = (t: number) => t <= clip.timelineStart + clipDuration + 0.0005;
      const timelineBeats: number[] = [];
      for (const beat of data.beats) {
        if (beat < clip.sourceIn || beat > clip.sourceOut) continue;
        const t = project(beat);
        if (onTimeline(t)) timelineBeats.push(Number(t.toFixed(3)));
      }
      const timelineDownbeats: number[] = [];
      for (const downbeat of data.downbeats ?? []) {
        if (downbeat < clip.sourceIn || downbeat > clip.sourceOut) continue;
        const t = project(downbeat);
        if (onTimeline(t)) timelineDownbeats.push(Number(t.toFixed(3)));
      }
      // Send the full beat grid per clip — no slicing. Lets the model land
      // cuts anywhere across the timeline, not just within the first ~30 s.
      beatContext.push({
        assetId: asset.id,
        bpm: data.bpm,
        clipId: clip.id,
        clipKind,
        timelineBeats,
        timelineDownbeats,
      });
    }

    return {
      activeClipId: snapshot.activeClipId,
      beats: beatContext,
      editArray: createEditArrayFromRuntime(snapshot.present, snapshot.projectSettings, snapshot.projectName),
      playheadSeconds: snapshot.playhead,
      projectName: snapshot.projectName,
      selectedClipId: snapshot.present.selectedClipId,
      selectedTextId: snapshot.present.selectedTextId,
      selectedTrackId: snapshot.present.selectedTrackId,
      transcripts,
    };
  }, []);

  // Single-tool dispatcher: the model emits a complete new EAL program; we
  // compile it through the existing editCompiler → editRuntime pipeline (the
  // same one the EAL inspector uses), then dispatch APPLY_EAL with the
  // resulting ProjectPresent so it lands as one undoable history step.
  //
  // Why one tool instead of many: anything EAL can represent is reachable;
  // new editor features become available to the model for free as soon as
  // they round-trip through EAL; the model gets to plan holistically rather
  // than chaining narrow primitives.
  const applyChatToolCall = useCallback((call: ChatToolCall): ChatToolResult => {
    if (call.name !== 'apply_eal') {
      return { error: `unsupported tool: ${call.name}`, ok: false };
    }

    const args = call.arguments as Record<string, unknown>;
    const program = args.program;
    if (!Array.isArray(program)) {
      return { error: '`program` must be an EAL array', ok: false };
    }

    try {
      const plan = compileEditArrayProgram(program);
      const compileErrors = plan.ir.diagnostics.filter((d) => d.severity === 'error');
      if (compileErrors.length > 0) {
        return { error: compileErrors.map((d) => d.message).join('; '), ok: false };
      }

      const result = executeEditPlan(plan, chatContextRef.current.present);
      const runtimeErrors = result.diagnostics.filter((d) => d.severity === 'error');
      if (runtimeErrors.length > 0) {
        return { error: runtimeErrors.map((d) => d.message).join('; '), ok: false };
      }

      // Preserve selection so the user doesn't lose context after an apply.
      const preserved: ProjectPresent = {
        ...result.project,
        selectedAssetId: chatContextRef.current.present.selectedAssetId,
        selectedClipId: result.project.clips.some((c) => c.id === chatContextRef.current.present.selectedClipId)
          ? chatContextRef.current.present.selectedClipId
          : null,
        selectedTextId: result.project.textOverlays.some((t) => t.id === chatContextRef.current.present.selectedTextId)
          ? chatContextRef.current.present.selectedTextId
          : null,
        selectedTrackId: result.project.tracks.some((t) => t.id === chatContextRef.current.present.selectedTrackId)
          ? chatContextRef.current.present.selectedTrackId
          : null,
      };

      dispatch({ nextProject: preserved, type: 'APPLY_EAL' });
      return { ok: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'apply_eal failed', ok: false };
    }
  }, []);

  // Transcript management. Hydrate cached transcripts from IndexedDB on each
  // new fingerprint we see, kick off STT on user request, persist results so
  // they survive reloads and re-imports of the same file.
  useEffect(() => {
    const unknown: string[] = [];
    for (const asset of present.assets) {
      const fp = createMediaFingerprint(asset.file, asset.duration);
      if (!(fp in assetTranscripts)) {
        unknown.push(fp);
      }
    }
    if (unknown.length === 0) return;
    let cancelled = false;
    void Promise.all(unknown.map((fp) => getAssetTranscript(fp).then((value) => ({ fp, value })))).then((rows) => {
      if (cancelled) return;
      const next: Record<string, StoredAssetTranscript> = {};
      for (const { fp, value } of rows) {
        if (value) next[fp] = value;
      }
      if (Object.keys(next).length === 0) return;
      setAssetTranscripts((current) => ({ ...current, ...next }));
    });
    return () => {
      cancelled = true;
    };
  }, [assetTranscripts, present.assets]);

  const transcribeAsset = useCallback(
    async (assetId: string) => {
      const asset = present.assets.find((candidate) => candidate.id === assetId);
      if (!asset || !asset.file) return;
      const fingerprint = createMediaFingerprint(asset.file, asset.duration);
      setTranscribeError(null);
      setTranscribingFingerprints((current) => {
        const next = new Set(current);
        next.add(fingerprint);
        return next;
      });
      try {
        const transcript = await transcribeFile(asset.file, asset.name);
        await putAssetTranscript(fingerprint, transcript);
        setAssetTranscripts((current) => ({ ...current, [fingerprint]: transcript }));
      } catch (err) {
        setTranscribeError(err instanceof Error ? err.message : 'Transcription failed');
      } finally {
        setTranscribingFingerprints((current) => {
          const next = new Set(current);
          next.delete(fingerprint);
          return next;
        });
      }
    },
    [present.assets],
  );

  // Assets without a cached transcript. Used both for the badge count on the
  // Transcribe-All button and for skipping work that's already done.
  const assetsMissingTranscripts = useMemo(
    () =>
      present.assets.filter((asset) => {
        if (!asset.file) return false;
        const fp = createMediaFingerprint(asset.file, asset.duration);
        return !assetTranscripts[fp];
      }),
    [assetTranscripts, present.assets],
  );

  const transcribeAllAssets = useCallback(async () => {
    // Process sequentially. Local whisper-cli is CPU-bound — kicking off
    // multiple concurrent transcriptions would just thrash the same cores
    // and make every job slower instead of faster.
    for (const asset of assetsMissingTranscripts) {
      await transcribeAsset(asset.id);
    }
  }, [assetsMissingTranscripts, transcribeAsset]);

  // --- Beat detection (mirrors the transcript flow) ---
  useEffect(() => {
    const unknown: string[] = [];
    for (const asset of present.assets) {
      const fp = createMediaFingerprint(asset.file, asset.duration);
      if (!(fp in assetBeats)) unknown.push(fp);
    }
    if (unknown.length === 0) return;
    let cancelled = false;
    void Promise.all(unknown.map((fp) => getAssetBeatsTolerant(fp).then((value) => ({ fp, value })))).then((rows) => {
      if (cancelled) return;
      const next: Record<string, StoredBeatData> = {};
      for (const { fp, value } of rows) {
        if (value) next[fp] = value;
      }
      if (Object.keys(next).length === 0) return;
      setAssetBeats((current) => ({ ...current, ...next }));
    });
    return () => {
      cancelled = true;
    };
  }, [assetBeats, present.assets]);

  // Subtitle generation. Pulls the clip's transcript (by fingerprint),
  // builds cues via the shared helper in src/subtitles.ts, and dispatches
  // each cue as ADD_TEXT so every cue is a normal, undoable timeline
  // overlay the user can edit independently afterwards.
  const generateSubtitlesForClip = useCallback(
    (clip: TimelineClip, mode: SubtitleMode, templateId: SubtitleTemplateId) => {
      const project = chatContextRef.current.present;
      const asset = project.assets.find((a) => a.id === clip.assetId);
      if (!asset?.file) return;
      const fingerprint = createMediaFingerprint(asset.file, asset.duration);
      const transcript = assetTranscripts[fingerprint];
      if (!transcript) return;
      const template = findSubtitleTemplate(templateId);
      const textTrackId =
        project.tracks.find((t) => t.kind === 'text')?.id ?? '';
      const targetTrackId = textTrackId || 'text-1';
      const cues = generateSubtitleCues(transcript, clip, {
        createId: () => createId('text'),
        mode,
        template,
        trackId: targetTrackId,
      });
      const clipTimelineEnd = clip.timelineStart + Math.max(0, clip.sourceOut - clip.sourceIn);
      dispatch({
        overlays: cues,
        rangeEnd: clipTimelineEnd,
        rangeStart: clip.timelineStart,
        trackId: targetTrackId,
        type: 'REPLACE_TEXTS_IN_RANGE',
      });
    },
    [assetTranscripts],
  );

  const detectAssetBeats = useCallback(
    async (assetId: string) => {
      const asset = present.assets.find((candidate) => candidate.id === assetId);
      if (!asset || !asset.file) return;
      const fingerprint = createMediaFingerprint(asset.file, asset.duration);
      setBeatError(null);
      setDetectingBeatsFingerprints((current) => {
        const next = new Set(current);
        next.add(fingerprint);
        return next;
      });
      try {
        const result = await detectBeats(asset.file);
        await putAssetBeats(fingerprint, result);
        setAssetBeats((current) => ({ ...current, [fingerprint]: result }));
      } catch (err) {
        setBeatError(err instanceof Error ? err.message : 'Beat detection failed');
      } finally {
        setDetectingBeatsFingerprints((current) => {
          const next = new Set(current);
          next.delete(fingerprint);
          return next;
        });
      }
    },
    [present.assets],
  );

  const assetsMissingBeats = useMemo(
    () =>
      present.assets.filter((asset) => {
        if (!asset.file) return false;
        const fp = createMediaFingerprint(asset.file, asset.duration);
        return !assetBeats[fp];
      }),
    [assetBeats, present.assets],
  );

  const detectAllBeats = useCallback(async () => {
    for (const asset of assetsMissingBeats) {
      await detectAssetBeats(asset.id);
    }
  }, [assetsMissingBeats, detectAssetBeats]);

  // Project all clip-local beats AND downbeats onto timeline-time. We do both
  // in one pass so the visualisation + snap + chat-context layers all read
  // the same projection. Downbeats carry per-asset metadata so the grid can
  // colour-code and icon-tag markers by source media.
  const { timelineBeatTargets, timelineDownbeatTargets } = useMemo(() => {
    const beats: number[] = [];
    const downbeats: Array<{
      assetId: string;
      clipKind: 'audio' | 'video' | 'text' | 'unknown';
      time: number;
    }> = [];
    for (const clip of present.clips) {
      const asset = present.assets.find((a) => a.id === clip.assetId);
      if (!asset?.file) continue;
      const fp = createMediaFingerprint(asset.file, asset.duration);
      const data = assetBeats[fp];
      if (!data) continue;
      const track = present.tracks.find((t) => t.id === clip.trackId);
      const clipKind: 'audio' | 'video' | 'text' | 'unknown' = (track?.kind ?? asset.kind ?? 'unknown') as
        | 'audio'
        | 'video'
        | 'text'
        | 'unknown';
      const clipDuration = Math.max(0, clip.sourceOut - clip.sourceIn);
      const project = (sourceTime: number) => clip.timelineStart + (sourceTime - clip.sourceIn);
      const inRange = (sourceTime: number) =>
        sourceTime >= clip.sourceIn && sourceTime <= clip.sourceOut;
      const onTimeline = (timelineTime: number) =>
        timelineTime <= clip.timelineStart + clipDuration + 0.0005;

      for (const beat of data.beats) {
        if (!inRange(beat)) continue;
        const t = project(beat);
        if (onTimeline(t)) beats.push(t);
      }
      for (const downbeat of data.downbeats ?? []) {
        if (!inRange(downbeat)) continue;
        const t = project(downbeat);
        if (onTimeline(t)) downbeats.push({ assetId: asset.id, clipKind, time: t });
      }
    }
    return { timelineBeatTargets: beats, timelineDownbeatTargets: downbeats };
  }, [assetBeats, present.assets, present.clips, present.tracks]);

  // Sticky asset for the primary <video> element: keep the last video asset
  // mounted across gaps so we don't pay the unmount-remount cost (decoder
  // teardown, metadata re-parse, keyframe re-seek). Gap UX: video pauses on
  // its last frame and the viewer overlays black; playhead clock keeps moving.
  const stickyVideoAssetRef = useRef<ProjectAsset | null>(null);
  const lastVideoAssetOnTimeline = useMemo(() => {
    if (activeAsset?.kind === 'video') {
      return activeAsset;
    }
    // No active video clip right now — fall back to whichever video asset
    // a timeline clip references, preferring the one we were just using.
    const stickyId = stickyVideoAssetRef.current?.id;
    if (stickyId) {
      const stickyClipStillExists = present.clips.some((clip) => clip.assetId === stickyId);
      if (stickyClipStillExists) {
        const reused = present.assets.find((asset) => asset.id === stickyId);
        if (reused) return reused;
      }
    }
    for (const clip of present.clips) {
      const asset = present.assets.find((candidate) => candidate.id === clip.assetId);
      if (asset && asset.kind === 'video') {
        return asset;
      }
    }
    return null;
  }, [activeAsset, present]);
  useEffect(() => {
    if (lastVideoAssetOnTimeline) {
      stickyVideoAssetRef.current = lastVideoAssetOnTimeline;
    }
  }, [lastVideoAssetOnTimeline]);
  const lastAudioAssetOnTimeline = useMemo(() => {
    if (activeAsset?.kind === 'audio' && !lastVideoAssetOnTimeline) {
      return activeAsset;
    }
    return null;
  }, [activeAsset, lastVideoAssetOnTimeline]);
  const isInVideoGap = activeClip ? activeAsset?.kind !== 'video' && Boolean(lastVideoAssetOnTimeline) : Boolean(lastVideoAssetOnTimeline);
  const selectedClipAsset = useMemo(() => getClipAsset(present, selectedClip), [present, selectedClip]);
  const fanOutTextPatch = useCallback(
    (action: Parameters<typeof projectReducer>[1]): boolean => {
      if (action.type !== 'UPDATE_TEXT' || !bulkTextEdit || present.textOverlays.length <= 1) {
        return false;
      }
      const stylePatch: Partial<TextOverlay> = { ...action.patch };
      delete stylePatch.end;
      delete stylePatch.start;
      delete stylePatch.text;
      delete stylePatch.trackId;
      if (Object.keys(stylePatch).length === 0) return false;
      for (const overlay of present.textOverlays) {
        dispatch({ patch: stylePatch, record: action.record, textId: overlay.id, type: 'UPDATE_TEXT' });
      }
      return true;
    },
    [bulkTextEdit, present.textOverlays, dispatch],
  );
  const textInspectorDispatch = useCallback<Dispatch<Parameters<typeof projectReducer>[1]>>(
    (action) => {
      if (fanOutTextPatch(action)) return;
      dispatch(action);
    },
    [fanOutTextPatch, dispatch],
  );
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
  const audioTracksTop = TIMELINE_TRACK_TOP + videoTracksHeight;
  const textTracksTop = audioTracksTop + audioTracksHeight;
  // Timeline viewport in TIME units (seconds). Used to virtualize per-row
  // clip rendering: a row renders only the clips that overlap this window,
  // not the entire `present.clips` list. With 500+ clips, this is the
  // difference between rendering 500 DOM buttons and rendering ~10.
  const [timelineViewportTime, setTimelineViewportTime] = useState<{ end: number; start: number }>({ end: Infinity, start: 0 });
  const timelineViewportRafRef = useRef<number | null>(null);
  useEffect(() => {
    const scrollEl = timelineScrollRef.current;
    if (!scrollEl) return;

    const computeViewport = () => {
      timelineViewportRafRef.current = null;
      const leftPx = scrollEl.scrollLeft;
      const widthPx = scrollEl.clientWidth;
      const overscanPx = Math.max(240, widthPx * 0.25);
      const startPx = Math.max(0, leftPx - overscanPx - TIMELINE_LABEL_WIDTH);
      const endPx = leftPx + widthPx + overscanPx - TIMELINE_LABEL_WIDTH;
      const pixelsPerSecond = TIMELINE_PIXELS_PER_SECOND * timelineZoom;
      setTimelineViewportTime({
        end: endPx / pixelsPerSecond,
        start: startPx / pixelsPerSecond,
      });
    };

    const onScroll = () => {
      if (timelineViewportRafRef.current !== null) return;
      timelineViewportRafRef.current = window.requestAnimationFrame(computeViewport);
    };

    computeViewport();
    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);

    return () => {
      scrollEl.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (timelineViewportRafRef.current !== null) {
        window.cancelAnimationFrame(timelineViewportRafRef.current);
        timelineViewportRafRef.current = null;
      }
    };
  }, [timelineZoom]);

  const trackLayout = useMemo(() => {
    const map = new Map<string, { height: number; kind: 'audio' | 'text' | 'video'; top: number }>();
    let cursor = TIMELINE_TRACK_TOP;
    for (const track of videoTracks) {
      map.set(track.id, { height: TIMELINE_TRACK_HEIGHT, kind: 'video', top: cursor });
      cursor += TIMELINE_TRACK_HEIGHT + TIMELINE_TRACK_GAP;
    }
    for (const track of audioTracks) {
      map.set(track.id, { height: TIMELINE_AUDIO_TRACK_HEIGHT, kind: 'audio', top: cursor });
      cursor += TIMELINE_AUDIO_TRACK_HEIGHT + TIMELINE_TRACK_GAP;
    }
    for (const track of textTracks) {
      map.set(track.id, { height: TIMELINE_TEXT_TRACK_HEIGHT, kind: 'text', top: cursor });
      cursor += TIMELINE_TEXT_TRACK_HEIGHT + TIMELINE_TRACK_GAP;
    }
    return { layout: map, totalHeight: cursor };
  }, [audioTracks, textTracks, videoTracks]);
  const timelineContentHeight = trackLayout.totalHeight + 24;
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
    // The preview frame is always the project's output rectangle —
    // vertical / landscape / square / custom. Clips inside the frame use
    // their per-clip transform (scale, x, y, rotation) to fit; the frame
    // never adapts to whatever asset happens to be loaded. The asset-first
    // lookup used to live here, which made a horizontal source render a
    // horizontal preview inside a vertical project.
    const frameWidth = Math.max(1, projectSettings.width || 16);
    const frameHeight = Math.max(1, projectSettings.height || 9);

    if (viewerSize.width <= 0 || viewerSize.height <= 0) {
      return {
        aspectRatio: `${frameWidth} / ${frameHeight}`,
        maxHeight: '100%',
        maxWidth: '100%',
      };
    }

    const scale = Math.min(viewerSize.width / frameWidth, viewerSize.height / frameHeight);

    return {
      height: `${Math.max(1, Math.floor(frameHeight * scale))}px`,
      width: `${Math.max(1, Math.floor(frameWidth * scale))}px`,
    };
  }, [projectSettings.height, projectSettings.width, viewerSize.height, viewerSize.width]);
  const getClipTransformStyle = useCallback((clip: TimelineClip | null): CSSProperties => {
    const transform = clip?.transform ?? { rotation: 0, scale: 1, x: 0.5, y: 0.5 };
    const rotation = transform.rotation ?? 0;

    return {
      transform: `translate3d(${(transform.x - 0.5) * 100}%, ${(transform.y - 0.5) * 100}%, 0) rotate(${rotation}deg) scale(${transform.scale})`,
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
    wallClockMode: isPlaying && !activeTimeline,
    playbackRate,
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
    if (!pending) return;
    if (fanOutTextPatch(pending)) return;
    dispatch(pending);
  }, [fanOutTextPatch]);

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
        extraTargets: timelineBeatTargets,
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
    [hideSnapIndicator, playhead, present, showSnapIndicatorAt, snapEnabled, timelineBeatTargets, timelinePixelsPerSecond],
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
        ...DEFAULT_TEXT_OVERLAY,
        end: Math.min(duration, start + 3),
        id: createId('text'),
        start,
        trackId: targetTextTrack,
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
            size: clamp(mode.startSize + (event.clientX - mode.startX) * 0.6, 8, 240),
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
        return;
      }

      if (mode.type === 'preview-clip-rotate') {
        const angle = (Math.atan2(event.clientY - mode.centerY, event.clientX - mode.centerX) * 180) / Math.PI;
        let next = mode.startRotation + (angle - mode.startAngle);
        // Wrap into [-180, 180] so the inspector field stays in range.
        next = ((next + 540) % 360) - 180;
        dispatchDragAction({
          clipId: mode.clipId,
          record: false,
          transform: { rotation: next },
          type: 'UPDATE_CLIP_TRANSFORM',
        });
        return;
      }

      if (mode.type === 'preview-text-rotate') {
        const angle = (Math.atan2(event.clientY - mode.centerY, event.clientX - mode.centerX) * 180) / Math.PI;
        let next = mode.startRotation + (angle - mode.startAngle);
        next = ((next + 540) % 360) - 180;
        dispatchDragAction({
          patch: { rotation: next },
          record: false,
          textId: mode.textId,
          type: 'UPDATE_TEXT',
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
      mode?.type === 'preview-text-rotate' ||
      mode?.type === 'preview-clip-move' ||
      mode?.type === 'preview-clip-scale' ||
      mode?.type === 'preview-clip-rotate'
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
        startTransform: activeClip.transform ?? { rotation: 0, scale: 1, x: 0.5, y: 0.5 },
        startX: event.clientX,
        startY: event.clientY,
        type: 'preview-clip-move',
      });
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [activeClip, setDragMode],
  );

  const onPreviewClipRotatePointerDown = useCallback(
    (event: PointerEvent<HTMLSpanElement>) => {
      if (!activeClip) return;
      event.stopPropagation();
      const rect = (event.currentTarget.closest('.clip-transform-box') ?? event.currentTarget).getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const startAngle = (Math.atan2(event.clientY - centerY, event.clientX - centerX) * 180) / Math.PI;
      dispatch({ clipId: activeClip.id, type: 'SELECT_CLIP' });
      setDragMode({
        centerX,
        centerY,
        clipId: activeClip.id,
        startAngle,
        startRotation: activeClip.transform?.rotation ?? 0,
        type: 'preview-clip-rotate',
      });
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [activeClip, setDragMode],
  );

  const onPreviewTextRotatePointerDown = useCallback(
    (event: PointerEvent<HTMLSpanElement>, overlay: TextOverlay) => {
      event.stopPropagation();
      const host = event.currentTarget.parentElement ?? event.currentTarget;
      const rect = host.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const startAngle = (Math.atan2(event.clientY - centerY, event.clientX - centerX) * 180) / Math.PI;
      dispatch({ textId: overlay.id, type: 'SELECT_TEXT' });
      setDragMode({
        centerX,
        centerY,
        startAngle,
        startRotation: overlay.rotation,
        textId: overlay.id,
        type: 'preview-text-rotate',
      });
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [setDragMode],
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

    if (!media) {
      return;
    }

    // Entering a gap (no active clip) — pause the master so it doesn't keep
    // playing into un-edited portions of the source. The sticky <video>
    // element stays mounted on its last frame; the gap overlay covers it.
    if (!activeTimeline || !activeAsset) {
      if (clipChanged) {
        media.pause();
      }
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
          {assetsMissingTranscripts.length > 0 ? (
            <button
              className="button secondary"
              disabled={transcribingFingerprints.size > 0}
              onClick={() => void transcribeAllAssets()}
              title={`Transcribe ${assetsMissingTranscripts.length} clip${assetsMissingTranscripts.length === 1 ? '' : 's'}`}
              type="button"
            >
              <Mic size={15} />
              {transcribingFingerprints.size > 0
                ? `Transcribing ${transcribingFingerprints.size}/${assetsMissingTranscripts.length}`
                : `Transcribe (${assetsMissingTranscripts.length})`}
            </button>
          ) : null}
          {assetsMissingBeats.length > 0 ? (
            <button
              className="button secondary"
              disabled={detectingBeatsFingerprints.size > 0}
              onClick={() => void detectAllBeats()}
              title={`Detect beats for ${assetsMissingBeats.length} clip${assetsMissingBeats.length === 1 ? '' : 's'}`}
              type="button"
            >
              <Activity size={15} />
              {detectingBeatsFingerprints.size > 0
                ? `Beats ${detectingBeatsFingerprints.size}/${assetsMissingBeats.length}`
                : `Beats (${assetsMissingBeats.length})`}
            </button>
          ) : null}
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
            <div className="asset-grid">
              {present.assets.map((asset) => (
                <AssetCard
                  asset={asset}
                  key={asset.id}
                  onAddToTimeline={() => addAssetToTimeline(asset.id)}
                  onDelete={() => deleteAssetFromLibrary(asset.id)}
                  onDragStart={(event) => onAssetDragStart(event, asset)}
                  onSelect={() => dispatch({ assetId: asset.id, type: 'SELECT_ASSET' })}
                  selected={asset.id === present.selectedAssetId}
                />
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
            {hasTimeline && (activeAsset || lastVideoAssetOnTimeline || lastAudioAssetOnTimeline) ? (
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
                {/* PreviewLayerAudio owns every audio-track clip uniformly so the same
                    <audio> element keeps playing across clip-end / gap / clip-start. No
                    element swap = no glitch. Primary <audio> only renders for audio-only
                    timelines (no video anywhere). */}
                {!(!lastVideoAssetOnTimeline && lastAudioAssetOnTimeline)
                  ? activeAudioLayerTimelines.map((timeline) => {
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
                    })
                  : null}
                {lastVideoAssetOnTimeline ? (
                  <video
                    className={isGpuPreviewActive ? 'is-composited' : undefined}
                    key="primary-video"
                    onError={onPreviewPlaybackError}
                    onLoadedMetadata={onPreviewLoadedMetadata}
                    onSeeked={markSeekEnd}
                    onTimeUpdate={onPreviewTimeUpdate}
                    playsInline
                    preload="auto"
                    ref={attachVideoRef}
                    src={lastVideoAssetOnTimeline.playbackUrl}
                    style={activeClipTransformStyle}
                  />
                ) : null}
                {/* Primary <audio> only renders for AUDIO-ONLY timelines (no video
                    anywhere). When the timeline has video clips, every audio clip plays
                    through PreviewLayerAudio so no element swap happens at boundaries —
                    the same <audio> keeps playing across clip-1 → gap → clip-2. */}
                {!lastVideoAssetOnTimeline && lastAudioAssetOnTimeline ? (
                  <>
                    <div className="audio-only-stage" aria-hidden="true">
                      <Music size={42} />
                      <strong>{lastAudioAssetOnTimeline.name}</strong>
                      <span>Audio only</span>
                    </div>
                    <audio
                      key="primary-audio"
                      onError={onPreviewPlaybackError}
                      onLoadedMetadata={onPreviewLoadedMetadata}
                      onSeeked={markSeekEnd}
                      onTimeUpdate={onPreviewTimeUpdate}
                      preload="auto"
                      ref={attachAudioPrimaryRef}
                      src={lastAudioAssetOnTimeline.playbackUrl}
                    />
                  </>
                ) : null}
                {isInVideoGap ? <div aria-hidden="true" className="viewer-gap-overlay" /> : null}
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
                    <span
                      aria-hidden="true"
                      className="canvas-rotate-handle clip-rotate-handle"
                      onPointerDown={onPreviewClipRotatePointerDown}
                    />
                  </button>
                ) : null}
                <div className="text-overlay-layer">
                  {activeTextOverlays.map((overlay) => (
                    <div
                      className={`preview-text align-${overlay.align}${overlay.id === present.selectedTextId || bulkTextEdit ? ' is-selected' : ''}${bulkTextEdit ? ' is-bulk-selected' : ''}`}
                      key={overlay.id}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          dispatch({ textId: overlay.id, type: 'SELECT_TEXT' });
                        }
                      }}
                      onPointerDown={(event) => onPreviewTextPointerDown(event, overlay)}
                      role="button"
                      style={buildPreviewTextStyle(overlay)}
                      tabIndex={0}
                    >
                      {applyTextCase(overlay.text, overlay.textCase)}
                      <span
                        aria-hidden="true"
                        className="canvas-scale-handle text-scale-handle"
                        onPointerDown={(event) => onPreviewTextScalePointerDown(event, overlay)}
                      />
                      <span
                        aria-hidden="true"
                        className="canvas-rotate-handle text-rotate-handle"
                        onPointerDown={(event) => onPreviewTextRotatePointerDown(event, overlay)}
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
                assetBeats={assetBeats}
                assetTranscripts={assetTranscripts}
                beatError={beatError}
                capabilities={capabilities}
                detectAssetBeats={detectAssetBeats}
                detectingBeatsFingerprints={detectingBeatsFingerprints}
                deleteSelected={deleteSelected}
                deleteAssetFromLibrary={deleteAssetFromLibrary}
                dispatch={textInspectorDispatch}
                bulkTextEdit={bulkTextEdit}
                setBulkTextEdit={setBulkTextEdit}
                generateSubtitlesForClip={generateSubtitlesForClip}
                hasTimeline={hasTimeline}
                project={present}
                selectedAsset={selectedAsset}
                selectedClip={selectedClip}
                selectedClipAsset={selectedClipAsset}
                selectedText={selectedText}
                splitAtPlayhead={splitAtPlayhead}
                transcribeAsset={transcribeAsset}
                transcribeError={transcribeError}
                transcribingFingerprints={transcribingFingerprints}
              />
            ) : (
              <ChatPanel applyToolCall={applyChatToolCall} getContext={getChatContext} />
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
              aria-label={beatMarkersVisible ? 'Hide beat-sync markers' : 'Show beat-sync markers'}
              className={`icon-button small${beatMarkersVisible ? ' is-active' : ''}`}
              disabled={timelineDownbeatTargets.length === 0}
              onClick={() => setBeatMarkersVisible((value) => !value)}
              title={
                timelineDownbeatTargets.length === 0
                  ? 'Detect beats on a clip to enable markers'
                  : beatMarkersVisible
                    ? 'Beat-sync markers on — click to hide'
                    : 'Beat-sync markers hidden'
              }
              type="button"
            >
              <Activity size={15} />
            </button>
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
            <TimelineBeatGrid
              beatPositions={timelineBeatTargets}
              downbeatPositions={timelineDownbeatTargets}
              pixelsPerSecond={timelinePixelsPerSecond}
              labelWidth={TIMELINE_LABEL_WIDTH}
              visible={beatMarkersVisible}
              viewport={timelineViewportTime}
            />
            <div className="timeline-playhead" ref={playheadRef}>
              <span />
            </div>
            <div aria-hidden="true" className="timeline-snap-indicator" ref={snapIndicatorRef} />

            {videoTracks.map((track) => {
              const slot = trackLayout.layout.get(track.id);
              const top = slot?.top ?? TIMELINE_TRACK_TOP;
              const allTrackClips = timelineIndex.clipsByTrack.get(track.id) ?? [];
              const trackClips = filterClipsInViewport(allTrackClips, timelineViewportTime);

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
                  style={{ height: `${slot?.height ?? TIMELINE_TRACK_HEIGHT}px`, top: `${top}px` }}
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
                  {trackClips.length === 0 && present.clips.length === 0 && videoTracks[0]?.id === track.id ? (
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

            {audioTracks.map((track) => {
              const slot = trackLayout.layout.get(track.id);
              const top = slot?.top ?? audioTracksTop;
              const allTrackClips = timelineIndex.clipsByTrack.get(track.id) ?? [];
              const trackClips = filterClipsInViewport(allTrackClips, timelineViewportTime);

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
                  style={{ height: `${slot?.height ?? TIMELINE_AUDIO_TRACK_HEIGHT}px`, top: `${top}px` }}
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

            {textTracks.map((track) => {
              const slot = trackLayout.layout.get(track.id);
              const top = slot?.top ?? textTracksTop;
              const allOverlays = timelineIndex.textOverlaysByTrack.get(track.id) ?? [];
              const trackOverlays = filterTextOverlaysInViewport(allOverlays, timelineViewportTime);

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
                  style={{ height: `${slot?.height ?? TIMELINE_TEXT_TRACK_HEIGHT}px`, top: `${top}px` }}
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
                        className={`timeline-clip timeline-clip-text${overlay.id === present.selectedTextId || bulkTextEdit ? ' is-selected' : ''}${bulkTextEdit ? ' is-bulk-selected' : ''}`}
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
  assetBeats: Record<string, StoredBeatData>;
  assetTranscripts: Record<string, StoredAssetTranscript>;
  beatError: string | null;
  bulkTextEdit: boolean;
  capabilities: ReturnType<typeof detectMediaCapabilities>;
  deleteAssetFromLibrary: (assetId: string) => void;
  deleteSelected: () => void;
  detectAssetBeats: (assetId: string) => Promise<void>;
  detectingBeatsFingerprints: Set<string>;
  dispatch: Dispatch<Parameters<typeof projectReducer>[1]>;
  setBulkTextEdit: (next: boolean) => void;
  generateSubtitlesForClip: (clip: TimelineClip, mode: SubtitleMode, template: SubtitleTemplateId) => void;
  hasTimeline: boolean;
  project: ProjectPresent;
  selectedAsset: ProjectAsset | null;
  selectedClip: TimelineClip | null;
  selectedClipAsset: ProjectAsset | null;
  selectedText: TextOverlay | null;
  splitAtPlayhead: () => void;
  transcribeAsset: (assetId: string) => Promise<void>;
  transcribeError: string | null;
  transcribingFingerprints: Set<string>;
};

type ClipBeatsSectionProps = {
  asset: ProjectAsset | null;
  assetBeats: Record<string, StoredBeatData>;
  detectingFingerprints: Set<string>;
  error: string | null;
  onDetect: (assetId: string) => void | Promise<void>;
};

function ClipBeatsSection({ asset, assetBeats, detectingFingerprints, error, onDetect }: ClipBeatsSectionProps) {
  if (!asset) return null;
  const fingerprint = createMediaFingerprint(asset.file, asset.duration);
  const data = assetBeats[fingerprint] ?? null;
  const inFlight = detectingFingerprints.has(fingerprint);
  return (
    <>
      <div className="subhead">Beats</div>
      {data ? (
        <div className="meta-grid transcript-meta">
          <span>BPM</span>
          <strong>{typeof data.bpm === 'number' ? data.bpm.toFixed(1) : '—'}</strong>
          <span>Beats</span>
          <strong>{data.beats.length}</strong>
          <span>Downbeats</span>
          <strong>{data.downbeats?.length ?? 0}</strong>
        </div>
      ) : (
        <p className="transcript-empty">No beat grid yet — detect to enable beat-aware snapping and AI cut-on-beat.</p>
      )}
      <div className="button-grid">
        <button
          className="button secondary"
          disabled={inFlight}
          onClick={() => onDetect(asset.id)}
          type="button"
        >
          {inFlight ? 'Detecting…' : data ? 'Re-detect' : 'Detect Beats'}
        </button>
      </div>
      {error ? <p className="transcript-error">{error}</p> : null}
    </>
  );
}

type ClipTranscriptSectionProps = {
  asset: ProjectAsset | null;
  assetTranscripts: Record<string, StoredAssetTranscript>;
  clip: TimelineClip | null;
  error: string | null;
  onGenerateSubtitles: (clip: TimelineClip, mode: SubtitleMode, template: SubtitleTemplateId) => void;
  onTranscribe: (assetId: string) => void | Promise<void>;
  transcribingFingerprints: Set<string>;
};

function ClipTranscriptSection({
  asset,
  assetTranscripts,
  clip,
  error,
  onGenerateSubtitles,
  onTranscribe,
  transcribingFingerprints,
}: ClipTranscriptSectionProps) {
  if (!asset) return null;
  const fingerprint = createMediaFingerprint(asset.file, asset.duration);
  const transcript = assetTranscripts[fingerprint] ?? null;
  const inFlight = transcribingFingerprints.has(fingerprint);

  // Word count: prefer the provider's word array; if empty (whisper.cpp
  // returns segments-only by default) fall back to a whitespace-split of the
  // full text so the user sees a meaningful number.
  let wordCount = 0;
  if (transcript) {
    wordCount = transcript.words.length > 0
      ? transcript.words.length
      : transcript.text.trim().split(/\s+/).filter(Boolean).length;
  }
  const preview = transcript?.text?.trim() ?? '';
  const previewClipped = preview.length > 900 ? `${preview.slice(0, 900)}…` : preview;

  return (
    <>
      <div className="subhead">Transcript</div>
      {transcript ? (
        <>
          <div className="meta-grid transcript-meta">
            <span>Words</span>
            <strong>{wordCount.toLocaleString()}</strong>
            <span>Segments</span>
            <strong>{transcript.segments.length}</strong>
            <span>Language</span>
            <strong>{transcript.language ?? 'auto'}</strong>
            <span>Model</span>
            <strong>{transcript.model}</strong>
          </div>
          {previewClipped ? <p className="transcript-preview">{previewClipped}</p> : (
            <p className="transcript-empty">Transcript came back empty — re-run after checking the clip has audible speech.</p>
          )}
        </>
      ) : (
        <p className="transcript-empty">No transcript yet — run STT to make filler-word and sentence-aware edits possible.</p>
      )}
      <div className="button-grid">
        <button
          className="button secondary"
          disabled={inFlight || !fingerprint}
          onClick={() => onTranscribe(asset.id)}
          type="button"
        >
          {inFlight ? 'Transcribing…' : transcript ? 'Re-run' : 'Transcribe'}
        </button>
      </div>
      {error ? <p className="transcript-error">{error}</p> : null}
      {transcript && clip ? (
        <SubtitleGenerator clip={clip} onGenerate={onGenerateSubtitles} hasWordTimestamps={transcript.words.length > 0} />
      ) : null}
    </>
  );
}

type SubtitleGeneratorProps = {
  clip: TimelineClip;
  hasWordTimestamps: boolean;
  onGenerate: (clip: TimelineClip, mode: SubtitleMode, template: SubtitleTemplateId) => void;
};

function SubtitleGenerator({ clip, hasWordTimestamps, onGenerate }: SubtitleGeneratorProps) {
  const [mode, setMode] = useState<SubtitleMode>('sentence');
  const [templateId, setTemplateId] = useState<SubtitleTemplateId>('clean-lower-third');
  return (
    <>
      <div className="subhead">Subtitles</div>
      <label className="field">
        <span>Mode</span>
        <select onChange={(event) => setMode(event.target.value as SubtitleMode)} value={mode}>
          <option value="sentence">Sentence (default)</option>
          <option value="phrase">Short phrase</option>
          <option value="word" disabled={!hasWordTimestamps}>
            Word-by-word {hasWordTimestamps ? '' : '(needs word timestamps)'}
          </option>
        </select>
      </label>
      <SubtitleTemplatePicker value={templateId} onChange={setTemplateId} />
      <div className="button-grid">
        <button className="button" onClick={() => onGenerate(clip, mode, templateId)} type="button">
          Generate Subtitles
        </button>
      </div>
    </>
  );
}

type SubtitleTemplatePickerProps = {
  /** When provided, picking a card just emits onChange (selection mode).
   *  When null, every card has its own action button (apply mode). */
  onChange?: (id: SubtitleTemplateId) => void;
  /** Apply-mode handler. Receives the template id; UI clears selection after. */
  onApply?: (id: SubtitleTemplateId) => void;
  /** Currently-selected id (only in selection mode). */
  value?: SubtitleTemplateId | null;
};

// Renders every subtitle template as a small visual preview tile: a faux
// video frame with a real-style caption rendered using the template's CSS.
// The preview is built from the same style fields the export pipeline reads,
// so what the user picks here is what they get on the timeline.
function SubtitleTemplatePicker({ onApply, onChange, value }: SubtitleTemplatePickerProps) {
  return (
    <div className="template-picker">
      {SUBTITLE_TEMPLATES.map((tpl) => {
        const isSelected = value === tpl.id;
        const handleClick = () => {
          if (onChange) onChange(tpl.id);
          if (onApply) onApply(tpl.id);
        };
        const previewStyle = buildTemplatePreviewStyle(tpl.style);
        return (
          <button
            aria-pressed={isSelected}
            className={`template-card${isSelected ? ' is-selected' : ''}`}
            key={tpl.id}
            onClick={handleClick}
            title={tpl.description}
            type="button"
          >
            <span className="template-card-frame" aria-hidden="true">
              <span className="template-card-bars" />
              <span className="template-card-caption" style={previewStyle}>
                {tpl.style.textCase === 'upper' ? 'CAPTION' : 'Caption'}
              </span>
            </span>
            <span className="template-card-label">{tpl.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// Translate a template's style fields into CSS rules for the preview tile.
// Sizes are downscaled from output-resolution pixels to the tile's scale so
// the preview reads the same shape proportions as the rendered subtitle.
function buildTemplatePreviewStyle(style: Partial<TextOverlay>): CSSProperties {
  const tileWidthPx = 132; // matches .template-card-frame width
  const projectWidthPx = 1080; // sizing scale reference
  const scale = tileWidthPx / projectWidthPx;
  const size = (style.size ?? 54) * scale;
  const strokeWidth = (style.strokeWidth ?? 0) * scale;
  const shadowOffsetY = (style.shadowOffsetY ?? 0) * scale;
  const shadowOffsetX = (style.shadowOffsetX ?? 0) * scale;
  const shadowBlur = (style.shadowBlur ?? 0) * scale;
  const fontFamily = style.fontFamily ? getFontStack(style.fontFamily) : undefined;
  const css: CSSProperties = {
    color: style.color ?? '#ffffff',
    fontFamily,
    fontSize: `${size.toFixed(2)}px`,
    fontStyle: style.italic ? 'italic' : 'normal',
    fontWeight: style.bold ? 800 : 500,
    lineHeight: style.lineHeight ?? 1.2,
    textTransform: style.textCase === 'upper' ? 'uppercase' : style.textCase === 'lower' ? 'lowercase' : 'none',
  };
  if (style.backgroundColor && !style.backgroundColor.endsWith('00')) {
    css.background = style.backgroundColor;
    css.padding = '2px 6px';
    css.borderRadius = '2px';
  }
  if (strokeWidth > 0) {
    (css as CSSProperties & { WebkitTextStrokeWidth?: string; WebkitTextStrokeColor?: string }).WebkitTextStrokeWidth =
      `${strokeWidth.toFixed(2)}px`;
    (css as CSSProperties & { WebkitTextStrokeWidth?: string; WebkitTextStrokeColor?: string }).WebkitTextStrokeColor =
      style.strokeColor ?? '#000000';
  }
  if (shadowBlur > 0 || shadowOffsetX !== 0 || shadowOffsetY !== 0) {
    css.textShadow = `${shadowOffsetX.toFixed(2)}px ${shadowOffsetY.toFixed(2)}px ${shadowBlur.toFixed(2)}px ${style.shadowColor ?? '#000000'}`;
  }
  return css;
}

function Inspector({
  addAssetToTimeline,
  assetBeats,
  assetTranscripts,
  beatError,
  bulkTextEdit,
  capabilities,
  deleteAssetFromLibrary,
  deleteSelected,
  detectAssetBeats,
  detectingBeatsFingerprints,
  dispatch,
  generateSubtitlesForClip,
  hasTimeline,
  project,
  selectedAsset,
  selectedClip,
  selectedClipAsset,
  selectedText,
  setBulkTextEdit,
  splitAtPlayhead,
  transcribeAsset,
  transcribeError,
  transcribingFingerprints,
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

    const totalTextOverlays = project.textOverlays.length;
    const canBulkEdit = totalTextOverlays > 1;
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
          {canBulkEdit && (
            <div className={`bulk-edit-row${bulkTextEdit ? ' is-active' : ''}`}>
              <button
                className={`chip${bulkTextEdit ? ' is-active' : ''}`}
                onClick={() => setBulkTextEdit(!bulkTextEdit)}
                title="Apply style, position and transform changes to every text overlay"
                type="button"
              >
                {bulkTextEdit ? `✓ All Text Selected (${totalTextOverlays})` : `Select All Text (${totalTextOverlays})`}
              </button>
              {bulkTextEdit && (
                <span className="bulk-edit-hint">
                  Style, transform and position edits apply to all overlays.
                </span>
              )}
            </div>
          )}
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
            <textarea
              className="text-content-input"
              onChange={(event) => dispatch({ patch: { text: event.target.value }, textId: selectedText.id, type: 'UPDATE_TEXT' })}
              rows={3}
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

          <div className="subhead">Typography</div>
          <FontPicker
            onChange={(fontFamily) =>
              dispatch({ patch: { fontFamily }, textId: selectedText.id, type: 'UPDATE_TEXT' })
            }
            value={selectedText.fontFamily}
          />
          <ControlNumber label="Size" max={240} min={8} step={1} value={selectedText.size} onChange={(value) => dispatch({ patch: { size: value }, textId: selectedText.id, type: 'UPDATE_TEXT' })} />
          <ControlNumber label="Letter Spacing" max={32} min={-8} step={0.5} value={selectedText.letterSpacing} onChange={(value) => dispatch({ patch: { letterSpacing: value }, textId: selectedText.id, type: 'UPDATE_TEXT' })} />
          <ControlNumber label="Line Height" max={3} min={0.8} step={0.05} value={selectedText.lineHeight} onChange={(value) => dispatch({ patch: { lineHeight: value }, textId: selectedText.id, type: 'UPDATE_TEXT' })} />
          <div className="button-row">
            <button className={`chip${selectedText.bold ? ' is-active' : ''}`} onClick={() => dispatch({ patch: { bold: !selectedText.bold }, textId: selectedText.id, type: 'UPDATE_TEXT' })} title="Bold" type="button">B</button>
            <button className={`chip${selectedText.italic ? ' is-active' : ''}`} onClick={() => dispatch({ patch: { italic: !selectedText.italic }, textId: selectedText.id, type: 'UPDATE_TEXT' })} title="Italic" type="button"><span style={{ fontStyle: 'italic' }}>I</span></button>
            <button className={`chip${selectedText.underline ? ' is-active' : ''}`} onClick={() => dispatch({ patch: { underline: !selectedText.underline }, textId: selectedText.id, type: 'UPDATE_TEXT' })} title="Underline" type="button"><span style={{ textDecoration: 'underline' }}>U</span></button>
          </div>
          <label className="field">
            <span>Case</span>
            <select
              onChange={(event) =>
                dispatch({
                  patch: { textCase: event.target.value as TextOverlay['textCase'] },
                  textId: selectedText.id,
                  type: 'UPDATE_TEXT',
                })
              }
              value={selectedText.textCase}
            >
              <option value="none">As typed</option>
              <option value="upper">UPPERCASE</option>
              <option value="lower">lowercase</option>
            </select>
          </label>
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

          <div className="subhead">Color & Fill</div>
          <label className="field field-color">
            <span>Color</span>
            <input
              onChange={(event) => dispatch({ patch: { color: event.target.value }, textId: selectedText.id, type: 'UPDATE_TEXT' })}
              type="color"
              value={selectedText.color.length === 9 ? selectedText.color.slice(0, 7) : selectedText.color}
            />
          </label>
          <label className="field field-color">
            <span>Background</span>
            <input
              onChange={(event) => {
                const hex = event.target.value;
                const alpha = selectedText.backgroundColor.length === 9 ? selectedText.backgroundColor.slice(-2) : 'ff';
                dispatch({ patch: { backgroundColor: `${hex}${alpha}` }, textId: selectedText.id, type: 'UPDATE_TEXT' });
              }}
              type="color"
              value={selectedText.backgroundColor.length >= 7 ? selectedText.backgroundColor.slice(0, 7) : '#000000'}
            />
          </label>
          <ControlNumber
            label="BG Opacity"
            max={1}
            min={0}
            step={0.05}
            value={selectedText.backgroundColor.length === 9 ? parseInt(selectedText.backgroundColor.slice(-2), 16) / 255 : 1}
            onChange={(value) => {
              const base = selectedText.backgroundColor.length >= 7 ? selectedText.backgroundColor.slice(0, 7) : '#000000';
              const alpha = Math.round(value * 255).toString(16).padStart(2, '0');
              dispatch({ patch: { backgroundColor: `${base}${alpha}` }, textId: selectedText.id, type: 'UPDATE_TEXT' });
            }}
          />
          <ControlNumber label="Opacity" max={1} min={0} step={0.05} value={selectedText.opacity} onChange={(value) => dispatch({ patch: { opacity: value }, textId: selectedText.id, type: 'UPDATE_TEXT' })} />

          <div className="subhead">Stroke</div>
          <label className="field field-color">
            <span>Color</span>
            <input
              onChange={(event) => dispatch({ patch: { strokeColor: event.target.value }, textId: selectedText.id, type: 'UPDATE_TEXT' })}
              type="color"
              value={selectedText.strokeColor.length === 9 ? selectedText.strokeColor.slice(0, 7) : selectedText.strokeColor}
            />
          </label>
          <ControlNumber label="Width" max={16} min={0} step={0.5} value={selectedText.strokeWidth} onChange={(value) => dispatch({ patch: { strokeWidth: value }, textId: selectedText.id, type: 'UPDATE_TEXT' })} />

          <div className="subhead">Shadow</div>
          <label className="field field-color">
            <span>Color</span>
            <input
              onChange={(event) => dispatch({ patch: { shadowColor: event.target.value }, textId: selectedText.id, type: 'UPDATE_TEXT' })}
              type="color"
              value={selectedText.shadowColor.length === 9 ? selectedText.shadowColor.slice(0, 7) : selectedText.shadowColor}
            />
          </label>
          <ControlNumber label="Blur" max={32} min={0} step={1} value={selectedText.shadowBlur} onChange={(value) => dispatch({ patch: { shadowBlur: value }, textId: selectedText.id, type: 'UPDATE_TEXT' })} />
          <ControlNumber label="Offset X" max={32} min={-32} step={1} value={selectedText.shadowOffsetX} onChange={(value) => dispatch({ patch: { shadowOffsetX: value }, textId: selectedText.id, type: 'UPDATE_TEXT' })} />
          <ControlNumber label="Offset Y" max={32} min={-32} step={1} value={selectedText.shadowOffsetY} onChange={(value) => dispatch({ patch: { shadowOffsetY: value }, textId: selectedText.id, type: 'UPDATE_TEXT' })} />

          <div className="subhead">Subtitle Template</div>
          <SubtitleTemplatePicker
            onApply={(id) => {
              const template = findSubtitleTemplate(id);
              // Re-apply style only — preserve text + timing + id + track.
              dispatch({
                patch: { ...template.style },
                textId: selectedText.id,
                type: 'UPDATE_TEXT',
              });
            }}
          />

          <div className="subhead">Transform</div>
          <ControlNumber label="X" max={0.98} min={0.02} step={0.01} value={selectedText.x} onChange={(value) => dispatch({ patch: { x: value }, textId: selectedText.id, type: 'UPDATE_TEXT' })} />
          <ControlNumber label="Y" max={0.98} min={0.02} step={0.01} value={selectedText.y} onChange={(value) => dispatch({ patch: { y: value }, textId: selectedText.id, type: 'UPDATE_TEXT' })} />
          <ControlNumber label="Tilt" max={180} min={-180} step={1} value={selectedText.rotation} onChange={(value) => dispatch({ patch: { rotation: value }, textId: selectedText.id, type: 'UPDATE_TEXT' })} />
          <ControlNumber label="Warp X" max={45} min={-45} step={1} value={selectedText.skewX} onChange={(value) => dispatch({ patch: { skewX: value }, textId: selectedText.id, type: 'UPDATE_TEXT' })} />
          <ControlNumber label="Warp Y" max={45} min={-45} step={1} value={selectedText.skewY} onChange={(value) => dispatch({ patch: { skewY: value }, textId: selectedText.id, type: 'UPDATE_TEXT' })} />
          <div className="button-row">
            <button className="chip" onClick={() => dispatch({ patch: { rotation: 0, skewX: 0, skewY: 0 }, textId: selectedText.id, type: 'UPDATE_TEXT' })} type="button">Reset Transform</button>
          </div>

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
          <div className="clip-summary">
            <div>
              <span>Duration</span>
              <strong>{formatClock(clipDuration)}</strong>
            </div>
            <div>
              <span>Source</span>
              <strong>{formatClock(selectedClip.sourceIn)} → {formatClock(selectedClip.sourceOut)}</strong>
            </div>
            <div>
              <span>Timeline</span>
              <strong>{formatClock(selectedClip.timelineStart)}</strong>
            </div>
          </div>

          <ScrubNumber
            label="Position"
            max={getProjectDuration(project) + 60}
            min={0}
            step={0.05}
            suffix="s"
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

          <div className="scrub-row">
            <ScrubNumber
              compact
              label="In"
              max={selectedClip.sourceOut - 0.1}
              min={0}
              step={0.05}
              suffix="s"
              value={selectedClip.sourceIn}
              onChange={(value) => dispatch({ clipId: selectedClip.id, edge: 'start', sourceTime: value, type: 'TRIM_CLIP' })}
            />
            <ScrubNumber
              compact
              label="Out"
              max={selectedClipAsset?.duration || selectedClip.sourceOut}
              min={selectedClip.sourceIn + 0.1}
              step={0.05}
              suffix="s"
              value={selectedClip.sourceOut}
              onChange={(value) => dispatch({ clipId: selectedClip.id, edge: 'end', sourceTime: value, type: 'TRIM_CLIP' })}
            />
          </div>

          {isAudioClip ? null : (
            <div className="section">
              <div className="section-head">Transform</div>
              <div className="scrub-row">
                <ScrubNumber compact label="X" max={1} min={0} step={0.01} value={selectedClip.transform.x} onChange={(value) => dispatch({ clipId: selectedClip.id, transform: { x: value }, type: 'UPDATE_CLIP_TRANSFORM' })} />
                <ScrubNumber compact label="Y" max={1} min={0} step={0.01} value={selectedClip.transform.y} onChange={(value) => dispatch({ clipId: selectedClip.id, transform: { y: value }, type: 'UPDATE_CLIP_TRANSFORM' })} />
              </div>
              <div className="scrub-row">
                <ScrubNumber compact label="Scale" max={4} min={0.25} step={0.01} value={selectedClip.transform.scale} onChange={(value) => dispatch({ clipId: selectedClip.id, transform: { scale: value }, type: 'UPDATE_CLIP_TRANSFORM' })} />
                <ScrubNumber compact label="Rotate" max={180} min={-180} step={1} suffix="°" value={selectedClip.transform.rotation ?? 0} onChange={(value) => dispatch({ clipId: selectedClip.id, transform: { rotation: value }, type: 'UPDATE_CLIP_TRANSFORM' })} />
              </div>
            </div>
          )}

          <div className="section">
            <div className="section-head section-head-row">
              <span>Audio</span>
              <label className="toggle-inline">
                <input
                  checked={selectedClip.muted}
                  onChange={(event) => dispatch({ clipId: selectedClip.id, patch: { muted: event.target.checked }, type: 'UPDATE_CLIP_AUDIO' })}
                  type="checkbox"
                />
                <span>Mute</span>
              </label>
            </div>
            <ScrubNumber label="Volume" max={2} min={0} step={0.01} value={selectedClip.volume} onChange={(value) => dispatch({ clipId: selectedClip.id, patch: { volume: value }, type: 'UPDATE_CLIP_AUDIO' })} />
            <div className="scrub-row">
              <ScrubNumber compact label="Fade In" max={clipDuration} min={0} step={0.05} suffix="s" value={selectedClip.fadeIn} onChange={(value) => dispatch({ clipId: selectedClip.id, patch: { fadeIn: value }, type: 'UPDATE_CLIP_AUDIO' })} />
              <ScrubNumber compact label="Fade Out" max={clipDuration} min={0} step={0.05} suffix="s" value={selectedClip.fadeOut} onChange={(value) => dispatch({ clipId: selectedClip.id, patch: { fadeOut: value }, type: 'UPDATE_CLIP_AUDIO' })} />
            </div>
          </div>

          {isAudioClip ? null : (
            <div className="section">
              <div className="section-head">Effects</div>
              <ScrubNumber label="Brightness" max={0.4} min={-0.4} step={0.01} value={selectedClip.effects.brightness} onChange={(value) => dispatch({ clipId: selectedClip.id, effects: { brightness: value }, type: 'UPDATE_CLIP_EFFECTS' })} />
              <ScrubNumber label="Contrast" max={1.8} min={0.5} step={0.01} value={selectedClip.effects.contrast} onChange={(value) => dispatch({ clipId: selectedClip.id, effects: { contrast: value }, type: 'UPDATE_CLIP_EFFECTS' })} />
              <ScrubNumber label="Saturation" max={2} min={0} step={0.01} value={selectedClip.effects.saturation} onChange={(value) => dispatch({ clipId: selectedClip.id, effects: { saturation: value }, type: 'UPDATE_CLIP_EFFECTS' })} />
            </div>
          )}

          <ClipTranscriptSection
            asset={selectedClipAsset}
            assetTranscripts={assetTranscripts}
            clip={selectedClip}
            error={transcribeError}
            onGenerateSubtitles={generateSubtitlesForClip}
            onTranscribe={transcribeAsset}
            transcribingFingerprints={transcribingFingerprints}
          />

          <ClipBeatsSection
            asset={selectedClipAsset}
            assetBeats={assetBeats}
            detectingFingerprints={detectingBeatsFingerprints}
            error={beatError}
            onDetect={detectAssetBeats}
          />

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

type FontPickerProps = {
  onChange: (value: TextFontFamilyId) => void;
  value: TextFontFamilyId;
};

function FontPicker({ onChange, value }: FontPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const activeFont = TEXT_FONT_FAMILIES.find((font) => font.id === value) ?? TEXT_FONT_FAMILIES[0];

  useEffect(() => {
    if (!isOpen) return;
    const onDocPointer = (event: globalThis.PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setIsOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('pointerdown', onDocPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDocPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [isOpen]);

  return (
    <label className="field font-picker">
      <span>Font</span>
      <div className="font-picker-shell">
        <button
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          className="font-picker-trigger"
          onClick={() => setIsOpen((open) => !open)}
          ref={triggerRef}
          style={{ fontFamily: activeFont.stack }}
          type="button"
        >
          {activeFont.label}
        </button>
        {isOpen ? (
          <div className="font-picker-menu" ref={menuRef} role="listbox">
            {(['sans', 'serif', 'mono', 'display', 'script', 'retro'] as const).map((category) => {
              const fonts = TEXT_FONT_FAMILIES.filter((font) => font.category === category);
              if (fonts.length === 0) return null;
              return (
                <div className="font-picker-group" key={category}>
                  <div className="font-picker-group-label">{category.charAt(0).toUpperCase() + category.slice(1)}</div>
                  {fonts.map((font) => (
                    <button
                      aria-selected={font.id === value}
                      className={`font-picker-option${font.id === value ? ' is-active' : ''}`}
                      key={font.id}
                      onClick={() => {
                        onChange(font.id);
                        setIsOpen(false);
                      }}
                      role="option"
                      style={{ fontFamily: font.stack }}
                      type="button"
                    >
                      {font.label}
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </label>
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

function stepDecimals(step: number): number {
  if (step >= 1) return 0;
  const s = step.toString();
  const dot = s.indexOf('.');
  return dot >= 0 ? Math.min(3, s.length - dot - 1) : 0;
}

function quantizeStep(value: number, step: number): number {
  if (step <= 0) return value;
  return Math.round(value / step) * step;
}

type ScrubNumberProps = {
  compact?: boolean;
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  step: number;
  suffix?: string;
  value: number;
};

function ScrubNumber({ compact, label, max, min, onChange, step, suffix, value }: ScrubNumberProps) {
  const safeValue = Number.isFinite(value) ? value : 0;
  const decimals = stepDecimals(step);
  const formatted = safeValue.toFixed(decimals);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(formatted);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editing) setText(formatted);
  }, [editing, formatted]);

  const span = Math.max(0.0001, max - min);
  const thumbPct = Math.min(100, Math.max(0, ((safeValue - min) / span) * 100));
  const bipolar = min < 0 && max > 0;
  const zeroPct = bipolar ? Math.min(100, Math.max(0, ((0 - min) / span) * 100)) : 0;
  // Notch sits at value-0 position when the range crosses zero, otherwise it
  // anchors at the visual midpoint as a sense-of-scale reference.
  const notchPct = bipolar ? zeroPct : 50;
  // Fill: bipolar anchors at zero and extends to the thumb; unipolar fills
  // from the left edge to the thumb.
  const fillLeftPct = bipolar ? Math.min(zeroPct, thumbPct) : 0;
  const fillRightPct = bipolar ? Math.max(zeroPct, thumbPct) : thumbPct;
  const fillWidthPct = Math.max(0, fillRightPct - fillLeftPct);

  const commit = useCallback(
    (raw: string) => {
      const parsed = Number.parseFloat(raw);
      if (Number.isFinite(parsed)) {
        const clamped = Math.min(Math.max(parsed, min), max);
        onChange(quantizeStep(clamped, step));
      }
      setEditing(false);
    },
    [max, min, onChange, step],
  );

  return (
    <div className={`scrub${compact ? ' is-compact' : ''}${bipolar ? ' is-bipolar' : ''}`}>
      <span className="scrub-label">{label}</span>
      <div className="scrub-control">
        <div className="scrub-track-wrap">
          <div className="scrub-track-base" />
          <div className="scrub-track-fill" style={{ left: `${fillLeftPct}%`, width: `${fillWidthPct}%` }} />
          <div className="scrub-track-notch" style={{ left: `${notchPct}%` }} />
          <input
            className="scrub-slider"
            max={max}
            min={min}
            onChange={(event) => onChange(Number(event.target.value))}
            step={step}
            type="range"
            value={safeValue}
          />
        </div>
        {editing ? (
          <input
            className="scrub-number-input"
            inputMode="decimal"
            onBlur={() => commit(text)}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); commit(text); }
              else if (event.key === 'Escape') { setText(formatted); setEditing(false); }
            }}
            ref={inputRef}
            type="text"
            value={text}
          />
        ) : (
          <button
            className="scrub-number-display"
            onClick={() => {
              setEditing(true);
              requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select(); });
            }}
            type="button"
          >
            {formatted}{suffix ? <span className="scrub-suffix">{suffix}</span> : null}
          </button>
        )}
      </div>
    </div>
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
