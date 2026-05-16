import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEXT_OVERLAY,
  clampClipMask,
  collectSnapTargets,
  createInitialProject,
  getActiveTextOverlays,
  getClipAtTime,
  getClipDuration,
  getFirstClipByTimelineOrder,
  getNextClipAfter,
  getProjectDuration,
  idleJobStatus,
  isTextOverlayActiveAt,
  projectReducer,
  snapToTarget,
  type ProjectAsset,
  type TextOverlay,
} from './projectModel';

function asset(id: string, duration: number): ProjectAsset {
  return {
    duration,
    file: new File(['video'], `${id}.mp4`, { type: 'video/mp4' }),
    height: 1080,
    id,
    kind: 'video',
    name: `${id}.mp4`,
    originalUrl: `blob:${id}`,
    playbackUrl: `blob:${id}`,
    posterUrl: null,
    proxyStatus: idleJobStatus,
    proxyUrl: null,
    size: 5,
    type: 'video/mp4',
    width: 1920,
  };
}

function audioAsset(id: string, duration: number): ProjectAsset {
  return {
    duration,
    file: new File(['audio'], `${id}.mp3`, { type: 'audio/mpeg' }),
    height: 0,
    id,
    kind: 'audio',
    name: `${id}.mp3`,
    originalUrl: `blob:${id}`,
    playbackUrl: `blob:${id}`,
    posterUrl: null,
    proxyStatus: idleJobStatus,
    proxyUrl: null,
    size: 5,
    type: 'audio/mpeg',
    width: 0,
  };
}

function projectWithTwoClips() {
  let state = createInitialProject();
  state = projectReducer(state, { assets: [asset('a', 10), asset('b', 5)], type: 'ADD_ASSETS' });
  state = projectReducer(state, { assetId: 'a', clipId: 'clip-a', type: 'ADD_ASSET_TO_TIMELINE' });
  state = projectReducer(state, { assetId: 'b', clipId: 'clip-b', type: 'ADD_ASSET_TO_TIMELINE' });

  return state;
}

