import { describe, expect, it } from 'vitest';
import { compileEditArrayProgram } from './editCompiler';
import { executeEditPlan } from './editRuntime';
import { createEditArrayFromRuntime } from './editArrayLanguage';
import { createEditRepairPlan, applyEditRepairPlan } from './editRepairLoop';
import { createVisualReviewReport } from './visualReviewAgent';
import { PROJECT_PRESETS } from './projectPersistence';
import { DEFAULT_CLIP_TRANSFORM, DEFAULT_TEXT_OVERLAY, createDefaultTracks, idleJobStatus, type ProjectPresent } from './projectModel';

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
          brightness: 0.38,
          contrast: 1.75,
          saturation: 1.95,
        },
        fadeIn: 0,
        fadeOut: 0,
        id: 'clip-1',
        muted: false,
        sourceIn: 1,
        sourceOut: 4,
        timelineStart: 0,
        trackId: tracks[0].id,
        transform: DEFAULT_CLIP_TRANSFORM,
        volume: 1,
      },
    ],
    selectedAssetId: 'main',
    selectedClipId: 'clip-1',
    selectedTextId: null,
    selectedTrackId: tracks[0].id,
    textOverlays: [
      {
        ...DEFAULT_TEXT_OVERLAY,
        end: 2,
        id: 'text-1',
        size: 42,
        start: 0.5,
        text: 'Hook',
        trackId: 'text-1',
        x: 0.99,
        y: 0.02,
      },
    ],
    tracks,
  };
}

describe('Edit compiler and runtime', () => {
  it('compiles EAL into IR and runtime operations', () => {
    const program = createEditArrayFromRuntime(project(), PROJECT_PRESETS.vertical, 'Runtime');
    const plan = compileEditArrayProgram(program);

    expect(plan.ir.assets[0].id).toBe('main');
    expect(plan.ir.clips[0]).toMatchObject({ id: 'clip-1', sourceIn: 1, sourceOut: 4, trackId: 'video-1' });
    expect(plan.operations.map((operation) => operation.type)).toContain('CREATE_TRACK');
    expect(plan.operations.map((operation) => operation.type)).toContain('PLACE_CLIP');
    expect(plan.operations.map((operation) => operation.type)).toContain('SET_TRANSFORM');
    expect(plan.operations.map((operation) => operation.type)).toContain('ADD_TEXT');
  });

  it('round-trips ClipTransform.rotation through EAL', () => {
    const sourceProject = project();
    sourceProject.clips = sourceProject.clips.map((clip) => ({
      ...clip,
      transform: { rotation: 45, scale: 1.5, x: 0.4, y: 0.6 },
    }));
    const plan = compileEditArrayProgram(createEditArrayFromRuntime(sourceProject, PROJECT_PRESETS.vertical, 'Runtime'));
    const result = executeEditPlan(plan, sourceProject);
    expect(result.project.clips[0].transform).toMatchObject({
      rotation: 45,
      scale: 1.5,
      x: 0.4,
      y: 0.6,
    });
  });

  it('executes a compiled plan against available runtime media', () => {
    const sourceProject = project();
    const plan = compileEditArrayProgram(createEditArrayFromRuntime(sourceProject, PROJECT_PRESETS.vertical, 'Runtime'));
    const result = executeEditPlan(plan, sourceProject);

    expect(result.project.assets).toHaveLength(1);
    expect(result.project.clips).toHaveLength(1);
    expect(result.project.textOverlays).toHaveLength(1);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toHaveLength(0);
  });

  it('round-trips the full text styling envelope through EAL', () => {
    const sourceProject = project();
    sourceProject.textOverlays = [
      {
        ...DEFAULT_TEXT_OVERLAY,
        backgroundColor: '#11223380',
        bold: false,
        color: '#ff00cc',
        end: 2,
        fontFamily: 'bebas',
        id: 'text-1',
        italic: true,
        letterSpacing: 4,
        lineHeight: 1.4,
        opacity: 0.75,
        rotation: 12,
        shadowBlur: 8,
        shadowColor: '#000000cc',
        shadowOffsetX: 2,
        shadowOffsetY: 3,
        size: 56,
        skewX: -8,
        skewY: 4,
        start: 0.5,
        strokeColor: '#ffffff',
        strokeWidth: 2.5,
        text: 'Styled',
        textCase: 'upper',
        trackId: 'text-1',
        underline: true,
        x: 0.5,
        y: 0.5,
      },
    ];
    const plan = compileEditArrayProgram(createEditArrayFromRuntime(sourceProject, PROJECT_PRESETS.vertical, 'Runtime'));
    const result = executeEditPlan(plan, sourceProject);
    const restored = result.project.textOverlays[0];

    expect(restored).toMatchObject({
      backgroundColor: '#11223380',
      bold: false,
      color: '#ff00cc',
      fontFamily: 'bebas',
      italic: true,
      letterSpacing: 4,
      lineHeight: 1.4,
      opacity: 0.75,
      rotation: 12,
      shadowBlur: 8,
      shadowColor: '#000000cc',
      shadowOffsetX: 2,
      shadowOffsetY: 3,
      size: 56,
      skewX: -8,
      skewY: 4,
      strokeColor: '#ffffff',
      strokeWidth: 2.5,
      textCase: 'upper',
      underline: true,
    });
  });

  it('creates deterministic visual review and repair patches', () => {
    const sourceProject = project();
    const plan = compileEditArrayProgram(createEditArrayFromRuntime(sourceProject, PROJECT_PRESETS.vertical, 'Runtime'));
    const review = createVisualReviewReport(plan.ir, PROJECT_PRESETS.vertical);
    const repairPlan = createEditRepairPlan(review);
    const repaired = applyEditRepairPlan(sourceProject, repairPlan);

    expect(review.issues.map((issue) => issue.code)).toContain('text_near_edge');
    expect(review.issues.map((issue) => issue.code)).toContain('effect_overdrive');
    expect(repaired.textOverlays[0].x).toBeLessThanOrEqual(0.92);
    expect(repaired.clips[0].effects.contrast).toBeLessThanOrEqual(1.6);
  });
});
