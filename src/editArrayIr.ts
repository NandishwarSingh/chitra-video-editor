import { DEFAULT_EFFECT_SETTINGS, clampEffectSettings, type EffectSettings } from './effects';
import type { EditArrayProgram } from './editArrayLanguage';
import type { ProjectSettings } from './projectPersistence';
import {
  clampClipTransform,
  normalizeTimelineTrack,
  type ClipTransform,
  type TextOverlay,
  type TimelineClip,
  type TimelineTrack,
} from './projectModel';

export type EditArrayDiagnostic = {
  code: string;
  message: string;
  severity: 'error' | 'info' | 'warning';
};

export type EditArrayIrAsset = {
  duration: number;
  fingerprint?: string;
  height: number;
  id: string;
  mediaKey?: string;
  name: string;
  posterKey?: string | null;
  size: number;
  type: string;
  width: number;
};

export type EditArrayIrClip = TimelineClip & {
  layer: string;
  timelineEnd: number;
};

export type EditArrayIrTextOverlay = TextOverlay & {
  layer: 'text:1';
};

export type EditArrayIrReservedOperation = {
  opcode: string;
  payload: unknown[];
};

export type EditArrayIr = {
  assets: EditArrayIrAsset[];
  clips: EditArrayIrClip[];
  cuts: Array<{ afterClip: string; at: number }>;
  diagnostics: EditArrayDiagnostic[];
  exportSettings: ProjectSettings | null;
  project: { name: string; settings: ProjectSettings | null };
  reservedOperations: EditArrayIrReservedOperation[];
  textOverlays: EditArrayIrTextOverlay[];
  tracks: TimelineTrack[];
  version: number;
};

const RESERVED_OPCODES = new Set([
  'animation',
  'camera',
  'generated_asset',
  'keyframe',
  'mask',
  'search',
  'subtitle',
  'transition',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function numberValue(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function parseEditArrayTime(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, value);
  }

  if (typeof value !== 'string') {
    return 0;
  }

  const trimmed = value.trim();

  if (trimmed.endsWith('s')) {
    return Math.max(0, Number.parseFloat(trimmed) || 0);
  }

  const match = trimmed.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);

  if (!match) {
    return 0;
  }

  const [, hours, minutes, seconds] = match;

  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

function parseEffectSettings(value: unknown): EffectSettings {
  if (!isRecord(value)) {
    return { ...DEFAULT_EFFECT_SETTINGS };
  }

  return clampEffectSettings({
    brightness: numberValue(value.brightness, DEFAULT_EFFECT_SETTINGS.brightness),
    contrast: numberValue(value.contrast, DEFAULT_EFFECT_SETTINGS.contrast),
    saturation: numberValue(value.saturation, DEFAULT_EFFECT_SETTINGS.saturation),
  });
}

function parseClipTransform(value: unknown): ClipTransform {
  if (!isRecord(value)) {
    return clampClipTransform(undefined);
  }

  return clampClipTransform({
    scale: numberValue(value.scale, 1),
    x: numberValue(value.x, 0.5),
    y: numberValue(value.y, 0.5),
  });
}

function parseSettings(value: unknown): ProjectSettings | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    fps: numberValue(value.fps, 30),
    height: numberValue(value.height, 1920),
    sampleRate: 48000,
    width: numberValue(value.width, 1080),
  };
}