describe('project model', () => {
  it('derives project duration from ordered clip durations', () => {
    const state = projectWithTwoClips();

    expect(getProjectDuration(state.present)).toBe(15);
  });

  it('splits the active clip at the playhead', () => {
    let state = projectWithTwoClips();
    state = projectReducer(state, { newClipId: 'clip-a-right', playhead: 4, type: 'SPLIT_CLIP' });

    expect(state.present.clips.map((clip) => [clip.id, clip.timelineStart, clip.sourceIn, clip.sourceOut])).toEqual([
      ['clip-a', 0, 0, 4],
      ['clip-a-right', 4, 4, 10],
      ['clip-b', 10, 0, 5],
    ]);
    expect(getProjectDuration(state.present)).toBe(15);
  });

  it('splits the targeted clip when SPLIT_CLIP has a clipId, even if a video clip overlaps the playhead', () => {
    let state = createInitialProject();
    const videoTrackId = state.present.tracks.find((track) => track.kind === 'video')!.id;
    state = projectReducer(state, {
      track: { id: 'audio-1', index: 0, kind: 'audio', locked: false, muted: false, name: 'Audio 1', visible: true },
      type: 'ADD_TRACK',
    });
    state = projectReducer(state, { assets: [asset('v', 10), audioAsset('a', 10)], type: 'ADD_ASSETS' });
    state = projectReducer(state, { assetId: 'v', clipId: 'clip-v', timelineStart: 0, trackId: videoTrackId, type: 'ADD_ASSET_TO_TIMELINE' });
    state = projectReducer(state, { assetId: 'a', clipId: 'clip-a', timelineStart: 0, trackId: 'audio-1', type: 'ADD_ASSET_TO_TIMELINE' });

    state = projectReducer(state, { clipId: 'clip-a', newClipId: 'clip-a-right', playhead: 4, type: 'SPLIT_CLIP' });

    expect(state.present.clips.filter((c) => c.trackId === 'audio-1').map((c) => [c.id, c.sourceIn, c.sourceOut])).toEqual([
      ['clip-a', 0, 4],
      ['clip-a-right', 4, 10],
    ]);
    expect(state.present.clips.filter((c) => c.trackId !== 'audio-1').map((c) => c.id)).toEqual(['clip-v']);
  });

  it('does nothing when SPLIT_CLIP clipId is set but the playhead is outside that clip', () => {
    let state = projectWithTwoClips();
    const before = state.present.clips;
    state = projectReducer(state, { clipId: 'clip-a', newClipId: 'clip-a-right', playhead: 50, type: 'SPLIT_CLIP' });
    expect(state.present.clips).toBe(before);
  });

  it('prevents text overlays on the same track from overlapping when moved', () => {
    let state = createInitialProject();
    state = projectReducer(state, { assets: [asset('a', 30)], type: 'ADD_ASSETS' });
    state = projectReducer(state, { assetId: 'a', clipId: 'clip-a', type: 'ADD_ASSET_TO_TIMELINE' });
    state = projectReducer(state, {
      overlay: { ...DEFAULT_TEXT_OVERLAY, end: 4, id: 't-1', start: 0, text: 'First', trackId: 'text-1' },
      type: 'ADD_TEXT',
    });
    state = projectReducer(state, {
      overlay: { ...DEFAULT_TEXT_OVERLAY, end: 10, id: 't-2', start: 6, text: 'Second', trackId: 'text-1' },
      type: 'ADD_TEXT',
    });

    // Try to drag t-2 onto t-1's range. Expect it to snap immediately after t-1.
    state = projectReducer(state, { patch: { end: 5, start: 1 }, textId: 't-2', type: 'UPDATE_TEXT' });
    const moved = state.present.textOverlays.find((overlay) => overlay.id === 't-2')!;
    expect(moved.start).toBeGreaterThanOrEqual(4);
    expect(moved.end - moved.start).toBeCloseTo(4, 3);
  });

  it('snaps ADD_TEXT into a free slot when the requested range collides with another overlay', () => {
    let state = createInitialProject();
    state = projectReducer(state, { assets: [asset('a', 30)], type: 'ADD_ASSETS' });
    state = projectReducer(state, { assetId: 'a', clipId: 'clip-a', type: 'ADD_ASSET_TO_TIMELINE' });
    state = projectReducer(state, {
      overlay: { ...DEFAULT_TEXT_OVERLAY, end: 4, id: 't-1', start: 1, text: 'First', trackId: 'text-1' },
      type: 'ADD_TEXT',
    });
    // Add a second overlay overlapping the first.
    state = projectReducer(state, {
      overlay: { ...DEFAULT_TEXT_OVERLAY, end: 5, id: 't-2', start: 2, text: 'Second', trackId: 'text-1' },
      type: 'ADD_TEXT',
    });
    const placed = state.present.textOverlays.find((overlay) => overlay.id === 't-2')!;
    expect(placed.start).toBeGreaterThanOrEqual(4);
  });

  it('REPLACE_TEXTS_IN_RANGE places cues at exact times and wipes prior cues inside the range', () => {
    let state = createInitialProject();
    state = projectReducer(state, { assets: [asset('a', 60)], type: 'ADD_ASSETS' });
    state = projectReducer(state, { assetId: 'a', clipId: 'clip-a', timelineStart: 5, type: 'ADD_ASSET_TO_TIMELINE' });
    // Pre-existing cues: one inside the target range, one before it, one after.
    state = projectReducer(state, {
      overlay: { ...DEFAULT_TEXT_OVERLAY, end: 4, id: 'before', start: 1, text: 'before', trackId: 'text-1' },
      type: 'ADD_TEXT',
    });
    state = projectReducer(state, {
      overlay: { ...DEFAULT_TEXT_OVERLAY, end: 9, id: 'inside-old', start: 7, text: 'old', trackId: 'text-1' },
      type: 'ADD_TEXT',
    });
    state = projectReducer(state, {
      overlay: { ...DEFAULT_TEXT_OVERLAY, end: 22, id: 'after', start: 20, text: 'after', trackId: 'text-1' },
      type: 'ADD_TEXT',
    });

    const cues = [
      { ...DEFAULT_TEXT_OVERLAY, end: 6, id: 'c-1', start: 5, text: 'one', trackId: 'text-1' },
      { ...DEFAULT_TEXT_OVERLAY, end: 8, id: 'c-2', start: 6, text: 'two', trackId: 'text-1' },
      { ...DEFAULT_TEXT_OVERLAY, end: 12, id: 'c-3', start: 8, text: 'three', trackId: 'text-1' },
    ];
    state = projectReducer(state, {
      overlays: cues,
      rangeEnd: 15,
      rangeStart: 5,
      trackId: 'text-1',
      type: 'REPLACE_TEXTS_IN_RANGE',
    });

    const ids = state.present.textOverlays.map((o) => o.id).sort();
    // 'before' and 'after' survive; 'inside-old' is wiped; new cues are in.
    expect(ids).toEqual(['after', 'before', 'c-1', 'c-2', 'c-3']);
    // Exact times preserved — no overlap-push.
    const c1 = state.present.textOverlays.find((o) => o.id === 'c-1')!;
    const c2 = state.present.textOverlays.find((o) => o.id === 'c-2')!;
    const c3 = state.present.textOverlays.find((o) => o.id === 'c-3')!;
    expect(c1.start).toBe(5);
    expect(c2.start).toBe(6);
    expect(c3.start).toBe(8);
  });

  it('REPLACE_TEXTS_IN_RANGE creates a text track when none exists', () => {
    let state = createInitialProject();
    state = projectReducer(state, { assets: [asset('a', 30)], type: 'ADD_ASSETS' });
    state = projectReducer(state, { assetId: 'a', clipId: 'clip-a', type: 'ADD_ASSET_TO_TIMELINE' });
    const before = state.present.tracks.filter((t) => t.kind === 'text').length;
    state = projectReducer(state, {
      overlays: [{ ...DEFAULT_TEXT_OVERLAY, end: 2, id: 'c-1', start: 1, text: 'hi', trackId: 'missing-track' }],
      rangeEnd: 5,
      rangeStart: 0,
      trackId: 'missing-track',
      type: 'REPLACE_TEXTS_IN_RANGE',
    });
    expect(state.present.tracks.filter((t) => t.kind === 'text').length).toBeGreaterThan(before);
    expect(state.present.textOverlays).toHaveLength(1);
    expect(state.present.textOverlays[0].start).toBe(1);
  });

  it('clamps a trim-only end edit so the overlay cannot expand into a neighbour', () => {
    let state = createInitialProject();
    state = projectReducer(state, { assets: [asset('a', 30)], type: 'ADD_ASSETS' });
    state = projectReducer(state, { assetId: 'a', clipId: 'clip-a', type: 'ADD_ASSET_TO_TIMELINE' });
    state = projectReducer(state, {
      overlay: { ...DEFAULT_TEXT_OVERLAY, end: 3, id: 't-1', start: 1, text: 'Left', trackId: 'text-1' },
      type: 'ADD_TEXT',
    });
    state = projectReducer(state, {
      overlay: { ...DEFAULT_TEXT_OVERLAY, end: 8, id: 't-2', start: 5, text: 'Right', trackId: 'text-1' },
      type: 'ADD_TEXT',
    });
    // Try to extend t-1 past t-2's start. Should clip to neighbour's start.
    state = projectReducer(state, { patch: { end: 7 }, textId: 't-1', type: 'UPDATE_TEXT' });
    const trimmed = state.present.textOverlays.find((overlay) => overlay.id === 't-1')!;
    expect(trimmed.end).toBeLessThanOrEqual(5);
  });

  it('moves a text overlay to another text track when UPDATE_TEXT includes trackId', () => {
    let state = createInitialProject();
    state = projectReducer(state, { assets: [asset('a', 10)], type: 'ADD_ASSETS' });
    state = projectReducer(state, { assetId: 'a', clipId: 'clip-a', type: 'ADD_ASSET_TO_TIMELINE' });
    state = projectReducer(state, {
      overlay: { ...DEFAULT_TEXT_OVERLAY, end: 4, id: 'text-1', size: 32, start: 1, text: 'Hi', trackId: 'text-1' },
      type: 'ADD_TEXT',
    });
    state = projectReducer(state, {
      track: { id: 'text-2', index: 1, kind: 'text', locked: false, muted: false, name: 'Text 2', visible: true },
      type: 'ADD_TRACK',
    });

    state = projectReducer(state, { patch: { trackId: 'text-2' }, textId: 'text-1', type: 'UPDATE_TEXT' });

    expect(state.present.textOverlays[0].trackId).toBe('text-2');
  });

  it('splits selected timeline text without splitting the active clip', () => {
    let state = projectWithTwoClips();
    state = projectReducer(state, {
      overlay: {
        ...DEFAULT_TEXT_OVERLAY,
        end: 5,
        id: 'text-a',
        size: 42,
        start: 1,
        text: 'Title',
        trackId: 'text-1',
      },
      type: 'ADD_TEXT',
    });
    state = projectReducer(state, { newTextId: 'text-b', playhead: 3, textId: 'text-a', type: 'SPLIT_TEXT' });

    expect(state.present.textOverlays.map((overlay) => [overlay.id, overlay.start, overlay.end])).toEqual([
      ['text-a', 1, 3],
      ['text-b', 3, 5],
    ]);
    expect(state.present.clips.map((clip) => [clip.id, clip.sourceIn, clip.sourceOut])).toEqual([
      ['clip-a', 0, 10],
      ['clip-b', 0, 5],
    ]);
    expect(state.present.selectedClipId).toBeNull();
    expect(state.present.selectedTextId).toBe('text-b');
  });

  it('clamps trim operations to a minimum clip duration', () => {
    let state = projectWithTwoClips();
    state = projectReducer(state, { clipId: 'clip-a', edge: 'end', sourceTime: 0.01, type: 'TRIM_CLIP' });

    const clip = state.present.clips[0];
    expect(getClipDuration(clip)).toBeCloseTo(0.1);
  });

  it('moves clips by timeline start (to a non-overlapping position)', () => {
    let state = projectWithTwoClips();
    state = projectReducer(state, { clipId: 'clip-b', timelineStart: 12, type: 'MOVE_CLIP' });

    expect(state.present.clips.find((clip) => clip.id === 'clip-b')?.timelineStart).toBe(12);
  });

  it('deletes the selected clip and ripples later clips on that track', () => {
    let state = projectWithTwoClips();
    state = projectReducer(state, { clipId: 'clip-a', type: 'SELECT_CLIP' });
    state = projectReducer(state, { type: 'DELETE_SELECTED' });

    expect(state.present.clips.map((clip) => clip.id)).toEqual(['clip-b']);
    expect(state.present.clips[0].timelineStart).toBe(0);
    expect(state.present.selectedClipId).toBeNull();
  });

  it('deletes an asset from the media library and removes dependent clips', () => {
    let state = projectWithTwoClips();
    state = projectReducer(state, { clipId: 'clip-a', type: 'SELECT_CLIP' });
    state = projectReducer(state, { assetId: 'a', type: 'DELETE_ASSET' });

    expect(state.present.assets.map((candidate) => candidate.id)).toEqual(['b']);
    expect(state.present.clips.map((clip) => clip.id)).toEqual(['clip-b']);
    expect(state.present.clips[0].timelineStart).toBe(0);
    expect(state.present.selectedClipId).toBeNull();
  });

  it('supports undo and redo for edit operations', () => {
    let state = projectWithTwoClips();
    state = projectReducer(state, { clipId: 'clip-b', timelineStart: 12, type: 'MOVE_CLIP' });

    expect(state.present.clips.find((clip) => clip.id === 'clip-b')?.timelineStart).toBe(12);

    state = projectReducer(state, { type: 'UNDO' });
    expect(state.present.clips.find((clip) => clip.id === 'clip-b')?.timelineStart).toBe(10);

    state = projectReducer(state, { type: 'REDO' });
    expect(state.present.clips.find((clip) => clip.id === 'clip-b')?.timelineStart).toBe(12);
  });

  it('looks up the active clip from a global timeline time', () => {
    const state = projectWithTwoClips();
    const active = getClipAtTime(state.present, 12);

    expect(active?.clip.id).toBe('clip-b');
    expect(active?.localTime).toBe(2);
  });

  it('ripples downstream clips correctly when deleting an asset with multiple clips on one track', () => {
    let state = createInitialProject();
    state = projectReducer(state, { assets: [asset('a', 4), asset('b', 6)], type: 'ADD_ASSETS' });
    state = projectReducer(state, { assetId: 'a', clipId: 'clip-a1', type: 'ADD_ASSET_TO_TIMELINE' });
    state = projectReducer(state, { assetId: 'b', clipId: 'clip-b', type: 'ADD_ASSET_TO_TIMELINE' });
    state = projectReducer(state, { assetId: 'a', clipId: 'clip-a2', type: 'ADD_ASSET_TO_TIMELINE' });

    expect(state.present.clips.map((clip) => [clip.id, clip.timelineStart])).toEqual([
      ['clip-a1', 0],
      ['clip-b', 4],
      ['clip-a2', 10],
    ]);

    state = projectReducer(state, { assetId: 'a', type: 'DELETE_ASSET' });

    expect(state.present.clips.map((clip) => [clip.id, clip.timelineStart])).toEqual([['clip-b', 0]]);
  });

  it('snaps a dropped clip to the next free slot when the requested position overlaps', () => {
    let state = createInitialProject();
    state = projectReducer(state, { assets: [asset('a', 10), asset('b', 4)], type: 'ADD_ASSETS' });
    state = projectReducer(state, { assetId: 'a', clipId: 'clip-a', type: 'ADD_ASSET_TO_TIMELINE' });

    // clip-a occupies [0, 10] on video-1. Dropping clip-b at t=3 should land it at t=10.
    state = projectReducer(state, { assetId: 'b', clipId: 'clip-b', timelineStart: 3, type: 'ADD_ASSET_TO_TIMELINE' });

    expect(state.present.clips.map((clip) => [clip.id, clip.timelineStart])).toEqual([
      ['clip-a', 0],
      ['clip-b', 10],
    ]);
  });

  it('snaps a moved clip past the conflicting clip on the same track', () => {
    let state = createInitialProject();
    state = projectReducer(state, { assets: [asset('a', 10), asset('b', 4)], type: 'ADD_ASSETS' });
    state = projectReducer(state, { assetId: 'a', clipId: 'clip-a', type: 'ADD_ASSET_TO_TIMELINE' });
    state = projectReducer(state, { assetId: 'b', clipId: 'clip-b', type: 'ADD_ASSET_TO_TIMELINE' });

    // clip-a [0, 10], clip-b [10, 14]. Try to move clip-b to t=4 — should snap to t=10.
    state = projectReducer(state, { clipId: 'clip-b', timelineStart: 4, type: 'MOVE_CLIP' });

    expect(state.present.clips.find((clip) => clip.id === 'clip-b')?.timelineStart).toBe(10);
  });

  it('finds the earliest clip even when the timeline has a leading gap', () => {
    let state = createInitialProject();
    state = projectReducer(state, { assets: [asset('a', 10)], type: 'ADD_ASSETS' });
    state = projectReducer(state, { assetId: 'a', clipId: 'clip-a', timelineStart: 3, type: 'ADD_ASSET_TO_TIMELINE' });

    expect(getFirstClipByTimelineOrder(state.present)?.id).toBe('clip-a');
    expect(getFirstClipByTimelineOrder(state.present)?.timelineStart).toBe(3);
  });

  it('refuses to delete the only video track', () => {
    let state = createInitialProject();
    const onlyTrackId = state.present.tracks[0].id;
    state = projectReducer(state, { trackId: onlyTrackId, type: 'DELETE_TRACK' });

    expect(state.present.tracks.map((track) => track.id)).toEqual([onlyTrackId]);
  });

  it('deletes a video track when another video track remains, ripple-removing its clips', () => {
    let state = createInitialProject();
    const firstTrackId = state.present.tracks[0].id;
    state = projectReducer(state, {
      track: { id: 'video-2', index: 1, kind: 'video', locked: false, muted: false, name: 'Video 2', visible: true },
      type: 'ADD_TRACK',
    });
    state = projectReducer(state, { assets: [asset('a', 5)], type: 'ADD_ASSETS' });
    state = projectReducer(state, {
      assetId: 'a',
      clipId: 'clip-on-second',
      trackId: 'video-2',
      type: 'ADD_ASSET_TO_TIMELINE',
    });
    state = projectReducer(state, { trackId: 'video-2', type: 'SELECT_TRACK' });
    expect(state.present.selectedTrackId).toBe('video-2');

    state = projectReducer(state, { trackId: 'video-2', type: 'DELETE_TRACK' });

    expect(state.present.tracks.map((track) => track.id)).toEqual([firstTrackId]);
    expect(state.present.clips).toEqual([]);
    expect(state.present.selectedTrackId).toBe(firstTrackId);
  });

  it('deletes an audio track regardless of whether other audio tracks remain', () => {
    let state = createInitialProject();
    state = projectReducer(state, {
      track: { id: 'audio-1', index: 0, kind: 'audio', locked: false, muted: false, name: 'Audio 1', visible: true },
      type: 'ADD_TRACK',
    });

    state = projectReducer(state, { trackId: 'audio-1', type: 'DELETE_TRACK' });

    expect(state.present.tracks.some((track) => track.id === 'audio-1')).toBe(false);
  });

  it('finds the next clip after a gap and returns null past the end', () => {
    let state = createInitialProject();
    state = projectReducer(state, { assets: [asset('a', 4), asset('b', 4)], type: 'ADD_ASSETS' });
    state = projectReducer(state, { assetId: 'a', clipId: 'clip-a', type: 'ADD_ASSET_TO_TIMELINE' });
    state = projectReducer(state, { assetId: 'b', clipId: 'clip-b', timelineStart: 10, type: 'ADD_ASSET_TO_TIMELINE' });

    expect(getNextClipAfter(state.present, 4)?.id).toBe('clip-b');
    expect(getNextClipAfter(state.present, 100)).toBeNull();
  });

  it('collects snap targets from clip and overlay edges plus optional playhead', () => {
    let state = createInitialProject();
    state = projectReducer(state, { assets: [asset('a', 4), asset('b', 5)], type: 'ADD_ASSETS' });
    state = projectReducer(state, { assetId: 'a', clipId: 'clip-a', type: 'ADD_ASSET_TO_TIMELINE' });
    state = projectReducer(state, { assetId: 'b', clipId: 'clip-b', type: 'ADD_ASSET_TO_TIMELINE' });

    const targets = collectSnapTargets(state.present, { includePlayhead: 2.5 });

    expect(targets).toContain(0);
    expect(targets).toContain(4); // clip-a end / clip-b start
    expect(targets).toContain(9); // clip-b end
    expect(targets).toContain(2.5);

    const without = collectSnapTargets(state.present, { excludeClipId: 'clip-b' });
    expect(without).not.toContain(9);
  });

  it('snaps to the nearest target within tolerance and otherwise leaves the value alone', () => {
    const targets = [0, 4, 9];

    expect(snapToTarget(4.05, targets, 0.1)).toEqual({ target: 4, value: 4 });
    expect(snapToTarget(4.08, targets, 0.05)).toEqual({ target: null, value: 4.08 });

    // Prefers the closer target when two are in range.
    expect(snapToTarget(4.2, [4, 4.3], 0.5)).toEqual({ target: 4.3, value: 4.3 });
  });

  it('hides text overlays on text tracks that are not visible', () => {
    let state = createInitialProject();
    state = projectReducer(state, { assets: [asset('a', 10)], type: 'ADD_ASSETS' });
    state = projectReducer(state, { assetId: 'a', clipId: 'clip-a', type: 'ADD_ASSET_TO_TIMELINE' });
    state = projectReducer(state, {
      overlay: {
        ...DEFAULT_TEXT_OVERLAY,
        end: 3,
        id: 'text-a',
        size: 32,
        start: 0,
        text: 'Hi',
        trackId: 'text-1',
      },
      type: 'ADD_TEXT',
    });

    expect(getActiveTextOverlays(state.present, 1).map((o) => o.id)).toEqual(['text-a']);

    state = projectReducer(state, { patch: { visible: false }, trackId: 'text-1', type: 'UPDATE_TRACK' });

    expect(getActiveTextOverlays(state.present, 1)).toEqual([]);
  });
});

