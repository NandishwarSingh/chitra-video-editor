// Integration tests for the AI-driven edit flow.
//
// These exercise the *programmatic* path the chat backend uses when the
// model emits `apply_eal` — we can't drive the browser from a test, but we
// can prove that:
//   1. A clean transcript-aligned cut, expressed as an EAL program, compiles
//      and executes into the expected ProjectPresent.
//   2. A beat-aligned cut produces clip boundaries that fall on detected
//      beat times within tolerance.
//   3. After a cut, the affected clip ranges + project duration are correct.
//
// If any of these fail, the AI's `apply_eal` tool would corrupt state on
// apply. The chat path in App.tsx (`applyChatToolCall`) is the same compile +
// execute + dispatch pipeline these tests use, so coverage here is coverage
// of the AI's edit path.

import { describe, expect, it } from 'vitest';
import { compileEditArrayProgram } from './editCompiler';
import { createEditArrayFromRuntime } from './editArrayLanguage';
import { executeEditPlan } from './editRuntime';
import { PROJECT_PRESETS } from './projectPersistence';
import {
  DEFAULT_CLIP_TRANSFORM,
  createDefaultTracks,
  getClipDuration,
  getProjectDuration,
  idleJobStatus,
  projectReducer,
  type ProjectHistory,
  type ProjectPresent,
} from './projectModel';

function projectWithOneClip(): ProjectPresent {
  const file = new File(['video'], 'narration.mp4', { type: 'video/mp4' });
  const tracks = createDefaultTracks();
  return {
    assets: [
      {
        duration: 30,
        file,
        height: 1080,
        id: 'a-main',
        kind: 'video',
        name: 'narration.mp4',
        originalUrl: 'blob:source',
        playbackUrl: 'blob:source',
        posterUrl: null,
        proxyStatus: idleJobStatus,
        proxyUrl: null,
        size: file.size,
        type: 'video/mp4',
        width: 1920,
      },
    ],
    clips: [
      {
        assetId: 'a-main',
        effects: { brightness: 0, contrast: 1, saturation: 1 },
        fadeIn: 0,
        fadeOut: 0,
        id: 'c1',
        muted: false,
        sourceIn: 0,
        sourceOut: 30,
        timelineStart: 0,
        trackId: tracks[0].id,
        transform: DEFAULT_CLIP_TRANSFORM,
        volume: 1,
      },
    ],
    selectedAssetId: 'a-main',
    selectedClipId: 'c1',
    selectedTextId: null,
    selectedTrackId: tracks[0].id,
    textOverlays: [],
    tracks,
  };
}

