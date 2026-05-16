import { DEFAULT_EFFECT_SETTINGS, type EffectSettings, clampEffectSettings } from './effects';

export type JobStatus = {
  error: string | null;
  progress: number;
  state: 'idle' | 'running' | 'complete' | 'error';
};

export type AssetKind = 'audio' | 'video';

export type ProjectAsset = {
  duration: number;
  file: File;
  height: number;
  id: string;
  kind: AssetKind;
  name: string;
  originalUrl: string;
  playbackUrl: string;
  posterUrl: string | null;
  proxyStatus: JobStatus;
  proxyUrl: string | null;
  size: number;
  type: string;
  width: number;
};

export type TimelineTrack = {
  id: string;
  index: number;
  kind: 'audio' | 'text' | 'video';
  locked: boolean;
  muted: boolean;
  name: string;
  visible: boolean;
};

export type ClipTransform = {
  rotation: number;
  scale: number;
  x: number;
  y: number;
};

export type ClipMaskMode = 'blur-bg' | 'cutout' | 'spotlight';

/** A SAM2/EfficientTAM object track bound to a clip. The mask pixels live in
 *  IndexedDB `MASK_STORE` keyed by `maskKey`; the model only carries the
 *  reference + creative params. `null` on a clip means "no mask". */
export type ClipMask = {
  enabled: boolean;
  feather: number;
  invert: boolean;
  maskKey: string;
  mode: ClipMaskMode;
};

export type TimelineClip = {
  assetId: string;
  effects: EffectSettings;
  fadeIn: number;
  fadeOut: number;
  id: string;
  mask: ClipMask | null;
  muted: boolean;
  sourceIn: number;
  sourceOut: number;
  timelineStart: number;
  trackId: string;
  transform: ClipTransform;
  volume: number;
};

const CLIP_MASK_MODES: ReadonlySet<ClipMaskMode> = new Set<ClipMaskMode>([
  'blur-bg',
  'cutout',
  'spotlight',
]);

export function clampClipMask(value: unknown): ClipMask | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<ClipMask>;
  const maskKey = typeof v.maskKey === 'string' ? v.maskKey : '';
  if (!maskKey) return null;
  const mode = CLIP_MASK_MODES.has(v.mode as ClipMaskMode) ? (v.mode as ClipMaskMode) : 'spotlight';
  return {
    enabled: v.enabled !== false,
    feather: Math.min(Math.max(Number.isFinite(v.feather) ? Number(v.feather) : 0, 0), 1),
    invert: Boolean(v.invert),
    maskKey,
    mode,
  };
}

export const DEFAULT_TEXT_TRACK_ID = 'text-1';

export type TextFontFamilyId =
  | 'inter'
  | 'system-sans'
  | 'serif'
  | 'playfair'
  | 'mono'
  | 'bebas'
  | 'oswald'
  | 'anton'
  | 'lobster'
  | 'pacifico'
  | 'caveat'
  | 'dancing'
  | 'bangers'
  | 'press-start'
  | 'space-grotesk';

