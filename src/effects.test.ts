import { describe, expect, it } from 'vitest';
import { DEFAULT_EFFECT_SETTINGS, createEffectUniforms, createFfmpegEffectFilter, hasActiveEffects } from './effects';

describe('effect helpers', () => {
  it('detects default effects as inactive', () => {
    expect(hasActiveEffects(DEFAULT_EFFECT_SETTINGS)).toBe(false);
    expect(createFfmpegEffectFilter(DEFAULT_EFFECT_SETTINGS)).toBeNull();
  });

  it('clamps uniforms for gpu preview', () => {
    const uniforms = Array.from(createEffectUniforms({ brightness: 2, contrast: 4, saturation: -1 }));

    expect(uniforms[0]).toBeCloseTo(0.4);
    expect(uniforms[1]).toBeCloseTo(1.8);
    expect(uniforms[2]).toBe(0);
    expect(uniforms[3]).toBe(0);
  });
});
