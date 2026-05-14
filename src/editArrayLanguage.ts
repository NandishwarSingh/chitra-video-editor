import { DEFAULT_EFFECT_SETTINGS } from './effects';
import { getClipDuration, getProjectDuration, normalizeTimelineTracks, type ProjectPresent, type TimelineClip, type TimelineTrack } from './projectModel';
import type { PersistedProjectDocument, ProjectSettings } from './projectPersistence';

export type EditArrayProgram = EditArrayInstruction[];

export const EDIT_ARRAY_LANGUAGE_VERSION = 1;

export const EDIT_ARRAY_REQUIRED_OPCODES = [
  'schema',
  'project',
  'timeline',
  'track',
  'export_settings',
  'import',
  'clip',
  'cut',
  'move_clip',
  'ripple_delete',
  'track_visibility',
  'composite',
  'audio',
  'effect',
  'text',
] as const;

export const EDIT_ARRAY_RESERVED_OPCODES = [
  'transition',
  'subtitle',
  'mask',
  'keyframe',
  'animation',
  'camera',
  'search',
  'generated_asset',
] as const;

export const EDIT_ARRAY_SYSTEM_COMPONENTS = [
  'Edit Array Language',
  'Edit Array IR',
  'Edit Compiler',
  'Edit Runtime',
  'Visual Review Agent',
  'Edit Repair Loop',
] as const;

export const EDIT_ARRAY_FIELD_POLICY = {
  PersistedAsset: {
    covered: ['id', 'name', 'kind', 'type', 'size', 'duration', 'width', 'height', 'fingerprint', 'mediaKey', 'posterKey'],
    omitted: [],
  },
  ProjectAsset: {
    covered: ['id', 'name', 'kind', 'type', 'size', 'duration', 'width', 'height'],
    omitted: ['file', 'originalUrl', 'playbackUrl', 'posterUrl', 'proxyStatus', 'proxyUrl'],
  },
  ProjectPresent: {
    covered: ['assets', 'clips', 'textOverlays', 'tracks'],
    omitted: ['selectedAssetId', 'selectedClipId', 'selectedTextId', 'selectedTrackId'],
  },
  ProjectSettings: {
    covered: ['width', 'height', 'fps', 'sampleRate'],
    omitted: [],
  },
  TextOverlay: {
    covered: [
      'align',
      'backgroundColor',
      'bold',
      'color',
      'end',
      'fontFamily',
      'id',
      'italic',
      'letterSpacing',
      'lineHeight',
      'opacity',
      'rotation',
      'shadowBlur',
      'shadowColor',
      'shadowOffsetX',
      'shadowOffsetY',
      'size',
      'skewX',
      'skewY',
      'start',
      'strokeColor',
      'strokeWidth',
      'text',
      'textCase',
      'trackId',
      'underline',
      'x',
      'y',
    ],
    omitted: [],
  },
  TimelineClip: {
    covered: ['id', 'assetId', 'trackId', 'timelineStart', 'sourceIn', 'sourceOut', 'volume', 'muted', 'fadeIn', 'fadeOut', 'effects', 'transform'],
    omitted: [],
  },
  TimelineTrack: {
    covered: ['id', 'kind', 'name', 'index', 'muted', 'locked', 'visible'],
    omitted: [],
  },
} as const;