export const TEXT_FONT_FAMILIES: ReadonlyArray<{
  category: 'sans' | 'serif' | 'mono' | 'display' | 'script' | 'retro';
  id: TextFontFamilyId;
  label: string;
  stack: string;
}> = [
  { category: 'sans', id: 'inter', label: 'Inter', stack: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
  { category: 'sans', id: 'system-sans', label: 'System Sans', stack: '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif' },
  { category: 'sans', id: 'space-grotesk', label: 'Space Grotesk', stack: '"Space Grotesk", "Inter", sans-serif' },
  { category: 'serif', id: 'serif', label: 'Serif', stack: 'Georgia, "Times New Roman", serif' },
  { category: 'serif', id: 'playfair', label: 'Playfair Display', stack: '"Playfair Display", Georgia, serif' },
  { category: 'mono', id: 'mono', label: 'Mono', stack: '"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace' },
  { category: 'display', id: 'bebas', label: 'Bebas Neue', stack: '"Bebas Neue", Impact, "Arial Narrow", sans-serif' },
  { category: 'display', id: 'oswald', label: 'Oswald', stack: '"Oswald", "Arial Narrow", sans-serif' },
  { category: 'display', id: 'anton', label: 'Anton', stack: '"Anton", Impact, sans-serif' },
  { category: 'display', id: 'bangers', label: 'Bangers', stack: '"Bangers", Impact, sans-serif' },
  { category: 'script', id: 'lobster', label: 'Lobster', stack: '"Lobster", cursive' },
  { category: 'script', id: 'pacifico', label: 'Pacifico', stack: '"Pacifico", cursive' },
  { category: 'script', id: 'caveat', label: 'Caveat', stack: '"Caveat", cursive' },
  { category: 'script', id: 'dancing', label: 'Dancing Script', stack: '"Dancing Script", cursive' },
  { category: 'retro', id: 'press-start', label: 'Press Start 2P', stack: '"Press Start 2P", "Courier New", monospace' },
];

export type TextCase = 'none' | 'upper' | 'lower';

export type TextOverlay = {
  align: 'left' | 'center' | 'right';
  backgroundColor: string;
  bold: boolean;
  color: string;
  end: number;
  fontFamily: TextFontFamilyId;
  id: string;
  italic: boolean;
  letterSpacing: number;
  lineHeight: number;
  opacity: number;
  rotation: number;
  shadowBlur: number;
  shadowColor: string;
  shadowOffsetX: number;
  shadowOffsetY: number;
  size: number;
  skewX: number;
  skewY: number;
  start: number;
  strokeColor: string;
  strokeWidth: number;
  text: string;
  textCase: TextCase;
  trackId: string;
  underline: boolean;
  x: number;
  y: number;
};

export const DEFAULT_TEXT_OVERLAY: Omit<TextOverlay, 'end' | 'id' | 'start' | 'trackId'> = {
  align: 'center',
  backgroundColor: '#00000000',
  bold: true,
  color: '#ffffff',
  fontFamily: 'inter',
  italic: false,
  letterSpacing: 0,
  lineHeight: 1.2,
  opacity: 1,
  rotation: 0,
  shadowBlur: 6,
  shadowColor: '#000000aa',
  shadowOffsetX: 0,
  shadowOffsetY: 1,
  size: 34,
  skewX: 0,
  skewY: 0,
  strokeColor: '#000000',
  strokeWidth: 0,
  text: 'Text',
  textCase: 'none',
  underline: false,
  x: 0.5,
  y: 0.18,
};

export type ProjectPresent = {
  assets: ProjectAsset[];
  clips: TimelineClip[];
  selectedAssetId: string | null;
  selectedClipId: string | null;
  selectedTextId: string | null;
  selectedTrackId: string | null;
  textOverlays: TextOverlay[];
  tracks: TimelineTrack[];
};

export type ProjectHistory = {
  future: ProjectPresent[];
  past: ProjectPresent[];
  present: ProjectPresent;
};

export type ProjectAction =
  | { assets: ProjectAsset[]; type: 'ADD_ASSETS' }
  | { assetId: string; type: 'DELETE_ASSET' }
  | { assetId: string; metadata: Partial<Pick<ProjectAsset, 'duration' | 'height' | 'playbackUrl' | 'posterUrl' | 'proxyStatus' | 'proxyUrl' | 'width'>>; type: 'UPDATE_ASSET' }
  | { assetId: string | null; type: 'SELECT_ASSET' }
  | { assetId: string; clipId: string; timelineStart?: number; trackId?: string; type: 'ADD_ASSET_TO_TIMELINE' }
  | { track: TimelineTrack; type: 'ADD_TRACK' }
  | { patch: Partial<Pick<TimelineTrack, 'locked' | 'muted' | 'name' | 'visible'>>; trackId: string; type: 'UPDATE_TRACK' }
  | { trackId: string; type: 'DELETE_TRACK' }
  | { trackId: string | null; type: 'SELECT_TRACK' }
  | { clipId: string | null; type: 'SELECT_CLIP' }
  | { clipId?: string; playhead: number; newClipId: string; type: 'SPLIT_CLIP' }
  | { playhead: number; newTextId: string; textId?: string; type: 'SPLIT_TEXT' }
  | { clipId: string; edge: 'start' | 'end'; sourceTime: number; type: 'TRIM_CLIP' }
  | { clipId: string; record?: boolean; timelineStart?: number; trackId?: string; type: 'MOVE_CLIP' }
  | { type: 'DELETE_SELECTED' }
  | { clipId: string; patch: Partial<Pick<TimelineClip, 'fadeIn' | 'fadeOut' | 'muted' | 'volume'>>; type: 'UPDATE_CLIP_AUDIO' }
  | { clipId: string; effects: Partial<EffectSettings>; type: 'UPDATE_CLIP_EFFECTS' }
  | { clipId: string; record?: boolean; transform: Partial<ClipTransform>; type: 'UPDATE_CLIP_TRANSFORM' }
  | { clipId: string; mask: ClipMask | null; type: 'UPDATE_CLIP_MASK' }
  | { overlay: TextOverlay; type: 'ADD_TEXT' }
  | { overlays: TextOverlay[]; rangeEnd: number; rangeStart: number; trackId: string; type: 'REPLACE_TEXTS_IN_RANGE' }
  | { delta: number; textIds: string[]; type: 'SHIFT_TEXTS_BY' }
  | { textId: string | null; type: 'SELECT_TEXT' }
  | { patch: Partial<TextOverlay>; record?: boolean; textId: string; type: 'UPDATE_TEXT' }
  | { textId: string; type: 'DELETE_TEXT' }
  | { nextProject: ProjectPresent; type: 'APPLY_EAL' }
  | { type: 'UNDO' }
  | { type: 'REDO' };

const MIN_CLIP_DURATION = 0.1;
const MAX_HISTORY = 60;
const DEFAULT_VIDEO_TRACK_ID = 'video-1';

export const DEFAULT_CLIP_TRANSFORM: ClipTransform = {
  rotation: 0,
  scale: 1,
  x: 0.5,
  y: 0.5,
};

export const idleJobStatus: JobStatus = {
  error: null,
  progress: 0,
  state: 'idle',
};

export function createDefaultTracks(): TimelineTrack[] {
  return [
    {
      id: DEFAULT_VIDEO_TRACK_ID,
      index: 0,
      kind: 'video',
      locked: false,
      muted: false,
      name: 'Video 1',
      visible: true,
    },
  ];
}

export function createInitialProject(): ProjectHistory {
  const tracks = createDefaultTracks();

  return {
    future: [],
    past: [],
    present: {
      assets: [],
      clips: [],
      selectedAssetId: null,
      selectedClipId: null,
      selectedTextId: null,
      selectedTrackId: tracks[0]?.id ?? null,
      textOverlays: [],
      tracks,
    },
  };
}

export function getDefaultVideoTrackId(project: Pick<ProjectPresent, 'tracks'>) {
  return (
    [...project.tracks]
      .filter((track) => track.kind === 'video')
      .sort((a, b) => a.index - b.index)[0]?.id ?? DEFAULT_VIDEO_TRACK_ID
  );
}

export function getVideoTracksTopFirst(project: Pick<ProjectPresent, 'tracks'>): TimelineTrack[] {
  return [...project.tracks]
    .filter((track) => track.kind === 'video')
    .sort((a, b) => b.index - a.index);
}

export function getAudioTracksTopFirst(project: Pick<ProjectPresent, 'tracks'>): TimelineTrack[] {
  return [...project.tracks]
    .filter((track) => track.kind === 'audio')
    .sort((a, b) => b.index - a.index);
}

export function getDefaultAudioTrackId(project: Pick<ProjectPresent, 'tracks'>) {
  return (
    [...project.tracks]
      .filter((track) => track.kind === 'audio')
      .sort((a, b) => a.index - b.index)[0]?.id ?? null
  );
}

export function getNextTrackIndex(project: Pick<ProjectPresent, 'tracks'>, kind: TimelineTrack['kind']) {
  const sameKindTracks = project.tracks.filter((track) => track.kind === kind);

  return sameKindTracks.length === 0 ? 0 : Math.max(...sameKindTracks.map((track) => track.index)) + 1;
}

export function createTimelineClip(
  id: string,
  assetId: string,
  assetDuration: number,
  timelineStart = 0,
  trackId = DEFAULT_VIDEO_TRACK_ID,
): TimelineClip {
  return {
    assetId,
    effects: { ...DEFAULT_EFFECT_SETTINGS },
    fadeIn: 0,
    fadeOut: 0,
    id,
    mask: null,
    muted: false,
    sourceIn: 0,
    sourceOut: Math.max(MIN_CLIP_DURATION, assetDuration || MIN_CLIP_DURATION),
    timelineStart: Math.max(0, timelineStart),
    trackId,
    transform: { ...DEFAULT_CLIP_TRANSFORM },
    volume: 1,
  };
}

export function clampClipTransform(transform: Partial<ClipTransform> | undefined): ClipTransform {
  return {
    rotation: Math.min(Math.max(transform?.rotation ?? DEFAULT_CLIP_TRANSFORM.rotation, -180), 180),
    scale: Math.min(Math.max(transform?.scale ?? DEFAULT_CLIP_TRANSFORM.scale, 0.25), 4),
    x: Math.min(Math.max(transform?.x ?? DEFAULT_CLIP_TRANSFORM.x, 0), 1),
    y: Math.min(Math.max(transform?.y ?? DEFAULT_CLIP_TRANSFORM.y, 0), 1),
  };
}

export function normalizeTimelineTrack(track: Partial<TimelineTrack> | undefined, fallbackIndex = 0): TimelineTrack {
  const kind: TimelineTrack['kind'] =
    track?.kind === 'audio' ? 'audio' : track?.kind === 'text' ? 'text' : 'video';
  const index = Number.isFinite(track?.index) ? Math.max(0, Number(track?.index)) : fallbackIndex;

  return {
    id: track?.id?.trim() || `${kind}-${index + 1}`,
    index,
    kind,
    locked: Boolean(track?.locked),
    muted: Boolean(track?.muted),
    name:
      track?.name?.trim() ||
      `${kind === 'video' ? 'Video' : kind === 'audio' ? 'Audio' : 'Text'} ${index + 1}`,
    visible: track?.visible ?? true,
  };
}

export function normalizeTimelineTracks(tracks: Partial<TimelineTrack>[] | undefined): TimelineTrack[] {
  const normalized = (tracks ?? []).map((track, index) => normalizeTimelineTrack(track, index));
  const deduped: TimelineTrack[] = [];
  const usedIds = new Set<string>();

  normalized.forEach((track) => {
    let id = track.id;
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `${track.id}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(id);
    deduped.push({ ...track, id });
  });

  if (!deduped.some((track) => track.kind === 'video')) {
    deduped.push(createDefaultTracks()[0]);
  }

  const kindOrder: Record<TimelineTrack['kind'], number> = { video: 0, audio: 1, text: 2 };

  return deduped.sort((a, b) => {
    if (a.kind !== b.kind) {
      return kindOrder[a.kind] - kindOrder[b.kind];
    }

    return a.index - b.index;
  });
}

export function normalizeTimelineClip(
  clip: Partial<TimelineClip>,
  fallbackTimelineStart = 0,
  fallbackTrackId = DEFAULT_VIDEO_TRACK_ID,
): TimelineClip {
  const sourceIn = Math.max(0, Number.isFinite(clip.sourceIn) ? Number(clip.sourceIn) : 0);
  const sourceOut = Math.max(sourceIn + MIN_CLIP_DURATION, Number.isFinite(clip.sourceOut) ? Number(clip.sourceOut) : sourceIn + MIN_CLIP_DURATION);

  return {
    assetId: clip.assetId ?? '',
    effects: clampEffectSettings({
      ...DEFAULT_EFFECT_SETTINGS,
      ...clip.effects,
    }),
    fadeIn: Math.max(0, Number.isFinite(clip.fadeIn) ? Number(clip.fadeIn) : 0),
    fadeOut: Math.max(0, Number.isFinite(clip.fadeOut) ? Number(clip.fadeOut) : 0),
    id: clip.id ?? createNormalizedClipId(),
    mask: clampClipMask(clip.mask),
    muted: Boolean(clip.muted),
    sourceIn,
    sourceOut,
    timelineStart: Math.max(0, Number.isFinite(clip.timelineStart) ? Number(clip.timelineStart) : fallbackTimelineStart),
    trackId: clip.trackId || fallbackTrackId,
    transform: clampClipTransform(clip.transform),
    volume: Math.min(Math.max(Number.isFinite(clip.volume) ? Number(clip.volume) : 1, 0), 2),
  };
}

export function normalizeTimelineClips(
  clips: Partial<TimelineClip>[] | undefined,
  tracks: TimelineTrack[],
): TimelineClip[] {
  const fallbackTrackId = tracks.find((track) => track.kind === 'video')?.id ?? DEFAULT_VIDEO_TRACK_ID;
  let cursor = 0;

  return (clips ?? [])
    .map((clip) => {
      const hadExplicitStart = Number.isFinite(clip.timelineStart);
      const normalized = normalizeTimelineClip(clip, cursor, clip.trackId || fallbackTrackId);

      if (!hadExplicitStart) {
        cursor += getClipDuration(normalized);
      }

      return normalized;
    })
    .filter((clip) => clip.assetId)
    .sort((a, b) => a.timelineStart - b.timelineStart || a.trackId.localeCompare(b.trackId));
}

export function getClipDuration(clip: TimelineClip) {
  return Math.max(MIN_CLIP_DURATION, clip.sourceOut - clip.sourceIn);
}

export function getClipEnd(clip: TimelineClip) {
  return clip.timelineStart + getClipDuration(clip);
}

export function getProjectDuration(project: ProjectPresent) {
  const clipEnd = project.clips.reduce((max, clip) => Math.max(max, getClipEnd(clip)), 0);
  const textEnd = project.textOverlays.reduce((max, overlay) => Math.max(max, overlay.end), 0);

  return Math.max(clipEnd, textEnd);
}

export function getTrackById(project: ProjectPresent, trackId: string | null) {
  return trackId ? project.tracks.find((track) => track.id === trackId) ?? null : null;
}

export function getClipStart(project: ProjectPresent, clipId: string) {
  return project.clips.find((clip) => clip.id === clipId)?.timelineStart ?? null;
}

export type TimelineIndex = {
  audibleTrackIds: Set<string>;
  clipsByTrack: Map<string, TimelineClip[]>;
  textOverlaysByTrack: Map<string, TextOverlay[]>;
  trackById: Map<string, TimelineTrack>;
  trackIndexById: Map<string, number>;
  visibleTextTrackIds: Set<string>;
};

export function buildTimelineIndex(project: Pick<ProjectPresent, 'clips' | 'textOverlays' | 'tracks'>): TimelineIndex {
  const trackIndexById = new Map<string, number>();
  const trackById = new Map<string, TimelineTrack>();
  const audibleTrackIds = new Set<string>();
  const visibleTextTrackIds = new Set<string>();

  for (const track of project.tracks) {
    trackIndexById.set(track.id, track.index);
    trackById.set(track.id, track);
    if (track.kind === 'video' ? track.visible : !track.muted) {
      audibleTrackIds.add(track.id);
    }
    if (track.kind === 'text' && track.visible) {
      visibleTextTrackIds.add(track.id);
    }
  }

  const clipsByTrack = new Map<string, TimelineClip[]>();
  for (const clip of project.clips) {
    let bucket = clipsByTrack.get(clip.trackId);
    if (!bucket) {
      bucket = [];
      clipsByTrack.set(clip.trackId, bucket);
    }
    bucket.push(clip);
  }
  for (const bucket of clipsByTrack.values()) {
    bucket.sort((a, b) => a.timelineStart - b.timelineStart);
  }

  const textOverlaysByTrack = new Map<string, TextOverlay[]>();
  for (const overlay of project.textOverlays) {
    let bucket = textOverlaysByTrack.get(overlay.trackId);
    if (!bucket) {
      bucket = [];
      textOverlaysByTrack.set(overlay.trackId, bucket);
    }
    bucket.push(overlay);
  }
  for (const bucket of textOverlaysByTrack.values()) {
    bucket.sort((a, b) => a.start - b.start);
  }

  return { audibleTrackIds, clipsByTrack, textOverlaysByTrack, trackById, trackIndexById, visibleTextTrackIds };
}

// Binary search for the clip whose [start, end) contains `time`. The list
// must already be sorted by `timelineStart`. Clips on the same track cannot
// overlap (normalizeTimelineClips enforces this) so at most one match.
function binarySearchClipAt(list: TimelineClip[], time: number): TimelineClip | null {
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const clip = list[mid];
    if (time < clip.timelineStart) {
      hi = mid - 1;
    } else if (time >= clip.timelineStart + getClipDuration(clip)) {
      lo = mid + 1;
    } else {
      return clip;
    }
  }
  return null;
}

export function getClipsAtTimeFromIndex(index: TimelineIndex, tracks: TimelineTrack[], time: number) {
  const clampedTime = Math.max(time, 0);
  const result: Array<{
    clip: TimelineClip;
    clipEnd: number;
    clipStart: number;
    localTime: number;
    track: TimelineTrack | null;
  }> = [];

  // Iterating in `tracks` order then sorting by trackIndex preserves the
  // existing ordering contract (lower trackIndex first in result).
  for (const track of tracks) {
    if (!index.audibleTrackIds.has(track.id)) continue;
    const bucket = index.clipsByTrack.get(track.id);
    if (!bucket || bucket.length === 0) continue;
    const clip = binarySearchClipAt(bucket, clampedTime);
    if (!clip) continue;
    const duration = getClipDuration(clip);
    result.push({
      clip,
      clipEnd: clip.timelineStart + duration,
      clipStart: clip.timelineStart,
      localTime: Math.min(duration, Math.max(0, clampedTime - clip.timelineStart)),
      track,
    });
  }
  result.sort((a, b) => (index.trackIndexById.get(a.track?.id ?? '') ?? 0) - (index.trackIndexById.get(b.track?.id ?? '') ?? 0));
  return result;
}

export function getClipsAtTime(project: ProjectPresent, time: number) {
  return getClipsAtTimeFromIndex(buildTimelineIndex(project), project.tracks, time);
}

export function getVideoClipsAtTime(project: ProjectPresent, time: number) {
  return getClipsAtTime(project, time).filter((entry) => entry.track?.kind === 'video');
}

export function getAudioClipsAtTime(project: ProjectPresent, time: number) {
  return getClipsAtTime(project, time).filter((entry) => entry.track?.kind === 'audio');
}

export function getVideoClipsAtTimeFromIndex(index: TimelineIndex, tracks: TimelineTrack[], time: number) {
  return getClipsAtTimeFromIndex(index, tracks, time).filter((entry) => entry.track?.kind === 'video');
}

export function getAudioClipsAtTimeFromIndex(index: TimelineIndex, tracks: TimelineTrack[], time: number) {
  return getClipsAtTimeFromIndex(index, tracks, time).filter((entry) => entry.track?.kind === 'audio');
}

/** Half-open membership: a cue is active when playhead ∈ [start, end). Two
 *  adjacent cues sharing a boundary (e.g. one ends at 4.2, the next starts at
 *  4.2) therefore never both render at the same frame. The single exception is
 *  the very end of the timeline — if the playhead has reached `timelineEnd`,
 *  a cue ending exactly there still renders so the last subtitle doesn't blink
 *  out the moment the user scrubs all the way right. */
export function isTextOverlayActiveAt(overlay: TextOverlay, playhead: number, timelineEnd?: number): boolean {
  if (playhead < overlay.start) return false;
  if (playhead < overlay.end) return true;
  if (timelineEnd !== undefined && playhead >= timelineEnd && overlay.end >= timelineEnd) return true;
  return false;
}

export function getActiveTextOverlaysFromIndex(index: TimelineIndex, textOverlays: TextOverlay[], playhead: number, timelineEnd?: number): TextOverlay[] {
  if (textOverlays.length === 0) return [];
  // Text overlays can overlap and aren't guaranteed disjoint; binary search
  // only gives O(log n) when there's no overlap. With small N (text overlay
  // count is typically <100), linear scan over the per-track bucket is fine.
  const result: TextOverlay[] = [];
  for (const trackId of index.visibleTextTrackIds) {
    const bucket = index.textOverlaysByTrack.get(trackId);
    if (!bucket) continue;
    for (const overlay of bucket) {
      if (overlay.start > playhead) break;
      if (isTextOverlayActiveAt(overlay, playhead, timelineEnd)) result.push(overlay);
    }
  }
  // Legacy overlays without a trackId still need to render until explicitly hidden.
  for (const overlay of textOverlays) {
    if (overlay.trackId) continue;
    if (isTextOverlayActiveAt(overlay, playhead, timelineEnd)) result.push(overlay);
  }
  return result;
}

export function getClipAtTime(project: ProjectPresent, time: number) {
  const clips = getVideoClipsAtTime(project, time);

  if (clips.length > 0) {
    return clips[clips.length - 1];
  }

  const audio = getAudioClipsAtTime(project, time);
  return audio[audio.length - 1] ?? null;
}

export function getAssetById(project: ProjectPresent, assetId: string | null) {
  return assetId ? project.assets.find((asset) => asset.id === assetId) ?? null : null;
}

export function getSelectedClip(project: ProjectPresent) {
  return project.selectedClipId ? project.clips.find((clip) => clip.id === project.selectedClipId) ?? null : null;
}

export function getSelectedText(project: ProjectPresent) {
  return project.selectedTextId
    ? project.textOverlays.find((overlay) => overlay.id === project.selectedTextId) ?? null
    : null;
}

export function getActiveTextOverlays(project: ProjectPresent, playhead: number, timelineEnd?: number) {
  const visibleTextTrackIds = new Set(
    project.tracks.filter((track) => track.kind === 'text' && track.visible).map((track) => track.id),
  );

  return project.textOverlays.filter((overlay) => {
    if (!visibleTextTrackIds.has(overlay.trackId)) {
      // Legacy overlays without a real text track still need to render until
      // the user explicitly hides them.
      if (overlay.trackId) {
        return false;
      }
    }
    return isTextOverlayActiveAt(overlay, playhead, timelineEnd);
  });
}

function clampSourceTime(asset: ProjectAsset | null, value: number) {
  return Math.min(Math.max(value, 0), Math.max(asset?.duration ?? value, MIN_CLIP_DURATION));
}

const SUPPORTED_FONT_FAMILY_IDS = new Set<TextFontFamilyId>(TEXT_FONT_FAMILIES.map((font) => font.id));

function normalizeFontFamily(value: unknown): TextFontFamilyId {
  return typeof value === 'string' && SUPPORTED_FONT_FAMILY_IDS.has(value as TextFontFamilyId)
    ? (value as TextFontFamilyId)
    : DEFAULT_TEXT_OVERLAY.fontFamily;
}

function normalizeTextCase(value: unknown): TextCase {
  return value === 'upper' || value === 'lower' ? value : 'none';
}

function normalizeColor(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed) || /^#[0-9a-fA-F]{6}$/.test(trimmed) || /^#[0-9a-fA-F]{8}$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return fallback;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(Math.max(numeric, min), max);
}

export function clampTextOverlay(overlay: TextOverlay, projectDuration: number, fallbackTrackId = DEFAULT_TEXT_TRACK_ID): TextOverlay {
  const start = Math.min(Math.max(overlay.start, 0), Math.max(0, projectDuration - MIN_CLIP_DURATION));
  const end = Math.min(Math.max(overlay.end, start + MIN_CLIP_DURATION), Math.max(projectDuration, start + MIN_CLIP_DURATION));

  return {
    ...DEFAULT_TEXT_OVERLAY,
    ...overlay,
    backgroundColor: normalizeColor(overlay.backgroundColor, DEFAULT_TEXT_OVERLAY.backgroundColor),
    bold: Boolean(overlay.bold ?? DEFAULT_TEXT_OVERLAY.bold),
    color: normalizeColor(overlay.color, DEFAULT_TEXT_OVERLAY.color),
    end,
    fontFamily: normalizeFontFamily(overlay.fontFamily),
    italic: Boolean(overlay.italic ?? DEFAULT_TEXT_OVERLAY.italic),
    letterSpacing: clampNumber(overlay.letterSpacing, -8, 32, DEFAULT_TEXT_OVERLAY.letterSpacing),
    lineHeight: clampNumber(overlay.lineHeight, 0.8, 3, DEFAULT_TEXT_OVERLAY.lineHeight),
    opacity: clampNumber(overlay.opacity, 0, 1, DEFAULT_TEXT_OVERLAY.opacity),
    rotation: clampNumber(overlay.rotation, -180, 180, DEFAULT_TEXT_OVERLAY.rotation),
    shadowBlur: clampNumber(overlay.shadowBlur, 0, 32, DEFAULT_TEXT_OVERLAY.shadowBlur),
    shadowColor: normalizeColor(overlay.shadowColor, DEFAULT_TEXT_OVERLAY.shadowColor),
    shadowOffsetX: clampNumber(overlay.shadowOffsetX, -32, 32, DEFAULT_TEXT_OVERLAY.shadowOffsetX),
    shadowOffsetY: clampNumber(overlay.shadowOffsetY, -32, 32, DEFAULT_TEXT_OVERLAY.shadowOffsetY),
    size: clampNumber(overlay.size, 8, 240, DEFAULT_TEXT_OVERLAY.size),
    skewX: clampNumber(overlay.skewX, -45, 45, DEFAULT_TEXT_OVERLAY.skewX),
    skewY: clampNumber(overlay.skewY, -45, 45, DEFAULT_TEXT_OVERLAY.skewY),
    start,
    strokeColor: normalizeColor(overlay.strokeColor, DEFAULT_TEXT_OVERLAY.strokeColor),
    strokeWidth: clampNumber(overlay.strokeWidth, 0, 16, DEFAULT_TEXT_OVERLAY.strokeWidth),
    text: typeof overlay.text === 'string' ? overlay.text.slice(0, 700) : DEFAULT_TEXT_OVERLAY.text,
    textCase: normalizeTextCase(overlay.textCase),
    trackId: overlay.trackId || fallbackTrackId,
    underline: Boolean(overlay.underline ?? DEFAULT_TEXT_OVERLAY.underline),
    x: clampNumber(overlay.x, 0.02, 0.98, DEFAULT_TEXT_OVERLAY.x),
    y: clampNumber(overlay.y, 0.02, 0.98, DEFAULT_TEXT_OVERLAY.y),
  };
}

function updateClip(project: ProjectPresent, clipId: string, updater: (clip: TimelineClip) => TimelineClip) {
  return {
    ...project,
    clips: project.clips.map((clip) => (clip.id === clipId ? updater(clip) : clip)),
  };
}

function getTrackEnd(project: ProjectPresent, trackId: string) {
  return project.clips
    .filter((clip) => clip.trackId === trackId)
    .reduce((max, clip) => Math.max(max, getClipEnd(clip)), 0);
}

export type SnapTargetOptions = {
  excludeClipId?: string | null;
  excludeTextId?: string | null;
  includePlayhead?: number | null;
  /** Extra timeline-time positions to include — used to inject beat-grid
   *  targets so drag/trim snaps to musical beats just like to clip edges. */
  extraTargets?: readonly number[];
};

export function collectSnapTargets(
  project: Pick<ProjectPresent, 'clips' | 'textOverlays' | 'tracks'>,
  options: SnapTargetOptions = {},
): number[] {
  const targets = new Set<number>();
  targets.add(0);

  for (const clip of project.clips) {
    if (clip.id === options.excludeClipId) {
      continue;
    }
    targets.add(round(clip.timelineStart));
    targets.add(round(getClipEnd(clip)));
  }

  for (const overlay of project.textOverlays) {
    if (overlay.id === options.excludeTextId) {
      continue;
    }
    targets.add(round(overlay.start));
    targets.add(round(overlay.end));
  }

  if (options.extraTargets) {
    for (const value of options.extraTargets) {
      if (Number.isFinite(value) && value >= 0) {
        targets.add(round(value));
      }
    }
  }

  if (typeof options.includePlayhead === 'number' && Number.isFinite(options.includePlayhead)) {
    targets.add(round(options.includePlayhead));
  }

  return [...targets].sort((a, b) => a - b);
}

export type SnapResult = {
  target: number | null;
  value: number;
};

export function snapToTarget(desired: number, targets: number[], toleranceSeconds: number): SnapResult {
  let best: number | null = null;
  let bestDistance = toleranceSeconds;

  for (const target of targets) {
    const distance = Math.abs(target - desired);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = target;
    }
  }

  return best === null ? { target: null, value: desired } : { target: best, value: best };
}

function round(value: number) {
  return Math.round(value * 10000) / 10000;
}

export function findFreeTimelineStart(
  project: Pick<ProjectPresent, 'clips'>,
  trackId: string,
  desiredStart: number,
  duration: number,
  excludeClipId: string | null = null,
): number {
  const sorted = project.clips
    .filter((clip) => clip.trackId === trackId && clip.id !== excludeClipId)
    .sort((a, b) => a.timelineStart - b.timelineStart);

  let start = Math.max(0, desiredStart);
  const minDuration = Math.max(duration, MIN_CLIP_DURATION);

  for (const clip of sorted) {
    const clipStart = clip.timelineStart;
    const clipEnd = getClipEnd(clip);

    if (start + minDuration > clipStart + 0.001 && start + 0.001 < clipEnd) {
      // Would overlap this clip. Snap to immediately after it.
      start = clipEnd;
    }
  }

  return start;
}

export function findFreeTextOverlayStart(
  textOverlays: TextOverlay[],
  trackId: string,
  desiredStart: number,
  duration: number,
  excludeTextId: string | null = null,
): number {
  const sorted = textOverlays
    .filter((overlay) => overlay.trackId === trackId && overlay.id !== excludeTextId)
    .sort((a, b) => a.start - b.start);

  let start = Math.max(0, desiredStart);
  const minDuration = Math.max(duration, MIN_CLIP_DURATION);

  for (const overlay of sorted) {
    if (start + minDuration > overlay.start + 0.001 && start + 0.001 < overlay.end) {
      // Would overlap this overlay. Snap to immediately after it.
      start = overlay.end;
    }
  }

  return start;
}

function rippleTrack(project: ProjectPresent, trackId: string, afterTime: number, delta: number, exceptClipIds = new Set<string>()) {
  if (Math.abs(delta) < 0.001) {
    return project.clips;
  }

  return project.clips.map((clip) =>
    clip.trackId === trackId && !exceptClipIds.has(clip.id) && clip.timelineStart >= afterTime - 0.001
      ? {
          ...clip,
          timelineStart: Math.max(0, clip.timelineStart + delta),
        }
      : clip,
  );
}

function removeClipsWithRipple(project: ProjectPresent, clipIds: Set<string>) {
  const removedByTrack = new Map<string, TimelineClip[]>();

  project.clips.forEach((clip) => {
    if (!clipIds.has(clip.id)) {
      return;
    }

    const list = removedByTrack.get(clip.trackId) ?? [];
    list.push(clip);
    removedByTrack.set(clip.trackId, list);
  });

  let clips = project.clips.filter((clip) => !clipIds.has(clip.id));

  removedByTrack.forEach((removed, trackId) => {
    removed.sort((a, b) => a.timelineStart - b.timelineStart);
    let cumulativeDelta = 0;

    for (const removedClip of removed) {
      const duration = getClipDuration(removedClip);
      const cutoff = getClipEnd(removedClip) - cumulativeDelta;

      clips = clips.map((clip) =>
        clip.trackId === trackId && clip.timelineStart >= cutoff - 0.001
          ? {
              ...clip,
              timelineStart: Math.max(0, clip.timelineStart - duration),
            }
          : clip,
      );

      cumulativeDelta += duration;
    }
  });

  return clips;
}

export function getFirstClipByTimelineOrder(project: ProjectPresent): TimelineClip | null {
  if (project.clips.length === 0) {
    return null;
  }

  const trackIndexById = new Map(project.tracks.map((track) => [track.id, track.index]));

  return (
    [...project.clips].sort(
      (a, b) =>
        a.timelineStart - b.timelineStart ||
        (trackIndexById.get(a.trackId) ?? 0) - (trackIndexById.get(b.trackId) ?? 0) ||
        a.id.localeCompare(b.id),
    )[0] ?? null
  );
}

export function getNextClipAfter(project: ProjectPresent, time: number): TimelineClip | null {
  const audibleTrackIndexById = new Map(
    project.tracks
      .filter((track) => (track.kind === 'video' ? track.visible : !track.muted))
      .map((track) => [track.id, track.index]),
  );

  const candidates = project.clips.filter(
    (clip) => audibleTrackIndexById.has(clip.trackId) && clip.timelineStart > time + 0.01,
  );

  if (candidates.length === 0) {
    return null;
  }

  return candidates.sort(
    (a, b) =>
      a.timelineStart - b.timelineStart ||
      (audibleTrackIndexById.get(a.trackId) ?? 0) - (audibleTrackIndexById.get(b.trackId) ?? 0) ||
      a.id.localeCompare(b.id),
  )[0];
}

function createNormalizedClipId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `clip-${crypto.randomUUID()}`;
  }

  return `clip-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sortClipsForRuntime(clips: TimelineClip[], tracks: TimelineTrack[]) {
  const trackIndexById = new Map(tracks.map((track) => [track.id, track.index]));

  return [...clips].sort((a, b) => {
    const trackDelta = (trackIndexById.get(a.trackId) ?? 0) - (trackIndexById.get(b.trackId) ?? 0);

    return trackDelta || a.timelineStart - b.timelineStart || a.id.localeCompare(b.id);
  });
}

function reducePresent(project: ProjectPresent, action: ProjectAction): ProjectPresent {
  switch (action.type) {
    case 'ADD_ASSETS': {
      if (action.assets.length === 0) {
        return project;
      }

      return {
        ...project,
        assets: [...project.assets, ...action.assets],
        selectedAssetId: action.assets[action.assets.length - 1]?.id ?? project.selectedAssetId,
      };
    }

    case 'DELETE_ASSET': {
      const dependentClipIds = new Set(project.clips.filter((clip) => clip.assetId === action.assetId).map((clip) => clip.id));
      const clips = removeClipsWithRipple(project, dependentClipIds);
      const assets = project.assets.filter((asset) => asset.id !== action.assetId);
      const selectedClipStillExists = clips.some((clip) => clip.id === project.selectedClipId);
      const nextProject = {
        ...project,
        assets,
        clips,
        selectedAssetId:
          project.selectedAssetId === action.assetId ? assets[assets.length - 1]?.id ?? null : project.selectedAssetId,
        selectedClipId: selectedClipStillExists ? project.selectedClipId : null,
      };
      const nextDuration = getProjectDuration(nextProject);

      return {
        ...nextProject,
        selectedTextId: nextDuration > 0 ? nextProject.selectedTextId : null,
        textOverlays:
          nextDuration > 0
            ? nextProject.textOverlays.map((overlay) => clampTextOverlay(overlay, nextDuration))
            : [],
      };
    }

    case 'UPDATE_ASSET':
      return {
        ...project,
        assets: project.assets.map((asset) => (asset.id === action.assetId ? { ...asset, ...action.metadata } : asset)),
      };

    case 'SELECT_ASSET':
      return {
        ...project,
        selectedAssetId: action.assetId,
      };

    case 'ADD_ASSET_TO_TIMELINE': {
      const asset = getAssetById(project, action.assetId);

      if (!asset) {
        return project;
      }

      const trackId = action.trackId ?? project.selectedTrackId ?? getDefaultVideoTrackId(project);
      const desiredStart = action.timelineStart ?? getTrackEnd(project, trackId);
      const clipDuration = Math.max(MIN_CLIP_DURATION, asset.duration || MIN_CLIP_DURATION);
      const timelineStart = findFreeTimelineStart(project, trackId, desiredStart, clipDuration);
      const clip = createTimelineClip(action.clipId, action.assetId, asset.duration, timelineStart, trackId);

      return {
        ...project,
        clips: sortClipsForRuntime([...project.clips, clip], project.tracks),
        selectedAssetId: action.assetId,
        selectedClipId: clip.id,
        selectedTextId: null,
        selectedTrackId: trackId,
      };
    }

    case 'ADD_TRACK': {
      const track = normalizeTimelineTrack(action.track, getNextTrackIndex(project, action.track.kind));

      if (project.tracks.some((candidate) => candidate.id === track.id)) {
        return project;
      }

      return {
        ...project,
        selectedTrackId: track.id,
        tracks: normalizeTimelineTracks([...project.tracks, track]),
      };
    }

    case 'UPDATE_TRACK':
      return {
        ...project,
        tracks: normalizeTimelineTracks(
          project.tracks.map((track) => (track.id === action.trackId ? { ...track, ...action.patch } : track)),
        ),
      };

    case 'DELETE_TRACK': {
      const target = project.tracks.find((track) => track.id === action.trackId);

      if (!target) {
        return project;
      }

      const remainingVideoTracks = project.tracks.filter(
        (track) => track.kind === 'video' && track.id !== action.trackId,
      );

      if (target.kind === 'video' && remainingVideoTracks.length === 0) {
        return project;
      }

      const dependentClipIds = new Set(
        project.clips.filter((clip) => clip.trackId === action.trackId).map((clip) => clip.id),
      );
      const tracks = project.tracks.filter((track) => track.id !== action.trackId);
      const clips = removeClipsWithRipple(project, dependentClipIds);
      const textOverlays = project.textOverlays.filter((overlay) => overlay.trackId !== action.trackId);
      const selectedClipStillExists = clips.some((clip) => clip.id === project.selectedClipId);
      const selectedTextStillExists = textOverlays.some((overlay) => overlay.id === project.selectedTextId);
      const nextSelectedTrackId =
        project.selectedTrackId === action.trackId
          ? remainingVideoTracks[0]?.id ?? tracks.find((track) => track.kind === 'audio')?.id ?? tracks.find((track) => track.kind === 'text')?.id ?? null
          : project.selectedTrackId;

      return {
        ...project,
        clips: sortClipsForRuntime(clips, tracks),
        selectedClipId: selectedClipStillExists ? project.selectedClipId : null,
        selectedTextId: selectedTextStillExists ? project.selectedTextId : null,
        selectedTrackId: nextSelectedTrackId,
        textOverlays,
        tracks,
      };
    }

    case 'SELECT_TRACK':
      return {
        ...project,
        selectedClipId: null,
        selectedTextId: null,
        selectedTrackId: action.trackId,
      };

    case 'SELECT_CLIP': {
      const clip = action.clipId ? project.clips.find((candidate) => candidate.id === action.clipId) ?? null : null;

      return {
        ...project,
        selectedClipId: action.clipId,
        selectedTextId: null,
        selectedTrackId: clip?.trackId ?? project.selectedTrackId,
      };
    }

    case 'SPLIT_CLIP': {
      let active: { clip: TimelineClip; clipEnd: number; clipStart: number; localTime: number } | null;

      if (action.clipId) {
        const target = project.clips.find((clip) => clip.id === action.clipId) ?? null;

        if (!target) {
          return project;
        }

        const targetDuration = getClipDuration(target);
        const localTime = action.playhead - target.timelineStart;

        if (localTime <= 0 || localTime >= targetDuration) {
          return project;
        }

        active = {
          clip: target,
          clipEnd: target.timelineStart + targetDuration,
          clipStart: target.timelineStart,
          localTime,
        };
      } else {
        active = getClipAtTime(project, action.playhead);
      }

      if (!active) {
        return project;
      }

      const localSourceTime = active.clip.sourceIn + active.localTime;

      if (
        localSourceTime <= active.clip.sourceIn + MIN_CLIP_DURATION ||
        localSourceTime >= active.clip.sourceOut - MIN_CLIP_DURATION
      ) {
        return project;
      }

      const left: TimelineClip = {
        ...active.clip,
        sourceOut: localSourceTime,
      };
      const right: TimelineClip = {
        ...active.clip,
        id: action.newClipId,
        sourceIn: localSourceTime,
        timelineStart: action.playhead,
      };

      return {
        ...project,
        clips: sortClipsForRuntime(project.clips.flatMap((clip) => (clip.id === active.clip.id ? [left, right] : [clip])), project.tracks),
        selectedClipId: right.id,
        selectedTextId: null,
        selectedTrackId: right.trackId,
      };
    }

    case 'SPLIT_TEXT': {
      const targetTextId = action.textId ?? project.selectedTextId;
      const overlay = targetTextId ? project.textOverlays.find((candidate) => candidate.id === targetTextId) ?? null : null;

      if (!overlay) {
        return project;
      }

      const splitAt = action.playhead;

      if (splitAt <= overlay.start + MIN_CLIP_DURATION || splitAt >= overlay.end - MIN_CLIP_DURATION) {
        return project;
      }

      const left: TextOverlay = {
        ...overlay,
        end: splitAt,
      };
      const right: TextOverlay = {
        ...overlay,
        id: action.newTextId,
        start: splitAt,
      };

      return {
        ...project,
        selectedClipId: null,
        selectedTextId: right.id,
        textOverlays: project.textOverlays.flatMap((candidate) => (candidate.id === overlay.id ? [left, right] : [candidate])),
      };
    }

    case 'TRIM_CLIP': {
      const target = project.clips.find((clip) => clip.id === action.clipId);
      const asset = getAssetById(project, target?.assetId ?? null);

      if (!target) {
        return project;
      }

      if (action.edge === 'start') {
        const sourceIn = Math.min(clampSourceTime(asset, action.sourceTime), target.sourceOut - MIN_CLIP_DURATION);
        const delta = sourceIn - target.sourceIn;

        return updateClip(project, action.clipId, (clip) => ({
          ...clip,
          sourceIn,
          timelineStart: Math.max(0, clip.timelineStart + delta),
        }));
      }

      const sourceOut = Math.max(clampSourceTime(asset, action.sourceTime), target.sourceIn + MIN_CLIP_DURATION);
      const oldDuration = getClipDuration(target);
      const nextDuration = sourceOut - target.sourceIn;
      const delta = nextDuration - oldDuration;
      const clips = rippleTrack(
        {
          ...project,
          clips: project.clips.map((clip) => (clip.id === action.clipId ? { ...clip, sourceOut } : clip)),
        },
        target.trackId,
        getClipEnd(target),
        delta,
        new Set([action.clipId]),
      );

      return {
        ...project,
        clips: sortClipsForRuntime(clips, project.tracks),
      };
    }

    case 'MOVE_CLIP': {
      const clip = project.clips.find((candidate) => candidate.id === action.clipId);

      if (!clip) {
        return project;
      }

      const trackId = action.trackId && project.tracks.some((track) => track.id === action.trackId) ? action.trackId : clip.trackId;
      const desiredStart = Math.max(0, action.timelineStart ?? clip.timelineStart);
      const timelineStart = findFreeTimelineStart(project, trackId, desiredStart, getClipDuration(clip), clip.id);

      return {
        ...project,
        clips: sortClipsForRuntime(
          project.clips.map((candidate) =>
            candidate.id === action.clipId
              ? {
                  ...candidate,
                  timelineStart,
                  trackId,
                }
              : candidate,
          ),
          project.tracks,
        ),
        selectedClipId: clip.id,
        selectedTextId: null,
        selectedTrackId: trackId,
      };
    }

    case 'DELETE_SELECTED': {
      if (project.selectedTextId) {
        return {
          ...project,
          selectedTextId: null,
          textOverlays: project.textOverlays.filter((overlay) => overlay.id !== project.selectedTextId),
        };
      }

      if (!project.selectedClipId) {
        return project;
      }

      return {
        ...project,
        clips: sortClipsForRuntime(removeClipsWithRipple(project, new Set([project.selectedClipId])), project.tracks),
        selectedClipId: null,
      };
    }

    case 'UPDATE_CLIP_AUDIO':
      return updateClip(project, action.clipId, (clip) => ({
        ...clip,
        fadeIn: Math.min(Math.max(action.patch.fadeIn ?? clip.fadeIn, 0), getClipDuration(clip)),
        fadeOut: Math.min(Math.max(action.patch.fadeOut ?? clip.fadeOut, 0), getClipDuration(clip)),
        muted: action.patch.muted ?? clip.muted,
        volume: Math.min(Math.max(action.patch.volume ?? clip.volume, 0), 2),
      }));

    case 'UPDATE_CLIP_EFFECTS':
      return updateClip(project, action.clipId, (clip) => ({
        ...clip,
        effects: clampEffectSettings({
          ...clip.effects,
          ...action.effects,
        }),
      }));

    case 'UPDATE_CLIP_TRANSFORM':
      return updateClip(project, action.clipId, (clip) => ({
        ...clip,
        transform: clampClipTransform({
          ...clip.transform,
          ...action.transform,
        }),
      }));

    case 'UPDATE_CLIP_MASK':
      return updateClip(project, action.clipId, (clip) => ({
        ...clip,
        mask: clampClipMask(action.mask),
      }));

    case 'ADD_TEXT': {
      const projectDuration = Math.max(getProjectDuration(project), MIN_CLIP_DURATION);
      let tracks = project.tracks;
      let trackId = action.overlay.trackId;
      const existingTextTrack = tracks.find((track) => track.kind === 'text');

      if (!trackId || !tracks.some((track) => track.id === trackId)) {
        if (existingTextTrack) {
          trackId = existingTextTrack.id;
        } else {
          const newTrack: TimelineTrack = {
            id: DEFAULT_TEXT_TRACK_ID,
            index: 0,
            kind: 'text',
            locked: false,
            muted: false,
            name: 'Text 1',
            visible: true,
          };
          tracks = normalizeTimelineTracks([...tracks, newTrack]);
          trackId = tracks.find((track) => track.kind === 'text')?.id ?? DEFAULT_TEXT_TRACK_ID;
        }
      }

      const candidate = clampTextOverlay({ ...action.overlay, trackId }, projectDuration, trackId);
      const candidateDuration = Math.max(MIN_CLIP_DURATION, candidate.end - candidate.start);
      const freeStart = findFreeTextOverlayStart(
        project.textOverlays,
        candidate.trackId,
        candidate.start,
        candidateDuration,
        candidate.id,
      );
      const overlay =
        freeStart !== candidate.start
          ? clampTextOverlay({ ...candidate, end: freeStart + candidateDuration, start: freeStart }, projectDuration, trackId)
          : candidate;

      return {
        ...project,
        selectedClipId: null,
        selectedTextId: overlay.id,
        selectedTrackId: overlay.trackId,
        textOverlays: [...project.textOverlays, overlay],
        tracks,
      };
    }

    case 'REPLACE_TEXTS_IN_RANGE': {
      const projectDuration = Math.max(getProjectDuration(project), MIN_CLIP_DURATION);
      let tracks = project.tracks;
      let trackId = action.trackId;
      const existingTextTrack = tracks.find((track) => track.kind === 'text');
      if (!trackId || !tracks.some((track) => track.id === trackId)) {
        if (existingTextTrack) {
          trackId = existingTextTrack.id;
        } else {
          const newTrack: TimelineTrack = {
            id: DEFAULT_TEXT_TRACK_ID,
            index: 0,
            kind: 'text',
            locked: false,
            muted: false,
            name: 'Text 1',
            visible: true,
          };
          tracks = normalizeTimelineTracks([...tracks, newTrack]);
          trackId = tracks.find((track) => track.kind === 'text')?.id ?? DEFAULT_TEXT_TRACK_ID;
        }
      }
      const rangeStart = Math.min(action.rangeStart, action.rangeEnd);
      const rangeEnd = Math.max(action.rangeStart, action.rangeEnd);
      const remaining = project.textOverlays.filter(
        (overlay) =>
          overlay.trackId !== trackId ||
          overlay.end <= rangeStart + 0.001 ||
          overlay.start >= rangeEnd - 0.001,
      );
      const placed = action.overlays
        .map((overlay) => clampTextOverlay({ ...overlay, trackId }, projectDuration, trackId))
        .filter((overlay) => overlay.end > overlay.start);
      return {
        ...project,
        selectedClipId: null,
        selectedTextId: placed[placed.length - 1]?.id ?? project.selectedTextId,
        selectedTrackId: trackId,
        textOverlays: [...remaining, ...placed],
        tracks,
      };
    }

    case 'SHIFT_TEXTS_BY': {
      if (action.textIds.length === 0 || !Number.isFinite(action.delta) || action.delta === 0) {
        return project;
      }
      const projectDuration = Math.max(getProjectDuration(project), MIN_CLIP_DURATION);
      const targetSet = new Set(action.textIds);
      // Pin the group: if the requested delta would push any target below 0
      // (left-shift past the start of the timeline) we clamp the WHOLE group
      // by the same amount so relative spacing between cues is preserved.
      let effectiveDelta = action.delta;
      if (action.delta < 0) {
        for (const overlay of project.textOverlays) {
          if (!targetSet.has(overlay.id)) continue;
          if (overlay.start + effectiveDelta < 0) {
            effectiveDelta = -overlay.start;
          }
        }
      }
      if (effectiveDelta === 0) return project;
      return {
        ...project,
        textOverlays: project.textOverlays.map((overlay) => {
          if (!targetSet.has(overlay.id)) return overlay;
          const duration = Math.max(MIN_CLIP_DURATION, overlay.end - overlay.start);
          const newStart = Math.min(Math.max(0, overlay.start + effectiveDelta), projectDuration - MIN_CLIP_DURATION);
          const newEnd = Math.min(projectDuration, newStart + duration);
          return { ...overlay, end: newEnd, start: newStart };
        }),
      };
    }

    case 'SELECT_TEXT':
      return {
        ...project,
        selectedClipId: null,
        selectedTextId: action.textId,
      };

    case 'UPDATE_TEXT': {
      const projectDuration = Math.max(getProjectDuration(project), MIN_CLIP_DURATION);
      const target = project.textOverlays.find((overlay) => overlay.id === action.textId);

      if (!target) {
        return project;
      }

      const merged = clampTextOverlay({ ...target, ...action.patch }, projectDuration);
      const touchedStart = action.patch.start !== undefined && action.patch.start !== target.start;
      const touchedTrack = action.patch.trackId !== undefined && action.patch.trackId !== target.trackId;

      // Overlap prevention parity with audio/video clips. Only move-like edits
      // (start changed or trackId changed) shift to a free slot — pure trims
      // (end-only changes) are clipped against the next neighbour instead so
      // the user can shrink freely but can't extend through another overlay.
      let next = merged;
      if (touchedStart || touchedTrack) {
        const duration = Math.max(MIN_CLIP_DURATION, merged.end - merged.start);
        const freeStart = findFreeTextOverlayStart(
          project.textOverlays,
          merged.trackId,
          merged.start,
          duration,
          action.textId,
        );
        if (freeStart !== merged.start) {
          next = clampTextOverlay({ ...merged, end: freeStart + duration, start: freeStart }, projectDuration);
        }
      } else {
        // Pure trim or in-place property edit. Clip end against the next
        // overlay on this track to prevent expansion-overlap.
        const neighbours = project.textOverlays
          .filter((overlay) => overlay.trackId === merged.trackId && overlay.id !== action.textId && overlay.start >= merged.start)
          .sort((a, b) => a.start - b.start);
        const nextNeighbour = neighbours[0];
        if (nextNeighbour && merged.end > nextNeighbour.start) {
          next = clampTextOverlay(
            { ...merged, end: Math.max(merged.start + MIN_CLIP_DURATION, nextNeighbour.start) },
            projectDuration,
          );
        }
      }

      return {
        ...project,
        textOverlays: project.textOverlays.map((overlay) => (overlay.id === action.textId ? next : overlay)),
      };
    }

    case 'DELETE_TEXT':
      return {
        ...project,
        selectedTextId: project.selectedTextId === action.textId ? null : project.selectedTextId,
        textOverlays: project.textOverlays.filter((overlay) => overlay.id !== action.textId),
      };

    case 'APPLY_EAL':
      // Wholesale state replacement — used by the AI's apply_eal tool. The
      // outer reducer wrapper handles history (push current present to past).
      return action.nextProject;

    case 'UNDO':
    case 'REDO':
      return project;

    default:
      return project;
  }
}

function shouldRecordHistory(action: ProjectAction) {
  if ('record' in action && action.record === false) {
    return false;
  }

  return !['SELECT_ASSET', 'SELECT_CLIP', 'SELECT_TEXT', 'SELECT_TRACK', 'UPDATE_ASSET', 'UNDO', 'REDO'].includes(action.type);
}

export function projectReducer(state: ProjectHistory, action: ProjectAction): ProjectHistory {
  if (action.type === 'UNDO') {
    const previous = state.past[state.past.length - 1];

    if (!previous) {
      return state;
    }

    return {
      future: [state.present, ...state.future],
      past: state.past.slice(0, -1),
      present: previous,
    };
  }

  if (action.type === 'REDO') {
    const next = state.future[0];

    if (!next) {
      return state;
    }

    return {
      future: state.future.slice(1),
      past: [...state.past, state.present].slice(-MAX_HISTORY),
      present: next,
    };
  }

  const nextPresent = reducePresent(state.present, action);

  if (nextPresent === state.present) {
    return state;
  }

  if (!shouldRecordHistory(action)) {
    return {
      ...state,
      present: nextPresent,
    };
  }

  return {
    future: [],
    past: [...state.past, state.present].slice(-MAX_HISTORY),
    present: nextPresent,
  };
}