export function compileEditArrayToIr(program: EditArrayProgram | readonly unknown[]): EditArrayIr {
  const ir: EditArrayIr = {
    assets: [],
    clips: [],
    cuts: [],
    diagnostics: [],
    exportSettings: null,
    project: { name: 'Untitled Project', settings: null },
    reservedOperations: [],
    textOverlays: [],
    tracks: [],
    version: 0,
  };
  const clipAudio = new Map<string, Partial<Pick<TimelineClip, 'fadeIn' | 'fadeOut' | 'muted' | 'volume'>>>();
  const clipEffects = new Map<string, EffectSettings>();

  for (const instruction of program as readonly unknown[]) {
    if (!Array.isArray(instruction) || typeof instruction[0] !== 'string') {
      ir.diagnostics.push({ code: 'invalid_instruction', message: 'Ignored a malformed EAL instruction.', severity: 'warning' });
      continue;
    }

    const [opcode, ...payload] = instruction;

    if (RESERVED_OPCODES.has(opcode)) {
      ir.reservedOperations.push({ opcode, payload });
      continue;
    }

    if (opcode === 'schema') {
      const schema = payload[1];
      if (isRecord(schema)) {
        ir.version = numberValue(schema.version, 0);
      }
      continue;
    }

    if (opcode === 'project') {
      const project = payload[0];
      if (isRecord(project)) {
        ir.project = {
          name: stringValue(project.name, 'Untitled Project'),
          settings: parseSettings(project.settings),
        };
      }
      continue;
    }

    if (opcode === 'export_settings') {
      ir.exportSettings = parseSettings(payload[0]);
      continue;
    }

    if (opcode === 'track') {
      const options = payload[0];
      if (isRecord(options)) {
        ir.tracks.push(
          normalizeTimelineTrack({
            id: stringValue(options.id),
            index: numberValue(options.index, ir.tracks.length),
            kind: options.kind === 'audio' ? 'audio' : 'video',
            locked: Boolean(options.locked),
            muted: Boolean(options.muted),
            name: stringValue(options.name, `Track ${ir.tracks.length + 1}`),
            visible: options.visible !== false,
          }),
        );
      }
      continue;
    }

    if (opcode === 'track_visibility') {
      const trackId = stringValue(payload[0]);
      const options = payload[1];
      if (trackId && isRecord(options)) {
        ir.tracks = ir.tracks.map((track) => (track.id === trackId ? { ...track, visible: options.visible !== false } : track));
      }
      continue;
    }

    if (opcode === 'composite' || opcode === 'move_clip' || opcode === 'ripple_delete') {
      ir.reservedOperations.push({ opcode, payload });
      continue;
    }

    if (opcode === 'import') {
      const kind = payload[0];
      const name = stringValue(payload[1], 'media');
      const options = payload[2];

      if (kind !== 'video' || !isRecord(options)) {
        ir.diagnostics.push({ code: 'unsupported_import', message: `Unsupported import instruction for ${name}.`, severity: 'warning' });
        continue;
      }

      ir.assets.push({
        duration: numberValue(options.seconds, parseEditArrayTime(options.duration)),
        fingerprint: stringValue(options.fingerprint, undefined),
        height: numberValue(options.height, 0),
        id: stringValue(options.id, name),
        mediaKey: stringValue(options.mediaKey, undefined),
        name,
        posterKey: typeof options.posterKey === 'string' ? options.posterKey : null,
        size: numberValue(options.size, 0),
        type: stringValue(options.type, 'video/mp4'),
        width: numberValue(options.width, 0),
      });
      continue;
    }

    if (opcode === 'clip') {
      const assetId = stringValue(payload[0]);
      const options = payload[1];

      if (!assetId || !isRecord(options)) {
        ir.diagnostics.push({ code: 'invalid_clip', message: 'Ignored a clip without an asset id or options.', severity: 'warning' });
        continue;
      }

      const sourceIn = parseEditArrayTime(options.from);
      const sourceOut = Math.max(sourceIn + 0.1, parseEditArrayTime(options.to));
      const timelineStart = parseEditArrayTime(options.start);
      const timelineEnd = timelineStart + Math.max(0.1, sourceOut - sourceIn);
      const trackId = stringValue(options.trackId, stringValue(options.layer).replace(/^video:/, '') || 'video-1');

      ir.clips.push({
        assetId,
        effects: parseEffectSettings(options.effects),
        fadeIn: parseEditArrayTime(options.fadeIn),
        fadeOut: parseEditArrayTime(options.fadeOut),
        id: stringValue(options.id, `clip-${ir.clips.length + 1}`),
        layer: stringValue(options.layer, `video:${trackId}`),
        muted: Boolean(options.muted),
        sourceIn,
        sourceOut,
        timelineEnd,
        timelineStart,
        trackId,
        transform: parseClipTransform(options.transform),
        volume: numberValue(options.volume, 1),
      });
      continue;
    }

    if (opcode === 'audio') {
      const clipId = stringValue(payload[0]);
      const options = payload[1];
      if (clipId && isRecord(options)) {
        clipAudio.set(clipId, {
          fadeIn: parseEditArrayTime(options.fadeIn),
          fadeOut: parseEditArrayTime(options.fadeOut),
          muted: Boolean(options.muted),
          volume: numberValue(options.volume, 1),
        });
      }
      continue;
    }

    if (opcode === 'effect') {
      const clipId = stringValue(payload[0]);
      if (clipId) {
        clipEffects.set(clipId, parseEffectSettings(payload[2]));
      }
      continue;
    }

    if (opcode === 'cut') {
      const options = payload[0];
      if (isRecord(options)) {
        ir.cuts.push({
          afterClip: stringValue(options.afterClip),
          at: parseEditArrayTime(options.at),
        });
      }
      continue;
    }

    if (opcode === 'text') {
      const text = stringValue(payload[0]);
      const options = payload[1];
      if (!isRecord(options)) {
        continue;
      }

      const position = isRecord(options.position) ? options.position : {};
      const start = parseEditArrayTime(options.at);
      const end = Math.max(start + 0.1, parseEditArrayTime(options.end) || start + parseEditArrayTime(options.duration));
      const align = options.align === 'left' || options.align === 'right' ? options.align : 'center';

      ir.textOverlays.push({
        align,
        end,
        id: stringValue(options.id, `text-${ir.textOverlays.length + 1}`),
        layer: 'text:1',
        size: numberValue(options.size, 34),
        start,
        text,
        x: numberValue(position.x, 0.5),
        y: numberValue(position.y, 0.18),
      });
      continue;
    }

    if (!['timeline'].includes(opcode)) {
      ir.diagnostics.push({ code: 'unknown_opcode', message: `Unknown EAL opcode "${opcode}" was ignored.`, severity: 'warning' });
    }
  }

  ir.clips = ir.clips
    .map((clip) => ({
      ...clip,
      ...clipAudio.get(clip.id),
      effects: clipEffects.get(clip.id) ?? clip.effects,
    }))
    .sort((a, b) => a.timelineStart - b.timelineStart);

  if (ir.tracks.length === 0) {
    const trackIds = [...new Set(ir.clips.map((clip) => clip.trackId))];
    ir.tracks = trackIds.length > 0 ? trackIds.map((trackId, index) => normalizeTimelineTrack({ id: trackId, index })) : [normalizeTimelineTrack({ id: 'video-1', index: 0 })];
  }

  const assetIds = new Set(ir.assets.map((asset) => asset.id));
  ir.clips.forEach((clip) => {
    if (!assetIds.has(clip.assetId)) {
      ir.diagnostics.push({
        code: 'missing_asset',
        message: `Clip "${clip.id}" references missing asset "${clip.assetId}".`,
        severity: 'error',
      });
    }
  });

  return ir;
}
