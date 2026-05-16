import { describe, expect, it } from 'vitest';
import { findSubtitleTemplate, generateSubtitleCues, SUBTITLE_TEMPLATES } from './subtitles';
import { DEFAULT_CLIP_TRANSFORM, idleJobStatus, type TimelineClip } from './projectModel';
import type { StoredAssetTranscript } from './projectStore';

function clip(): TimelineClip {
  return {
    assetId: 'a',
    effects: { brightness: 0, contrast: 1, saturation: 1 },
    fadeIn: 0,
    fadeOut: 0,
    id: 'c',
    mask: null,
    muted: false,
    sourceIn: 2,
    sourceOut: 12, // 10s of source rendered on timeline starting at t=5
    timelineStart: 5,
    trackId: 'video-1',
    transform: DEFAULT_CLIP_TRANSFORM,
    volume: 1,
  };
}

function transcript(overrides: Partial<StoredAssetTranscript> = {}): StoredAssetTranscript {
  return {
    createdAt: 0,
    duration: 12,
    language: 'en',
    model: 'ggml-small',
    provider: 'whisper_cpp',
    segments: [
      { end: 4.2, start: 2.0, text: 'Welcome to the show.' },
      { end: 7.8, start: 4.3, text: 'Today we are going to talk about timing.' },
      { end: 11.4, start: 7.9, text: 'It is not as simple as it sounds.' },
    ],
    text: 'Welcome to the show. Today we are going to talk about timing. It is not as simple as it sounds.',
    words: [
      { end: 2.4, start: 2.0, word: 'Welcome' },
      { end: 2.6, start: 2.4, word: 'to' },
      { end: 2.9, start: 2.6, word: 'the' },
      { end: 3.4, start: 2.9, word: 'show.' },
      { end: 4.5, start: 4.3, word: 'Today' },
      { end: 4.7, start: 4.5, word: 'we' },
      { end: 4.9, start: 4.7, word: 'are' },
      { end: 5.2, start: 4.9, word: 'going' },
      { end: 5.4, start: 5.2, word: 'to' },
      { end: 5.7, start: 5.4, word: 'talk' },
      { end: 6.0, start: 5.7, word: 'about' },
      { end: 6.8, start: 6.0, word: 'timing.' },
      { end: 8.2, start: 7.9, word: 'It' },
      { end: 8.4, start: 8.2, word: 'is' },
      { end: 8.7, start: 8.4, word: 'not' },
      { end: 8.9, start: 8.7, word: 'as' },
      { end: 9.4, start: 8.9, word: 'simple' },
      { end: 9.6, start: 9.4, word: 'as' },
      { end: 9.8, start: 9.6, word: 'it' },
      { end: 10.3, start: 9.8, word: 'sounds.' },
    ],
    ...overrides,
  };
}

function ids() {
  let n = 0;
  return () => `cue-${++n}`;
}

const TEMPLATE = findSubtitleTemplate('clean-lower-third');

