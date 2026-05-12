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
  scale: number;
  x: number;
  y: number;
};

export type TimelineClip = {
  assetId: string;
  effects: EffectSettings;
  fadeIn: number;
  fadeOut: number;
  id: string;
  muted: boolean;
  sourceIn: number;
  sourceOut: number;
  timelineStart: number;
  trackId: string;
  transform: ClipTransform;
  volume: number;
};

export const DEFAULT_TEXT_TRACK_ID = 'text-1';

export type TextOverlay = {
  align: 'left' | 'center' | 'right';
  end: number;
  id: string;
  size: number;
  start: number;
  text: string;
  trackId: string;
  x: number;
  y: number;
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
  | { playhead: number; newClipId: string; type: 'SPLIT_CLIP' }
  | { playhead: number; newTextId: string; textId?: string; type: 'SPLIT_TEXT' }
  | { clipId: string; edge: 'start' | 'end'; sourceTime: number; type: 'TRIM_CLIP' }
  | { clipId: string; record?: boolean; timelineStart?: number; trackId?: string; type: 'MOVE_CLIP' }
  | { type: 'DELETE_SELECTED' }
  | { clipId: string; patch: Partial<Pick<TimelineClip, 'fadeIn' | 'fadeOut' | 'muted' | 'volume'>>; type: 'UPDATE_CLIP_AUDIO' }
  | { clipId: string; effects: Partial<EffectSettings>; type: 'UPDATE_CLIP_EFFECTS' }
  | { clipId: string; record?: boolean; transform: Partial<ClipTransform>; type: 'UPDATE_CLIP_TRANSFORM' }
  | { overlay: TextOverlay; type: 'ADD_TEXT' }
  | { textId: string | null; type: 'SELECT_TEXT' }
  | { patch: Partial<TextOverlay>; record?: boolean; textId: string; type: 'UPDATE_TEXT' }
  | { textId: string; type: 'DELETE_TEXT' }
  | { type: 'UNDO' }
  | { type: 'REDO' };

const MIN_CLIP_DURATION = 0.1;
const MAX_HISTORY = 60;
const DEFAULT_VIDEO_TRACK_ID = 'video-1';

export const DEFAULT_CLIP_TRANSFORM: ClipTransform = {
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

export function getClipsAtTime(project: ProjectPresent, time: number) {
  const clampedTime = Math.max(time, 0);
  const trackIndexById = new Map(project.tracks.map((track) => [track.id, track.index]));
  const audibleTrackIds = new Set(
    project.tracks.filter((track) => track.kind === 'video' ? track.visible : !track.muted).map((track) => track.id),
  );

  return project.clips
    .filter((clip) => audibleTrackIds.has(clip.trackId) && clampedTime >= clip.timelineStart && clampedTime < getClipEnd(clip))
    .sort((a, b) => (trackIndexById.get(a.trackId) ?? 0) - (trackIndexById.get(b.trackId) ?? 0))
    .map((clip) => {
      const duration = getClipDuration(clip);

      return {
        clip,
        clipEnd: clip.timelineStart + duration,
        clipStart: clip.timelineStart,
        localTime: Math.min(duration, Math.max(0, clampedTime - clip.timelineStart)),
        track: getTrackById(project, clip.trackId),
      };
    });
}

export function getVideoClipsAtTime(project: ProjectPresent, time: number) {
  return getClipsAtTime(project, time).filter((entry) => entry.track?.kind === 'video');
}

export function getAudioClipsAtTime(project: ProjectPresent, time: number) {
  return getClipsAtTime(project, time).filter((entry) => entry.track?.kind === 'audio');
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

export function getActiveTextOverlays(project: ProjectPresent, playhead: number) {
  return project.textOverlays.filter((overlay) => playhead >= overlay.start && playhead <= overlay.end);
}

function clampSourceTime(asset: ProjectAsset | null, value: number) {
  return Math.min(Math.max(value, 0), Math.max(asset?.duration ?? value, MIN_CLIP_DURATION));
}

function clampTextOverlay(overlay: TextOverlay, projectDuration: number, fallbackTrackId = DEFAULT_TEXT_TRACK_ID): TextOverlay {
  const start = Math.min(Math.max(overlay.start, 0), Math.max(0, projectDuration - MIN_CLIP_DURATION));
  const end = Math.min(Math.max(overlay.end, start + MIN_CLIP_DURATION), Math.max(projectDuration, start + MIN_CLIP_DURATION));

  return {
    ...overlay,
    end,
    size: Math.min(Math.max(overlay.size, 12), 96),
    start,
    text: overlay.text.slice(0, 180),
    trackId: overlay.trackId || fallbackTrackId,
    x: Math.min(Math.max(overlay.x, 0.02), 0.98),
    y: Math.min(Math.max(overlay.y, 0.02), 0.98),
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
      const active = getClipAtTime(project, action.playhead);

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

      const overlay = clampTextOverlay({ ...action.overlay, trackId }, projectDuration, trackId);

      return {
        ...project,
        selectedClipId: null,
        selectedTextId: overlay.id,
        selectedTrackId: overlay.trackId,
        textOverlays: [...project.textOverlays, overlay],
        tracks,
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

      return {
        ...project,
        textOverlays: project.textOverlays.map((overlay) =>
          overlay.id === action.textId ? clampTextOverlay({ ...overlay, ...action.patch }, projectDuration) : overlay,
        ),
      };
    }

    case 'DELETE_TEXT':
      return {
        ...project,
        selectedTextId: project.selectedTextId === action.textId ? null : project.selectedTextId,
        textOverlays: project.textOverlays.filter((overlay) => overlay.id !== action.textId),
      };

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