export type EditArrayInstruction =
  | ['schema', 'chitra_edit_array', { version: typeof EDIT_ARRAY_LANGUAGE_VERSION }]
  | ['project', { name: string; settings: ProjectSettings }]
  | ['timeline', { assets: number; clips: number; duration: string; layers: string[]; seconds: number; text: number }]
  | ['track', { id: string; index: number; kind: 'audio' | 'text' | 'video'; locked: boolean; muted: boolean; name: string; visible: boolean }]
  | ['track_visibility', string, { visible: boolean }]
  | ['composite', { mode: 'track_order'; tracks: string[] }]
  | ['move_clip', string, { start: string; trackId: string }]
  | ['ripple_delete', string, { trackId: string }]
  | ['export_settings', { fps: number; height: number; sampleRate: 48000; width: number }]
  | [
      'import',
      'audio' | 'video',
      string,
      {
        duration: string;
        fingerprint?: string;
        height: number;
        id: string;
        kind: 'audio' | 'video';
        mediaKey?: string;
        posterKey?: string | null;
        seconds: number;
        size: number;
        type: string;
        width: number;
      },
    ]
  | [
      'clip',
      string,
      {
        duration: string;
        effects: TimelineClip['effects'];
        fadeIn: string;
        fadeOut: string;
        from: string;
        id: string;
        layer: string;
        muted: boolean;
        start: string;
        trackId: string;
        to: string;
        transform: TimelineClip['transform'];
        volume: number;
      },
    ]
  | ['cut', { afterClip: string; at: string }]
  | ['audio', string, { fadeIn: string; fadeOut: string; muted: boolean; volume: number }]
  | ['effect', string, 'color_grade', TimelineClip['effects']]
  | [
      'text',
      string,
      {
        align: 'left' | 'center' | 'right';
        at: string;
        backgroundColor: string;
        bold: boolean;
        color: string;
        duration: string;
        end: string;
        fontFamily: string;
        id: string;
        italic: boolean;
        layer: string;
        letterSpacing: number;
        lineHeight: number;
        opacity: number;
        position: { x: number; y: number };
        rotation: number;
        shadow: { blur: number; color: string; offsetX: number; offsetY: number };
        size: number;
        skew: { x: number; y: number };
        stroke: { color: string; width: number };
        textCase: 'none' | 'upper' | 'lower';
        trackId: string;
        underline: boolean;
      },
    ];

type EditArrayAsset = {
  duration: number;
  fingerprint?: string;
  height: number;
  id: string;
  kind?: 'audio' | 'video';
  mediaKey?: string;
  name: string;
  posterKey?: string | null;
  size: number;
  type: string;
  width: number;
};