describe('active text overlay boundary (half-open)', () => {
  const overlay = (id: string, start: number, end: number): TextOverlay => ({
    ...DEFAULT_TEXT_OVERLAY,
    end,
    id,
    start,
    text: id,
    trackId: 'text-1',
  });

  it('renders a cue when playhead is at start', () => {
    expect(isTextOverlayActiveAt(overlay('a', 1, 2), 1)).toBe(true);
  });

  it('renders a cue strictly before end', () => {
    expect(isTextOverlayActiveAt(overlay('a', 1, 2), 1.999)).toBe(true);
  });

  it('does NOT render a cue when playhead is exactly at end', () => {
    expect(isTextOverlayActiveAt(overlay('a', 1, 2), 2)).toBe(false);
  });

  it('does not render before start', () => {
    expect(isTextOverlayActiveAt(overlay('a', 1, 2), 0.999)).toBe(false);
  });

  it('two adjacent cues sharing a boundary never both render', () => {
    const a = overlay('a', 0, 2);
    const b = overlay('b', 2, 4);
    for (const t of [1.999, 2.0, 2.001]) {
      const both = isTextOverlayActiveAt(a, t) && isTextOverlayActiveAt(b, t);
      expect(both).toBe(false);
    }
    expect(isTextOverlayActiveAt(a, 1.999)).toBe(true);
    expect(isTextOverlayActiveAt(b, 2)).toBe(true);
  });

  it('keeps the final cue visible when playhead reaches timeline end', () => {
    const last = overlay('last', 8, 10);
    expect(isTextOverlayActiveAt(last, 10)).toBe(false);
    // With timelineEnd provided and matching the cue end, the cue stays on.
    expect(isTextOverlayActiveAt(last, 10, 10)).toBe(true);
  });

  it('does not keep a cue visible just because timelineEnd is supplied', () => {
    const mid = overlay('mid', 4, 6);
    // The cue ends well before the timeline end; half-open still wins.
    expect(isTextOverlayActiveAt(mid, 6, 10)).toBe(false);
  });
});

