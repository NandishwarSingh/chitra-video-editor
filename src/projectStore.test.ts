import { describe, expect, it } from 'vitest';
import { createProxyCacheKey, createThumbnailCacheKey } from './projectStore';

describe('thumbnail cache keys', () => {
  it('keeps cache keys stable for equivalent timestamps', () => {
    expect(createThumbnailCacheKey('clip', 1.234, 168)).toBe(createThumbnailCacheKey('clip', 1.234, 168));
  });

  it('separates different thumbnail sizes', () => {
    expect(createThumbnailCacheKey('clip', 1.23, 168)).not.toBe(createThumbnailCacheKey('clip', 1.23, 320));
  });

  it('uses the current proxy cache version', () => {
    expect(createProxyCacheKey('clip', 720)).toBe('proxy:v2:clip:720');
  });
});
