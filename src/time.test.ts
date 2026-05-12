import { describe, expect, it } from 'vitest';
import { clamp, formatBytes, formatClock } from './time';

describe('time utilities', () => {
  it('clamps values inside a range', () => {
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(4, 0, 10)).toBe(4);
    expect(clamp(12, 0, 10)).toBe(10);
  });

  it('formats clocks with centiseconds', () => {
    expect(formatClock(0)).toBe('00:00.00');
    expect(formatClock(65.432)).toBe('01:05.43');
  });

  it('formats byte sizes compactly', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });
});
