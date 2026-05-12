import { describe, expect, it } from 'vitest';
import { isClipReorderDrag } from './timelineInteractions';

describe('timeline interactions', () => {
  it('keeps clip click selection separate from clip reorder drag', () => {
    expect(isClipReorderDrag(100, 40, 103, 43)).toBe(false);
    expect(isClipReorderDrag(100, 40, 120, 40)).toBe(true);
  });
});
