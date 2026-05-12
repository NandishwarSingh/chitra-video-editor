import { describe, expect, it } from 'vitest';
import { DEFAULT_EFFECT_SETTINGS } from './effects';
import {
  EDIT_ARRAY_FIELD_POLICY,
  EDIT_ARRAY_REQUIRED_OPCODES,
  EDIT_ARRAY_RESERVED_OPCODES,
  EDIT_ARRAY_SYSTEM_COMPONENTS,
  createEditArrayFromRuntime,
  formatEditArrayTime,
} from './editArrayLanguage';
import { PROJECT_PRESETS } from './projectPersistence';
import { DEFAULT_CLIP_TRANSFORM, createDefaultTracks, idleJobStatus, type ProjectPresent } from './projectModel';

function project(): ProjectPresent {
  const file = new File(['video'], 'main.mp4', { type: 'video/mp4' });
  const tracks = createDefaultTracks();

  return {
    assets: [
      {
        duration: 10,
        file,
        height: 1920,
        id: 'main',
        kind: 'video',
        name: 'main.mp4',
        originalUrl: 'blob:source',
        playbackUrl: 'blob:source',
        posterUrl: null,
        proxyStatus: idleJobStatus,
        proxyUrl: null,
        size: file.size,
        type: 'video/mp4',
        width: 1080,
      },
    ],
    clips: [
      {
        assetId: 'main',
        effects: {
          brightness: 0.1,
          contrast: 1.2,
          saturation: 1,
        },
        fadeIn: 0.25,
        fadeOut: 0,
        id: 'clip-1',
        muted: false,
        sourceIn: 1,
        sourceOut: 4,
        timelineStart: 0.5,
        trackId: tracks[0].id,
        transform: DEFAULT_CLIP_TRANSFORM,
        volume: 0.8,
      },
    ],
    selectedAssetId: 'main',
    selectedClipId: 'clip-1',
    selectedTextId: null,
    selectedTrackId: tracks[0].id,
    textOverlays: [
      {
        align: 'center',
        end: 2.5,
        id: 'text-1',
        size: 42,
        start: 0.5,
        text: 'THIS CHANGED EVERYTHING',
        x: 0.5,
        y: 0.2,
      },
    ],
    tracks,
  };
}

describe('Edit Array Language', () => {
  it('formats timeline times with millisecond precision', () => {
    expect(formatEditArrayTime(65.25)).toBe('00:01:05.250');
  });

  it('creates an LLM-friendly program for current timeline state', () => {
    const editArray = createEditArrayFromRuntime(project(), PROJECT_PRESETS.vertical, 'Hook Edit');

    expect(editArray[0]).toEqual(['schema', 'chitra_edit_array', { version: 1 }]);
    expect(editArray).toContainEqual(['project', { name: 'Hook Edit', settings: PROJECT_PRESETS.vertical }]);
    expect(editArray).toContainEqual([
      'import',
      'video',
      'main.mp4',
      expect.objectContaining({ height: 1920, id: 'main', size: 5, width: 1080 }),
    ]);
    expect(editArray).toContainEqual([
      'clip',
      'main',
      expect.objectContaining({
        effects: { brightness: 0.1, contrast: 1.2, saturation: 1 },
        fadeIn: '00:00:00.250',
        from: '00:00:01.000',
        id: 'clip-1',
        start: '00:00:00.500',
        to: '00:00:04.000',
        trackId: 'video-1',
        transform: DEFAULT_CLIP_TRANSFORM,
        volume: 0.8,
      }),
    ]);
    expect(editArray).toContainEqual(['effect', 'clip-1', 'color_grade', { brightness: 0.1, contrast: 1.2, saturation: 1 }]);
    expect(editArray).toContainEqual([
      'text',
      'THIS CHANGED EVERYTHING',
      expect.objectContaining({
        at: '00:00:00.500',
        duration: '00:00:02.000',
        layer: 'text:1',
      }),
    ]);
  });

  it('fills default effect settings when clips are missing effect fields', () => {
    const editArray = createEditArrayFromRuntime(project(), PROJECT_PRESETS.vertical, 'Defaults');

    expect(editArray).not.toContainEqual(['effect', 'clip-1', 'color_grade', DEFAULT_EFFECT_SETTINGS]);
  });

  it('declares required opcodes and field coverage for future edit features', () => {
    expect(EDIT_ARRAY_REQUIRED_OPCODES).toEqual([
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
    ]);
    expect(EDIT_ARRAY_FIELD_POLICY.TimelineClip.covered).toContain('timelineStart');
    expect(EDIT_ARRAY_FIELD_POLICY.TimelineTrack.covered).toContain('visible');
    expect(EDIT_ARRAY_FIELD_POLICY.TimelineClip.covered).toContain('sourceIn');
    expect(EDIT_ARRAY_FIELD_POLICY.TextOverlay.covered).toContain('align');
    expect(EDIT_ARRAY_FIELD_POLICY.ProjectAsset.omitted).toContain('playbackUrl');
    expect(EDIT_ARRAY_RESERVED_OPCODES).toContain('keyframe');
    expect(EDIT_ARRAY_RESERVED_OPCODES).toContain('subtitle');
    expect(EDIT_ARRAY_SYSTEM_COMPONENTS).toContain('Edit Compiler');
    expect(EDIT_ARRAY_SYSTEM_COMPONENTS).toContain('Edit Repair Loop');
  });
});