describe('REPLACE_TEXTS_IN_RANGE preserves non-overlapping cues', () => {
  it('does not append duplicates when re-running on the same range', () => {
    let state = createInitialProject();
    state = projectReducer(state, { assets: [asset('a', 60)], type: 'ADD_ASSETS' });
    state = projectReducer(state, { assetId: 'a', clipId: 'clip-a', type: 'ADD_ASSET_TO_TIMELINE' });

    const cuesA = [
      { ...DEFAULT_TEXT_OVERLAY, end: 2, id: 'c-1', start: 0, text: 'one', trackId: 'text-1' },
      { ...DEFAULT_TEXT_OVERLAY, end: 4, id: 'c-2', start: 2, text: 'two', trackId: 'text-1' },
    ];
    state = projectReducer(state, {
      overlays: cuesA,
      rangeEnd: 5,
      rangeStart: 0,
      trackId: 'text-1',
      type: 'REPLACE_TEXTS_IN_RANGE',
    });
    expect(state.present.textOverlays).toHaveLength(2);

    // Re-run with a different set — must REPLACE, not append.
    const cuesB = [
      { ...DEFAULT_TEXT_OVERLAY, end: 1, id: 'd-1', start: 0, text: 'one-b', trackId: 'text-1' },
      { ...DEFAULT_TEXT_OVERLAY, end: 3, id: 'd-2', start: 1, text: 'two-b', trackId: 'text-1' },
      { ...DEFAULT_TEXT_OVERLAY, end: 5, id: 'd-3', start: 3, text: 'three-b', trackId: 'text-1' },
    ];
    state = projectReducer(state, {
      overlays: cuesB,
      rangeEnd: 5,
      rangeStart: 0,
      trackId: 'text-1',
      type: 'REPLACE_TEXTS_IN_RANGE',
    });

    const ids = state.present.textOverlays.map((o) => o.id).sort();
    expect(ids).toEqual(['d-1', 'd-2', 'd-3']);
    // c-1, c-2 are gone; new cues placed at exact computed times.
    expect(state.present.textOverlays.find((o) => o.id === 'd-1')!.start).toBe(0);
    expect(state.present.textOverlays.find((o) => o.id === 'd-2')!.start).toBe(1);
    expect(state.present.textOverlays.find((o) => o.id === 'd-3')!.start).toBe(3);
  });
});

