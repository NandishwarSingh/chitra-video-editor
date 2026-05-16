import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_EFFECT_SETTINGS } from './effects';
import {
  createBlankProjectRecord,
  createRuntimeAssetFromPersisted,
  serializeRuntimeProject,
  shouldRecoverOrphanProjectMedia,
  sortProjectRecords,
  type ProjectRecord,
} from './projectPersistence';
import { DEFAULT_CLIP_TRANSFORM, createDefaultTracks, idleJobStatus, type ProjectPresent } from './projectModel';

function runtimeProject(): ProjectPresent {
  const file = new File(['video'], 'clip.mp4', { type: 'video/mp4' });
  const tracks = createDefaultTracks();

  return {
    assets: [
      {
        duration: 10,
        file,
        height: 1080,
        id: 'asset-a',
        kind: 'video',
        name: 'clip.mp4',
        originalUrl: 'blob:runtime-original',
        playbackUrl: 'blob:runtime-playback',
        posterUrl: 'data:image/jpeg;base64,AAAA',
        proxyStatus: idleJobStatus,
        proxyUrl: 'blob:proxy',
        size: file.size,
        type: 'video/mp4',
        width: 1920,
      },
    ],
    clips: [
      {
        assetId: 'asset-a',
        effects: DEFAULT_EFFECT_SETTINGS,
        fadeIn: 0,
        fadeOut: 0,
        id: 'clip-a',
        mask: null,
        muted: false,
        sourceIn: 0,
        sourceOut: 5,
        timelineStart: 0,
        trackId: tracks[0].id,
        transform: DEFAULT_CLIP_TRANSFORM,
        volume: 1,
      },
    ],
    selectedAssetId: 'asset-a',
    selectedClipId: 'clip-a',
    selectedTextId: null,
    selectedTrackId: tracks[0].id,
    textOverlays: [],
    tracks,
  };
}

describe('project persistence helpers', () => {
  it('serializes runtime projects without object URLs or File objects', () => {
    const serialized = serializeRuntimeProject(runtimeProject(), 'project-a');

    expect(serialized.assets[0]).toMatchObject({
      id: 'asset-a',
      mediaKey: 'project-a:asset-a:source',
      posterKey: 'project-a:asset-a:poster',
    });
    expect(JSON.stringify(serialized)).not.toContain('blob:');
    expect(JSON.stringify(serialized)).not.toContain('runtime-original');
  });

  it('hydrates persisted assets with fresh object URLs', () => {
    const createObjectUrl = vi.fn((blob: Blob) => `blob:${blob.type || 'media'}:${blob.size}`);
    const persisted = {
      ...serializeRuntimeProject(runtimeProject(), 'project-a').assets[0],
      type: '',
    };
    const asset = createRuntimeAssetFromPersisted(
      persisted,
      new Blob(['video'], { type: 'video/mp4' }),
      new Blob(['poster'], { type: 'image/jpeg' }),
      createObjectUrl,
    );

    expect(asset.file.name).toBe('clip.mp4');
    expect(asset.file.type).toBe('video/mp4');
    expect(asset.originalUrl).toBe('blob:video/mp4:5');
    expect(asset.posterUrl).toBe('blob:image/jpeg:6');
    expect(asset.proxyUrl).toBeNull();
  });

  it('sorts project records by latest update first', () => {
    const older = { ...createBlankProjectRecord('Older'), id: 'older', updatedAt: 10 } satisfies ProjectRecord;
    const newer = { ...createBlankProjectRecord('Newer'), id: 'newer', updatedAt: 20 } satisfies ProjectRecord;

    expect(sortProjectRecords([older, newer]).map((record) => record.id)).toEqual(['newer', 'older']);
  });

  it('only recovers orphan media when persisted project media failed to hydrate completely', () => {
    expect(shouldRecoverOrphanProjectMedia(0, 0)).toBe(false);
    expect(shouldRecoverOrphanProjectMedia(2, 1)).toBe(false);
    expect(shouldRecoverOrphanProjectMedia(2, 0)).toBe(true);
  });
});
