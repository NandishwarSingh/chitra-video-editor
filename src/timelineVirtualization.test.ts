import { describe, expect, it } from 'vitest';
import { getTimelineCellWidth, getVirtualTimelineWidth, summarizeVirtualTimeline } from './timelineVirtualization';
import { createPriorityThumbnailOrder, getTimelineThumbnailCount } from './useVideoThumbnails';

describe('timeline virtualization helpers', () => {
  it('scales cell width with bounded zoom', () => {
    expect(getTimelineCellWidth(1)).toBe(168);
    expect(getTimelineCellWidth(4)).toBe(420);
  });

  it('keeps a minimum virtual timeline width', () => {
    expect(getVirtualTimelineWidth(0, 1, 720)).toBe(720);
    expect(getVirtualTimelineWidth(10, 1, 720)).toBe(1680);
  });

  it('prioritizes visible thumbnail indexes', () => {
    expect(createPriorityThumbnailOrder(5, [3, 1, 3])).toEqual([3, 1, 0, 2, 4]);
  });

  it('caps generated thumbnail counts', () => {
    expect(getTimelineThumbnailCount(10)).toBe(6);
    expect(getTimelineThumbnailCount(400)).toBe(120);
  });

  it('reports whether the timeline is virtualized', () => {
    expect(summarizeVirtualTimeline(100, 12).virtualized).toBe(true);
  });
});
