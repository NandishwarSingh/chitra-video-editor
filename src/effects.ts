export type EffectSettings = {
  brightness: number;
  contrast: number;
  saturation: number;
};

export const DEFAULT_EFFECT_SETTINGS: EffectSettings = {
  brightness: 0,
  contrast: 1,
  saturation: 1,
};

export function clampEffectSettings(settings: EffectSettings): EffectSettings {
  return {
    brightness: Math.min(Math.max(settings.brightness, -0.4), 0.4),
    contrast: Math.min(Math.max(settings.contrast, 0.5), 1.8),
    saturation: Math.min(Math.max(settings.saturation, 0), 2),
  };
}

export function hasActiveEffects(settings: EffectSettings) {
  const clamped = clampEffectSettings(settings);

  return (
    Math.abs(clamped.brightness - DEFAULT_EFFECT_SETTINGS.brightness) > 0.001 ||
    Math.abs(clamped.contrast - DEFAULT_EFFECT_SETTINGS.contrast) > 0.001 ||
    Math.abs(clamped.saturation - DEFAULT_EFFECT_SETTINGS.saturation) > 0.001
  );
}

export function createEffectUniforms(settings: EffectSettings) {
  const clamped = clampEffectSettings(settings);

  return new Float32Array([clamped.brightness, clamped.contrast, clamped.saturation, 0]);
}

export function createFfmpegEffectFilter(settings: EffectSettings) {
  if (!hasActiveEffects(settings)) {
    return null;
  }

  const clamped = clampEffectSettings(settings);

  return [
    `brightness=${clamped.brightness.toFixed(3)}`,
    `contrast=${clamped.contrast.toFixed(3)}`,
    `saturation=${clamped.saturation.toFixed(3)}`,
  ].join(':');
}