describe('AI edit flow (apply_eal pipeline)', () => {
  it('transcript-driven clean cut: split clip at a sentence boundary', () => {
    // Mirror: model sees a transcript like
    //   [0.00-4.80] "Welcome to the show."
    //   [4.80-12.50] "Today we're going to talk about video editing."
    // and emits an EAL program that splits the clip at 4.80s.
    const source = projectWithOneClip();
    const settings = PROJECT_PRESETS.landscape;

    // 1. Compose the program the model would emit: same project, but the
    //    single clip is now two adjacent clips meeting at the sentence
    //    boundary (4.80s).
    const program = createEditArrayFromRuntime(source, settings, 'Cut at sentence');
    // Mutate: replace the single `["clip", ...]` instruction with two.
    const clipIdx = program.findIndex((entry) => Array.isArray(entry) && entry[0] === 'clip');
    expect(clipIdx).toBeGreaterThan(-1);
    const tracks = source.tracks;
    const trackId = tracks[0].id;
    const cutAt = 4.8;
    const splitProgram = [
      ...program.slice(0, clipIdx),
      [
        'clip',
        'a-main',
        {
          duration: '00:00:04.800',
          effects: { brightness: 0, contrast: 1, saturation: 1 },
          fadeIn: '00:00:00.000',
          fadeOut: '00:00:00.000',
          from: '00:00:00.000',
          id: 'c1-a',
          layer: `video:${trackId}`,
          muted: false,
          start: '00:00:00.000',
          to: '00:00:04.800',
          trackId,
          transform: DEFAULT_CLIP_TRANSFORM,
          volume: 1,
        },
      ],
      [
        'clip',
        'a-main',
        {
          duration: '00:00:25.200',
          effects: { brightness: 0, contrast: 1, saturation: 1 },
          fadeIn: '00:00:00.000',
          fadeOut: '00:00:00.000',
          from: '00:00:04.800',
          id: 'c1-b',
          layer: `video:${trackId}`,
          muted: false,
          start: '00:00:04.800',
          to: '00:00:30.000',
          trackId,
          transform: DEFAULT_CLIP_TRANSFORM,
          volume: 1,
        },
      ],
      ...program.slice(clipIdx + 1),
    ];

    // 2. Compile + execute (this is the exact path applyChatToolCall uses).
    const plan = compileEditArrayProgram(splitProgram);
    const errors = plan.ir.diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toEqual([]);

    const result = executeEditPlan(plan, source);
    const runtimeErrors = result.diagnostics.filter((d) => d.severity === 'error');
    expect(runtimeErrors).toEqual([]);

    // 3. Verify the cut math is correct.
    expect(result.project.clips).toHaveLength(2);
    const [a, b] = result.project.clips.sort((x, y) => x.timelineStart - y.timelineStart);
    expect(a.id).toBe('c1-a');
    expect(a.sourceIn).toBeCloseTo(0, 3);
    expect(a.sourceOut).toBeCloseTo(cutAt, 3);
    expect(a.timelineStart).toBeCloseTo(0, 3);
    expect(getClipDuration(a)).toBeCloseTo(cutAt, 3);

    expect(b.id).toBe('c1-b');
    expect(b.sourceIn).toBeCloseTo(cutAt, 3);
    expect(b.sourceOut).toBeCloseTo(30, 3);
    expect(b.timelineStart).toBeCloseTo(cutAt, 3);
    expect(getClipDuration(b)).toBeCloseTo(30 - cutAt, 3);

    expect(getProjectDuration(result.project)).toBeCloseTo(30, 3);
  });

  it('apply_eal lands cuts on detected beats within a 30 ms tolerance', () => {
    // Mirror: model is told beats are at [1.00, 2.00, 3.00, 4.00] (120 BPM)
    // and asked to cut every two beats. It emits a program with cuts at
    // 2.00 and 4.00 timeline-seconds.
    const source = projectWithOneClip();
    const settings = PROJECT_PRESETS.landscape;
    const beats = [1.0, 2.0, 3.0, 4.0];

    const program = createEditArrayFromRuntime(source, settings, 'Beat cut');
    const clipIdx = program.findIndex((entry) => Array.isArray(entry) && entry[0] === 'clip');
    const trackId = source.tracks[0].id;

    const everyTwo = beats.filter((_, i) => i % 2 === 1); // 2.0, 4.0
    const boundaries = [0, ...everyTwo, 30];
    const beatProgram = [
      ...program.slice(0, clipIdx),
      ...boundaries.slice(0, -1).map((from, i): unknown[] => {
        const to = boundaries[i + 1];
        return [
          'clip',
          'a-main',
          {
            duration: `00:00:${(to - from).toFixed(3).padStart(6, '0')}`,
            effects: { brightness: 0, contrast: 1, saturation: 1 },
            fadeIn: '00:00:00.000',
            fadeOut: '00:00:00.000',
            from: `00:00:${from.toFixed(3).padStart(6, '0')}`,
            id: `c1-${i}`,
            layer: `video:${trackId}`,
            muted: false,
            start: `00:00:${from.toFixed(3).padStart(6, '0')}`,
            to: `00:00:${to.toFixed(3).padStart(6, '0')}`,
            trackId,
            transform: DEFAULT_CLIP_TRANSFORM,
            volume: 1,
          },
        ];
      }),
      ...program.slice(clipIdx + 1),
    ];

    const plan = compileEditArrayProgram(beatProgram);
    const result = executeEditPlan(plan, source);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    const clipBoundaries = [
      ...result.project.clips.map((c) => c.timelineStart),
      ...result.project.clips.map((c) => c.timelineStart + getClipDuration(c)),
    ];

    // Every non-zero, non-end boundary should be within 30 ms of a beat.
    for (const boundary of clipBoundaries) {
      if (boundary < 0.1 || boundary > 29.9) continue;
      const closestBeat = beats.reduce((best, b) =>
        Math.abs(b - boundary) < Math.abs(best - boundary) ? b : best,
      beats[0]);
      expect(Math.abs(boundary - closestBeat)).toBeLessThan(0.03);
    }
  });

  it('round-trips an apply_eal as a single APPLY_EAL reducer action (undo-safe)', () => {
    // What App.tsx:applyChatToolCall does end-to-end. After dispatch:
    //   - present matches the executed plan
    //   - past has the previous present (undo will reach it)
    const source = projectWithOneClip();
    const settings = PROJECT_PRESETS.landscape;

    // Build initial state: createInitialProject-style ProjectHistory mock.
    let state: ProjectHistory = { future: [], past: [], present: source };

    // Hand-roll an EAL program that moves the only clip's start from 0s to 5s.
    const program = createEditArrayFromRuntime(source, settings, 'Move');
    const clipIdx = program.findIndex((e) => Array.isArray(e) && e[0] === 'clip');
    const trackId = source.tracks[0].id;
    const moved = [
      ...program.slice(0, clipIdx),
      [
        'clip',
        'a-main',
        {
          duration: '00:00:30.000',
          effects: { brightness: 0, contrast: 1, saturation: 1 },
          fadeIn: '00:00:00.000',
          fadeOut: '00:00:00.000',
          from: '00:00:00.000',
          id: 'c1',
          layer: `video:${trackId}`,
          muted: false,
          start: '00:00:05.000',
          to: '00:00:30.000',
          trackId,
          transform: DEFAULT_CLIP_TRANSFORM,
          volume: 1,
        },
      ],
      ...program.slice(clipIdx + 1),
    ];

    const plan = compileEditArrayProgram(moved);
    const result = executeEditPlan(plan, source);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    state = projectReducer(state, { nextProject: result.project, type: 'APPLY_EAL' });
    expect(state.present.clips[0].timelineStart).toBeCloseTo(5, 3);
    expect(state.past).toHaveLength(1);
    expect(state.past[0].clips[0].timelineStart).toBeCloseTo(0, 3);

    state = projectReducer(state, { type: 'UNDO' });
    expect(state.present.clips[0].timelineStart).toBeCloseTo(0, 3);
    expect(state.future).toHaveLength(1);
  });
});