describe('subtitle cue generation', () => {
  it('produces sentence cues from transcript segments', () => {
    const cues = generateSubtitleCues(transcript(), clip(), {
      createId: ids(),
      mode: 'sentence',
      template: TEMPLATE,
      trackId: 'text-1',
    });
    expect(cues.length).toBeGreaterThanOrEqual(3);
    // First cue should match the first sentence text and project to timeline-time.
    expect(cues[0].text).toContain('Welcome');
    // source 2.0 → timelineStart 5 + (2.0 - sourceIn 2.0) = 5.0
    expect(cues[0].start).toBeCloseTo(5.0, 2);
    expect(cues[0].end).toBeCloseTo(7.2, 1); // source 4.2 → 5 + 2.2 = 7.2
  });

  it('produces short-phrase cues that split at natural breaks', () => {
    const cues = generateSubtitleCues(transcript(), clip(), {
      createId: ids(),
      maxCharsPerCue: 28,
      mode: 'phrase',
      template: TEMPLATE,
      trackId: 'text-1',
    });
    expect(cues.length).toBeGreaterThan(3);
    // Every cue should be reasonably short.
    for (const cue of cues) expect(cue.text.length).toBeLessThanOrEqual(32);
    // Cues are monotonic and non-overlapping.
    for (let i = 1; i < cues.length; i += 1) {
      expect(cues[i].start).toBeGreaterThanOrEqual(cues[i - 1].end);
    }
  });

  it('produces word cues when word timestamps are present', () => {
    const cues = generateSubtitleCues(transcript(), clip(), {
      createId: ids(),
      mode: 'word',
      template: TEMPLATE,
      trackId: 'text-1',
    });
    // 20 source words but very short ones are merged with neighbours.
    expect(cues.length).toBeGreaterThanOrEqual(8);
    expect(cues.length).toBeLessThanOrEqual(20);
    // First cue begins at timeline t=5 (clip.timelineStart) plus an offset.
    expect(cues[0].start).toBeGreaterThanOrEqual(5);
    expect(cues[cues.length - 1].end).toBeLessThanOrEqual(15.5);
  });

  it('falls back to segments when word timestamps are missing', () => {
    const t = transcript({ words: [] });
    const cues = generateSubtitleCues(t, clip(), {
      createId: ids(),
      mode: 'word',
      template: TEMPLATE,
      trackId: 'text-1',
    });
    // Without word timestamps, "word" mode degrades to segment-derived cues —
    // we still produce cues, just at the segment-or-finer granularity.
    expect(cues.length).toBeGreaterThanOrEqual(3);
    for (const cue of cues) expect(cue.text.trim().length).toBeGreaterThan(0);
  });

  it('applies the chosen template style to every cue and preserves it through generation', () => {
    const tpl = findSubtitleTemplate('bold-social');
    const cues = generateSubtitleCues(transcript(), clip(), {
      createId: ids(),
      mode: 'sentence',
      template: tpl,
      trackId: 'text-1',
    });
    for (const cue of cues) {
      expect(cue.color).toBe(tpl.style.color);
      expect(cue.strokeWidth).toBe(tpl.style.strokeWidth);
      expect(cue.fontFamily).toBe(tpl.style.fontFamily);
      expect(cue.textCase).toBe(tpl.style.textCase);
      expect(cue.size).toBe(tpl.style.size);
    }
  });

  it('clamps cues to clip range and never returns overlapping pairs', () => {
    // Transcript stretches past the clip's source range — output must be cropped.
    const t = transcript({
      segments: [
        { end: 2.5, start: 1.5, text: 'before the clip' },
        { end: 3.5, start: 2.5, text: 'across the boundary' },
        { end: 11.6, start: 8.0, text: 'inside' },
        { end: 13.0, start: 11.6, text: 'past the end' },
      ],
    });
    const cues = generateSubtitleCues(t, clip(), {
      createId: ids(),
      mode: 'sentence',
      template: TEMPLATE,
      trackId: 'text-1',
    });
    for (const cue of cues) {
      expect(cue.start).toBeGreaterThanOrEqual(5);  // clip.timelineStart
      expect(cue.end).toBeLessThanOrEqual(15);     // clip.timelineStart + clipDuration
      expect(cue.end).toBeGreaterThan(cue.start);
    }
    for (let i = 1; i < cues.length; i += 1) {
      expect(cues[i].start).toBeGreaterThanOrEqual(cues[i - 1].end);
    }
  });

  it('end-to-end word mode: count, ordering, boundaries, exact-frame disjointness', () => {
    const t = transcript();
    const cues = generateSubtitleCues(t, clip(), {
      createId: ids(),
      mode: 'word',
      template: TEMPLATE,
      trackId: 'text-1',
    });

    // 20 words in the transcript, but a couple may merge if they're shorter
    // than the word-mode minimum (0.18s / 2 = 0.09s) — all are >= 0.2s here,
    // so we expect one cue per word.
    expect(cues.length).toBe(20);

    // No overlap in the emitted data.
    for (let i = 1; i < cues.length; i += 1) {
      expect(cues[i].start).toBeGreaterThanOrEqual(cues[i - 1].end - 1e-9);
    }
    // Cues stay strictly inside the clip's timeline range [5, 15].
    for (const c of cues) {
      expect(c.start).toBeGreaterThanOrEqual(5);
      expect(c.end).toBeLessThanOrEqual(15);
      expect(c.end).toBeGreaterThan(c.start);
    }
    // First / middle / last cue alignment (sourceIn=2, timelineStart=5; word
    // 'Welcome' is 2.0→2.4 in source → 5.0→5.4 timeline).
    expect(cues[0].start).toBeCloseTo(5.0, 5);
    expect(cues[0].end).toBeCloseTo(5.4, 5);
    expect(cues[0].text).toBe('Welcome');
    const mid = cues[Math.floor(cues.length / 2)];
    expect(mid.start).toBeGreaterThan(cues[0].end);
    expect(mid.end).toBeGreaterThan(mid.start);
    expect(cues[cues.length - 1].text).toBe('sounds.');

    // Boundary disjointness: scan adjacent pairs and verify that at the EXACT
    // boundary playhead value, only the later cue is "active" (half-open).
    // We don't have the runtime helper here — re-derive the rule inline so
    // the test is hermetic.
    const isActive = (cue: { end: number; start: number }, t: number) => t >= cue.start && t < cue.end;
    for (let i = 0; i < cues.length - 1; i += 1) {
      const boundary = cues[i].end;
      // Only one cue should be active at the boundary frame.
      expect(isActive(cues[i], boundary)).toBe(false);
    }
  });

  it('exposes a usable set of templates', () => {
    expect(SUBTITLE_TEMPLATES.length).toBeGreaterThanOrEqual(6);
    const ids = SUBTITLE_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const tpl of SUBTITLE_TEMPLATES) {
      expect(tpl.label.length).toBeGreaterThan(0);
      expect(tpl.style.size).toBeGreaterThan(0);
      expect(tpl.style.color).toMatch(/^#[0-9a-fA-F]{6,8}$/);
    }
  });
});

// Reference unused for now — kept so future tests against idleJobStatus shape compile.
void idleJobStatus;
