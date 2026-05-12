import { describe, expect, it } from 'vitest';
import {
  collectSnapTargets,
  createInitialProject,
  getActiveTextOverlays,
  getClipAtTime,
  getClipDuration,
  getFirstClipByTimelineOrder,
  getNextClipAfter,
  getProjectDuration,
  idleJobStatus,
  projectReducer,
  snapToTarget,
  type ProjectAsset,
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

  it('moves a text overlay to another text track when UPDATE_TEXT includes trackId', () => {
    let state = createInitialProject();
    state = projectReducer(state, { assets: [asset('a', 10)], type: 'ADD_ASSETS' });
    state = projectReducer(state, { assetId: 'a', clipId: 'clip-a', type: 'ADD_ASSET_TO_TIMELINE' });
    state = projectReducer(state, {
      overlay: { align: 'center', end: 4, id: 'text-1', size: 32, start: 1, text: 'Hi', trackId: 'text-1', x: 0.5, y: 0.2 },
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
        align: 'center',
        end: 5,
        id: 'text-a',
        size: 42,
        start: 1,
        text: 'Title',
        trackId: 'text-1',
        x: 0.5,
        y: 0.2,
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
        align: 'center',
        end: 3,
        id: 'text-a',
        size: 32,
        start: 0,
        text: 'Hi',
        trackId: 'text-1',
        x: 0.5,
        y: 0.2,
      },
      type: 'ADD_TEXT',
    });

    expect(getActiveTextOverlays(state.present, 1).map((o) => o.id)).toEqual(['text-a']);

    state = projectReducer(state, { patch: { visible: false }, trackId: 'text-1', type: 'UPDATE_TRACK' });

    expect(getActiveTextOverlays(state.present, 1)).toEqual([]);
  });
});