describe('SHIFT_TEXTS_BY', () => {
  it('shifts every selected overlay by the same delta', () => {
    let state = createInitialProject();
    state = projectReducer(state, { assets: [asset('a', 60)], type: 'ADD_ASSETS' });
    state = projectReducer(state, { assetId: 'a', clipId: 'clip-a', type: 'ADD_ASSET_TO_TIMELINE' });
    state = projectReducer(state, {
      overlays: [
        { ...DEFAULT_TEXT_OVERLAY, end: 4, id: 't-1', start: 2, text: 'one', trackId: 'text-1' },
        { ...DEFAULT_TEXT_OVERLAY, end: 8, id: 't-2', start: 6, text: 'two', trackId: 'text-1' },
      ],
      rangeEnd: 10,
      rangeStart: 0,
      trackId: 'text-1',
      type: 'REPLACE_TEXTS_IN_RANGE',
    });

    state = projectReducer(state, { delta: 1.5, textIds: ['t-1', 't-2'], type: 'SHIFT_TEXTS_BY' });
    const t1 = state.present.textOverlays.find((o) => o.id === 't-1')!;
    const t2 = state.present.textOverlays.find((o) => o.id === 't-2')!;
    expect(t1.start).toBeCloseTo(3.5, 5);
    expect(t1.end).toBeCloseTo(5.5, 5);
    expect(t2.start).toBeCloseTo(7.5, 5);
    expect(t2.end).toBeCloseTo(9.5, 5);
  });

  it('clamps the group so no cue goes negative on a left shift', () => {
    let state = createInitialProject();
    state = projectReducer(state, { assets: [asset('a', 60)], type: 'ADD_ASSETS' });
    state = projectReducer(state, { assetId: 'a', clipId: 'clip-a', type: 'ADD_ASSET_TO_TIMELINE' });
    state = projectReducer(state, {
      overlays: [
        { ...DEFAULT_TEXT_OVERLAY, end: 2, id: 't-1', start: 1, text: 'a', trackId: 'text-1' },
        { ...DEFAULT_TEXT_OVERLAY, end: 8, id: 't-2', start: 6, text: 'b', trackId: 'text-1' },
      ],
      rangeEnd: 10,
      rangeStart: 0,
      trackId: 'text-1',
      type: 'REPLACE_TEXTS_IN_RANGE',
    });

    // Asked for -5s; the smallest start is 1, so the whole group shifts by -1.
    state = projectReducer(state, { delta: -5, textIds: ['t-1', 't-2'], type: 'SHIFT_TEXTS_BY' });
    const t1 = state.present.textOverlays.find((o) => o.id === 't-1')!;
    const t2 = state.present.textOverlays.find((o) => o.id === 't-2')!;
    expect(t1.start).toBeCloseTo(0, 5);
    expect(t1.end).toBeCloseTo(1, 5);
    expect(t2.start).toBeCloseTo(5, 5);
    expect(t2.end).toBeCloseTo(7, 5);
  });

  it('only shifts overlays in the targeted list', () => {
    let state = createInitialProject();
    state = projectReducer(state, { assets: [asset('a', 60)], type: 'ADD_ASSETS' });
    state = projectReducer(state, { assetId: 'a', clipId: 'clip-a', type: 'ADD_ASSET_TO_TIMELINE' });
    state = projectReducer(state, {
      overlays: [
        { ...DEFAULT_TEXT_OVERLAY, end: 2, id: 't-1', start: 1, text: 'a', trackId: 'text-1' },
        { ...DEFAULT_TEXT_OVERLAY, end: 8, id: 't-2', start: 6, text: 'b', trackId: 'text-1' },
      ],
      rangeEnd: 10,
      rangeStart: 0,
      trackId: 'text-1',
      type: 'REPLACE_TEXTS_IN_RANGE',
    });

    state = projectReducer(state, { delta: 2, textIds: ['t-2'], type: 'SHIFT_TEXTS_BY' });
    const t1 = state.present.textOverlays.find((o) => o.id === 't-1')!;
    const t2 = state.present.textOverlays.find((o) => o.id === 't-2')!;
    expect(t1.start).toBeCloseTo(1, 5);
    expect(t2.start).toBeCloseTo(8, 5);
  });

  it('broadcasting a style patch applies it to every overlay', () => {
    // The "Select All Text" UI dispatches one UPDATE_TEXT per overlay. This
    // test exercises the reducer side of that fan-out — every overlay should
    // pick up the new style without any timing or trackId being touched.
    let state = createInitialProject();
    state = projectReducer(state, { assets: [asset('a', 60)], type: 'ADD_ASSETS' });
    state = projectReducer(state, { assetId: 'a', clipId: 'clip-a', type: 'ADD_ASSET_TO_TIMELINE' });
    state = projectReducer(state, {
      overlays: [
        { ...DEFAULT_TEXT_OVERLAY, color: '#ffffffff', end: 2, id: 't-1', start: 0, text: 'one', trackId: 'text-1' },
        { ...DEFAULT_TEXT_OVERLAY, color: '#ffffffff', end: 5, id: 't-2', start: 3, text: 'two', trackId: 'text-1' },
        { ...DEFAULT_TEXT_OVERLAY, color: '#ffffffff', end: 8, id: 't-3', start: 6, text: 'three', trackId: 'text-1' },
      ],
      rangeEnd: 10,
      rangeStart: 0,
      trackId: 'text-1',
      type: 'REPLACE_TEXTS_IN_RANGE',
    });

    const ids = ['t-1', 't-2', 't-3'];
    for (const id of ids) {
      state = projectReducer(state, { patch: { color: '#ff8800ff', size: 96 }, textId: id, type: 'UPDATE_TEXT' });
    }
    for (const id of ids) {
      const o = state.present.textOverlays.find((x) => x.id === id)!;
      expect(o.color).toBe('#ff8800ff');
      expect(o.size).toBe(96);
    }
    // Timing unchanged.
    expect(state.present.textOverlays.find((o) => o.id === 't-1')!.start).toBe(0);
    expect(state.present.textOverlays.find((o) => o.id === 't-2')!.start).toBe(3);
    expect(state.present.textOverlays.find((o) => o.id === 't-3')!.start).toBe(6);
  });

  it('is a no-op when delta is 0 or textIds is empty', () => {
    let state = createInitialProject();
    state = projectReducer(state, { assets: [asset('a', 60)], type: 'ADD_ASSETS' });
    state = projectReducer(state, { assetId: 'a', clipId: 'clip-a', type: 'ADD_ASSET_TO_TIMELINE' });
    state = projectReducer(state, {
      overlays: [{ ...DEFAULT_TEXT_OVERLAY, end: 2, id: 't-1', start: 1, text: 'a', trackId: 'text-1' }],
      rangeEnd: 5,
      rangeStart: 0,
      trackId: 'text-1',
      type: 'REPLACE_TEXTS_IN_RANGE',
    });
    const before = state.present.textOverlays;
    expect(projectReducer(state, { delta: 0, textIds: ['t-1'], type: 'SHIFT_TEXTS_BY' }).present.textOverlays).toBe(before);
    expect(projectReducer(state, { delta: 1, textIds: [], type: 'SHIFT_TEXTS_BY' }).present.textOverlays).toBe(before);
  });
});

