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

describe('formatClock rounding', () => {
  it('rounds binary-float drift up to the next centisecond instead of truncating', () => {
    // Bug: Math.floor((1.7999999999 % 1) * 100) returned 79 instead of 80.
    expect(formatClock(1.7999999999)).toBe('00:01.80');
    expect(formatClock(0.4999999999)).toBe('00:00.50');
    expect(formatClock(2.999999)).toBe('00:03.00');
  });

  it('carries rounded centiseconds into the seconds field', () => {
    expect(formatClock(59.999)).toBe('01:00.00');
    expect(formatClock(59.9999)).toBe('01:00.00');
  });

  it('carries rounded seconds into the minutes field', () => {
    expect(formatClock(3599.999)).toBe('60:00.00');
  });

  it('handles invalid input', () => {
    expect(formatClock(Number.NaN)).toBe('00:00.00');
    expect(formatClock(Number.POSITIVE_INFINITY)).toBe('00:00.00');
    expect(formatClock(-1)).toBe('00:00.00');
  });
});
