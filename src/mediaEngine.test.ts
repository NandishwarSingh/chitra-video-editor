import { describe, expect, it } from 'vitest';
import { createMediaFingerprint, createTypedVideoFile, inferVideoMimeType, isSupportedVideoFile, shouldUsePreviewProxy } from './mediaEngine';

describe('media engine helpers', () => {
  it('creates stable media fingerprints from file metadata', () => {
    const file = new File(['abc'], 'clip.mp4', {
      lastModified: 123,
      type: 'video/mp4',
    });

    expect(createMediaFingerprint(file, 10)).toBe('clip.mp4:3:123:10.000');
  });

  it('recommends proxies for high-resolution or large files', () => {
    const smallFile = new File(['abc'], 'small.mp4');
    const largeFile = { size: 501 * 1024 * 1024 } as File;

    expect(shouldUsePreviewProxy(smallFile, 1920, 1080)).toBe(false);
    expect(shouldUsePreviewProxy(smallFile, 3840, 2160)).toBe(true);
    expect(shouldUsePreviewProxy(largeFile, 1920, 1080)).toBe(true);
    expect(shouldUsePreviewProxy(new File(['abc'], 'clip.mov', { type: 'video/quicktime' }), 1920, 1080)).toBe(false);
    expect(shouldUsePreviewProxy(new File(['abc'], 'clip.mov', { type: 'video/quicktime' }), 3840, 2160)).toBe(true);
  });

  it('infers playable video MIME types for reopened media', () => {
    expect(inferVideoMimeType('clip.mp4', '')).toBe('video/mp4');
    expect(inferVideoMimeType('clip.mov', 'application/octet-stream')).toBe('video/quicktime');
    expect(isSupportedVideoFile(new File(['abc'], 'folder/clip.webm', { type: '' }))).toBe(true);

    const typed = createTypedVideoFile(new Blob(['abc'], { type: '' }), 'folder/clip.mp4');
    expect(typed.name).toBe('clip.mp4');
    expect(typed.type).toBe('video/mp4');
  });
});