describe('clip mask', () => {
  it('clampClipMask normalizes and rejects invalid input', () => {
    expect(clampClipMask(null)).toBeNull();
    expect(clampClipMask({})).toBeNull(); // no maskKey → no mask
    expect(clampClipMask({ maskKey: 'k' })).toEqual({
      enabled: true,
      feather: 0,
      invert: false,
      maskKey: 'k',
      mode: 'spotlight', // unknown/missing mode defaults to spotlight
    });
    expect(
      clampClipMask({ enabled: false, feather: 5, invert: 1, maskKey: 'k', mode: 'cutout' }),
    ).toEqual({ enabled: false, feather: 1, invert: true, maskKey: 'k', mode: 'cutout' });
    expect(clampClipMask({ feather: -3, maskKey: 'k', mode: 'bogus' })).toMatchObject({
      feather: 0,
      mode: 'spotlight',
    });
  });

  it('UPDATE_CLIP_MASK sets and clears a clip mask', () => {
    let state = createInitialProject();
    state = projectReducer(state, { assets: [asset('a', 10)], type: 'ADD_ASSETS' });
    state = projectReducer(state, { assetId: 'a', clipId: 'clip-a', type: 'ADD_ASSET_TO_TIMELINE' });
    expect(state.present.clips[0].mask).toBeNull();

    state = projectReducer(state, {
      clipId: 'clip-a',
      mask: { enabled: true, feather: 0.5, invert: false, maskKey: 'mask:a', mode: 'blur-bg' },
      type: 'UPDATE_CLIP_MASK',
    });
    expect(state.present.clips[0].mask).toEqual({
      enabled: true,
      feather: 0.5,
      invert: false,
      maskKey: 'mask:a',
      mode: 'blur-bg',
    });

    state = projectReducer(state, { clipId: 'clip-a', mask: null, type: 'UPDATE_CLIP_MASK' });
    expect(state.present.clips[0].mask).toBeNull();
  });
});