export function formatEditArrayTime(seconds: number) {
  const clamped = Math.max(0, seconds);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const wholeSeconds = Math.floor(clamped % 60);
  const millis = Math.round((clamped - Math.floor(clamped)) * 1000);

  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${wholeSeconds
    .toString()
    .padStart(2, '0')}.${millis.toString().padStart(3, '0')}`;
}

export function createEditArrayFromRuntime(project: ProjectPresent, settings: ProjectSettings, name = 'Untitled Project') {
  return createEditArrayProgram(
    project.assets.map((asset) => ({
      duration: asset.duration,
      height: asset.height,
      id: asset.id,
      kind: asset.kind,
      name: asset.name,
      size: asset.size,
      type: asset.type,
      width: asset.width,
    })),
    project.clips,
    project.textOverlays,
    project.tracks,
    settings,
    name,
  );
}

export function createEditArrayFromDocument(document: PersistedProjectDocument, settings: ProjectSettings, name = 'Untitled Project') {
  return createEditArrayProgram(document.assets, document.clips, document.textOverlays, normalizeTimelineTracks(document.tracks), settings, name);
}

export function stringifyEditArray(program: EditArrayProgram) {
  return JSON.stringify(program, null, 2);
}

function createEditArrayProgram(
  assets: EditArrayAsset[],
  clips: ProjectPresent['clips'],
  textOverlays: ProjectPresent['textOverlays'],
  tracks: TimelineTrack[],
  settings: ProjectSettings,
  name: string,
): EditArrayProgram {
  const program: EditArrayProgram = [
    ['schema', 'chitra_edit_array', { version: EDIT_ARRAY_LANGUAGE_VERSION }],
    ['project', { name, settings }],
    ['export_settings', settings],
  ];
  const duration = getProjectDuration({
    assets: [],
    clips,
    selectedAssetId: null,
    selectedClipId: null,
    selectedTextId: null,
    selectedTrackId: null,
    textOverlays,
    tracks,
  });

  program.push([
    'timeline',
    {
      assets: assets.length,
      clips: clips.length,
      duration: formatEditArrayTime(duration),
      layers: [...tracks.map((track) => `${track.kind}:${track.id}`), 'text:overlay'],
      seconds: Number(duration.toFixed(3)),
      text: textOverlays.length,
    },
  ]);

  tracks
    .slice()
    .sort((a, b) => a.index - b.index)
    .forEach((track) => {
      program.push([
        'track',
        {
          id: track.id,
          index: track.index,
          kind: track.kind,
          locked: track.locked,
          muted: track.muted,
          name: track.name,
          visible: track.visible,
        },
      ]);
    });
  program.push(['composite', { mode: 'track_order', tracks: tracks.map((track) => track.id) }]);

  assets.forEach((asset) => {
    const kind = asset.kind ?? (asset.type.startsWith('audio/') ? 'audio' : 'video');
    program.push([
      'import',
      kind,
      asset.name,
      {
        duration: formatEditArrayTime(asset.duration),
        fingerprint: asset.fingerprint,
        height: asset.height,
        id: asset.id,
        kind,
        mediaKey: asset.mediaKey,
        posterKey: asset.posterKey,
        seconds: Number(asset.duration.toFixed(3)),
        size: asset.size,
        type: asset.type,
        width: asset.width,
      },
    ]);
  });

  clips
    .slice()
    .sort((a, b) => a.timelineStart - b.timelineStart)
    .forEach((clip, index) => {
    const duration = getClipDuration(clip);
    const start = clip.timelineStart;
    const clipEnd = start + duration;

    program.push([
      'clip',
      clip.assetId,
      {
        duration: formatEditArrayTime(duration),
        effects: {
          ...DEFAULT_EFFECT_SETTINGS,
          ...clip.effects,
        },
        fadeIn: formatEditArrayTime(clip.fadeIn),
        fadeOut: formatEditArrayTime(clip.fadeOut),
        from: formatEditArrayTime(clip.sourceIn),
        id: clip.id,
        layer: `video:${clip.trackId}`,
        muted: clip.muted,
        start: formatEditArrayTime(start),
        trackId: clip.trackId,
        to: formatEditArrayTime(clip.sourceOut),
        transform: clip.transform,
        volume: clip.volume,
      },
    ]);
    program.push([
      'audio',
      clip.id,
      {
        fadeIn: formatEditArrayTime(clip.fadeIn),
        fadeOut: formatEditArrayTime(clip.fadeOut),
        muted: clip.muted,
        volume: clip.volume,
      },
    ]);
    program.push(['effect', clip.id, 'color_grade', { ...DEFAULT_EFFECT_SETTINGS, ...clip.effects }]);

    if (index < clips.length - 1) {
      program.push(['cut', { afterClip: clip.id, at: formatEditArrayTime(clipEnd) }]);
    }
  });

  textOverlays.forEach((overlay) => {
    const trackId = overlay.trackId || 'text-1';
    program.push([
      'text',
      overlay.text,
      {
        align: overlay.align,
        at: formatEditArrayTime(overlay.start),
        backgroundColor: overlay.backgroundColor,
        bold: overlay.bold,
        color: overlay.color,
        duration: formatEditArrayTime(overlay.end - overlay.start),
        end: formatEditArrayTime(overlay.end),
        fontFamily: overlay.fontFamily,
        id: overlay.id,
        italic: overlay.italic,
        layer: `text:${trackId}`,
        letterSpacing: Number(overlay.letterSpacing.toFixed(2)),
        lineHeight: Number(overlay.lineHeight.toFixed(2)),
        opacity: Number(overlay.opacity.toFixed(3)),
        position: {
          x: Number(overlay.x.toFixed(3)),
          y: Number(overlay.y.toFixed(3)),
        },
        rotation: Number(overlay.rotation.toFixed(2)),
        shadow: {
          blur: Number(overlay.shadowBlur.toFixed(2)),
          color: overlay.shadowColor,
          offsetX: Number(overlay.shadowOffsetX.toFixed(2)),
          offsetY: Number(overlay.shadowOffsetY.toFixed(2)),
        },
        size: overlay.size,
        skew: {
          x: Number(overlay.skewX.toFixed(2)),
          y: Number(overlay.skewY.toFixed(2)),
        },
        stroke: {
          color: overlay.strokeColor,
          width: Number(overlay.strokeWidth.toFixed(2)),
        },
        textCase: overlay.textCase,
        trackId,
        underline: overlay.underline,
      },
    ]);
  });

  return program;
}
