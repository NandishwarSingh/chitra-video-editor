import { describe, expect, it } from 'vitest';
import { compileEditArrayProgram } from './editCompiler';
import { createEditArrayFromRuntime } from './editArrayLanguage';
import { runEditRepairLoop } from './editRepairLoop';
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
        effects: { brightness: 0.38, contrast: 1.75, saturation: 1.95 },
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

describe('edit repair loop', () => {
  it('applies repairs and returns the issues observed after the final pass', async () => {
    const source = project();
    const plan = compileEditArrayProgram(createEditArrayFromRuntime(source, PROJECT_PRESETS.vertical, 'Runtime'));
    const review = createVisualReviewReport(plan.ir, PROJECT_PRESETS.vertical);

    const result = await runEditRepairLoop(plan, source, review, {
      maxPasses: 3,
      rereview: (project) => {
        const refreshedPlan = compileEditArrayProgram(createEditArrayFromRuntime(project, PROJECT_PRESETS.vertical, 'Runtime'));
        return createVisualReviewReport(refreshedPlan.ir, PROJECT_PRESETS.vertical);
      },
    });

    expect(result.project.textOverlays[0].x).toBeLessThanOrEqual(0.92);
    expect(result.project.clips[0].effects.contrast).toBeLessThanOrEqual(1.6);
    expect(result.issues.some((issue) => issue.code === 'text_near_edge')).toBe(false);
    expect(result.issues.some((issue) => issue.code === 'effect_overdrive')).toBe(false);
    expect(result.compilerDiagnostics).toEqual(plan.diagnostics);
  });

  it('treats a missing rereview function as single-pass repair', async () => {
    const source = project();
    const plan = compileEditArrayProgram(createEditArrayFromRuntime(source, PROJECT_PRESETS.vertical, 'Runtime'));
    const review = createVisualReviewReport(plan.ir, PROJECT_PRESETS.vertical);

    const result = await runEditRepairLoop(plan, source, review, { maxPasses: 10 });

    expect(result.repairPlan.patches).toEqual([]);
    expect(result.project.textOverlays[0].x).toBeLessThanOrEqual(0.92);
  });

  it('exits cleanly when the initial review has no actionable issues', async () => {
    const source = project();
    const plan = compileEditArrayProgram(createEditArrayFromRuntime(source, PROJECT_PRESETS.vertical, 'Runtime'));

    const result = await runEditRepairLoop(plan, source, { issues: [], summary: { assets: 1, clips: 1, duration: 3, reservedOperations: 0, textOverlays: 1 } });

    expect(result.project).toEqual(source);
    expect(result.issues).toEqual([]);
  });
});
