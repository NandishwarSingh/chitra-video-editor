import { DEFAULT_EFFECT_SETTINGS, type EffectSettings } from './effects';
import { createFfmpegEffectFilter } from './effects';
import { clampClipTransform, type ClipTransform } from './projectModel';
import { ffmpegDrawtextAnchor } from './textPositioning';

export type ExportMp4CommandOptions = {
  duration: number;
  effects: EffectSettings;
  inPoint: number;
  inputPath: string;
  outPoint: number;
  outputPath: string;
};

export type TimelineExportMask = {
  enabled: boolean;
  feather: number;
  invert: boolean;
  maskKey: string;
  mode: 'blur-bg' | 'cutout' | 'spotlight';
};

export type TimelineExportClip = {
  assetId: string;
  effects: EffectSettings;
  fadeIn: number;
  fadeOut: number;
  id: string;
  mask?: TimelineExportMask | null;
  muted: boolean;
  sourceIn: number;
  sourceOut: number;
  timelineStart: number;
  trackId: string;
  transform: ClipTransform;
  volume: number;
};

export type TimelineExportTextOverlay = {
  align: 'left' | 'center' | 'right';
  /** Optional fields — when present the export honours them so the rendered
   *  frame matches the editor preview. Older callers can omit these and get
   *  the historical "white text, dark plate" default. */
  backgroundColor?: string;
  bold?: boolean;
  color?: string;
  end: number;
  id: string;
  italic?: boolean;
  shadowBlur?: number;
  shadowColor?: string;
  shadowOffsetX?: number;
  shadowOffsetY?: number;
  size: number;
  start: number;
  strokeColor?: string;
  strokeWidth?: number;
  text: string;
  textCase?: 'none' | 'upper' | 'lower';
  x: number;
  y: number;
};

export type TimelineLayeredExportOptions = {
  assets: Array<{ id: string; inputPath: string; kind?: 'audio' | 'video' }>;
  clips: TimelineExportClip[];
  duration?: number;
  /** maskKey → FFmpeg input index for that clip's grayscale matte mp4.
   *  Only clips whose mask is enabled AND present here get the mask
   *  subgraph; every other clip takes the exact pre-mask code path. */
  maskInputIndexByKey?: Record<string, number>;
  /** Matte mp4 paths, appended as `-i` after the asset inputs. Ordering
   *  MUST match the indices in `maskInputIndexByKey`
   *  (input index = assets.length + position here). */
  maskInputPaths?: string[];
  outputFps?: number;
  outputHeight?: number;
  outputPath: string;
  outputWidth?: number;
  textOverlays: TimelineExportTextOverlay[];
  trackOrder?: string[];
};

export type TimelineSegmentCommandOptions = {
  clip: TimelineExportClip;
  clipTimelineStart: number;
  inputPath: string;
  outputFps?: number;
  outputHeight?: number;
  outputPath: string;
  outputWidth?: number;
  textOverlays: TimelineExportTextOverlay[];
};

export type TimelineCopySegmentCommandOptions = {
  clip: TimelineExportClip;
  inputPath: string;
  outputPath: string;
};

function formatSeconds(seconds: number) {
  return Math.max(0, seconds).toFixed(3);
}

function escapeDrawText(text: string) {
  // Preserve newlines so multi-line subtitles render the same as the editor's
  // CSS preview (`white-space: pre` keeps \n).
  return text
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

/**
 * Normalise a CSS-ish hex color to FFmpeg `0xRRGGBB@A`. Inputs accepted:
 * - `#rgb`     → expanded to `#rrggbb`, fully opaque
 * - `#rrggbb`  → fully opaque
 * - `#rrggbbaa` → alpha extracted from `aa`
 * - anything else → returns `null` so the caller knows to skip the feature
 */
function ffmpegColor(hex: string | undefined | null): { color: string; alpha: number } | null {
  if (!hex || typeof hex !== 'string') return null;
  const trimmed = hex.trim();
  if (!trimmed.startsWith('#')) return null;
  let body = trimmed.slice(1);
  if (body.length === 3) {
    body = body
      .split('')
      .map((c) => `${c}${c}`)
      .join('');
  }
  if (!(body.length === 6 || body.length === 8)) return null;
  if (!/^[0-9a-fA-F]+$/.test(body)) return null;
  const rgb = body.slice(0, 6);
  const alphaHex = body.length === 8 ? body.slice(6, 8) : 'ff';
  const alpha = parseInt(alphaHex, 16) / 255;
  return {
    alpha,
    color: `0x${rgb.toUpperCase()}@${alpha.toFixed(3)}`,
  };
}

export function buildProxyArgs(inputPath: string, outputPath: string, targetHeight = 720) {
  return [
    '-i',
    inputPath,
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-vf',
    `scale=-2:${targetHeight}`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '28',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-b:a',
    '128k',
    '-movflags',
    'faststart',
    outputPath,
  ];
}

export function buildExportMp4Args({
  duration,
  effects,
  inPoint,
  inputPath,
  outPoint,
  outputPath,
}: ExportMp4CommandOptions) {
  const trimDuration = Math.max(0.1, Math.min(duration, outPoint) - Math.max(0, inPoint));
  const effectFilter = createFfmpegEffectFilter(effects);
  const args = [
    '-ss',
    formatSeconds(inPoint),
    '-i',
    inputPath,
    '-t',
    formatSeconds(trimDuration),
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
  ];

  if (effectFilter) {
    args.push('-vf', `eq=${effectFilter}`);
  }

  args.push(
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '22',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-movflags',
    'faststart',
    outputPath,
  );

  return args;
}

export const DRAWTEXT_DEFAULT_FONTFILE = '/tmp/font.woff';

/**
 * Build an FFmpeg drawtext filter that matches the editor's CSS preview as
 * closely as drawtext allows. The position math comes from a shared anchor
 * helper (`src/textPositioning.ts`) used by both this function and the CSS
 * preview, so the two paths cannot drift.
 *
 * What it honours from the TextOverlay model (everything that drawtext can
 * express without per-frame compositing):
 *   - text + multi-line via preserved \n
 *   - fontfile (bundled Inter is the WYSIWYG path; other families need bundle work)
 *   - fontsize (in output-frame pixels — same units as the preview at
 *     project resolution)
 *   - color + opacity from `color`
 *   - background plate from `backgroundColor` (skipped entirely when alpha=0)
 *   - stroke / outline from strokeColor + strokeWidth (drawtext `borderw`)
 *   - drop shadow from shadow* fields (drawtext `shadowx/y/color`)
 *   - alignment + position via shared anchor helper
 *   - textCase via `applyTextCase` before escape
 *
 * What drawtext can't do losslessly (these emit at the requested style but
 * may differ from the preview): font rotation, x/y skew, per-clip transform
 * stacking under WebGPU effects. Callers are responsible for warning users
 * if those are set on text destined for export.
 */
export function createDrawTextFilter(
  overlay: TimelineExportTextOverlay,
  clipTimelineStart: number,
  clipDuration: number,
  fontfile: string = DRAWTEXT_DEFAULT_FONTFILE,
) {
  const localStart = Math.max(0, overlay.start - clipTimelineStart);
  const localEnd = Math.min(clipDuration, overlay.end - clipTimelineStart);
  if (localEnd <= 0 || localStart >= clipDuration || localEnd <= localStart) return null;
  const rendered = applyTextCase(overlay.text, overlay.textCase ?? 'none');
  if (rendered.trim().length === 0) return null;

  const anchor = ffmpegDrawtextAnchor({ align: overlay.align, x: overlay.x, y: overlay.y });
  const fontColor = ffmpegColor(overlay.color) ?? { alpha: 1, color: 'white' };
  const backgroundColor = ffmpegColor(overlay.backgroundColor);
  const strokeColor = ffmpegColor(overlay.strokeColor);
  const shadowColor = ffmpegColor(overlay.shadowColor);
  const strokeWidth = Math.max(0, Math.round(overlay.strokeWidth ?? 0));
  const shadowOffsetX = Math.round(overlay.shadowOffsetX ?? 0);
  const shadowOffsetY = Math.round(overlay.shadowOffsetY ?? 0);
  const shadowEnabled = (overlay.shadowBlur ?? 0) > 0 || shadowOffsetX !== 0 || shadowOffsetY !== 0;

  const options: string[] = [
    `fontfile=${fontfile}`,
    `text='${escapeDrawText(rendered)}'`,
    `fontcolor=${fontColor.color}`,
    `fontsize=${Math.round(overlay.size)}`,
    `x=${anchor.x}`,
    `y=${anchor.y}`,
    // Match CSS `white-space: pre` — long captions wrap manually via \n,
    // never auto-wrap silently. Line spacing matches a typical 1.2 baseline.
    'line_spacing=8',
  ];

  if (backgroundColor && backgroundColor.alpha > 0) {
    options.push('box=1');
    options.push(`boxcolor=${backgroundColor.color}`);
    options.push('boxborderw=12');
  }

  if (strokeWidth > 0 && strokeColor) {
    options.push(`borderw=${strokeWidth}`);
    options.push(`bordercolor=${strokeColor.color}`);
  }

  if (shadowEnabled && shadowColor) {
    options.push(`shadowx=${shadowOffsetX}`);
    options.push(`shadowy=${shadowOffsetY}`);
    options.push(`shadowcolor=${shadowColor.color}`);
  }

  options.push(`enable='between(t,${formatSeconds(localStart)},${formatSeconds(localEnd)})'`);
  return `drawtext=${options.join(':')}`;
}

function applyTextCase(text: string, textCase: 'none' | 'upper' | 'lower'): string {
  if (textCase === 'upper') return text.toUpperCase();
  if (textCase === 'lower') return text.toLowerCase();
  return text;
}

export function createAudioFilter(clip: TimelineExportClip) {
  const duration = Math.max(0.1, clip.sourceOut - clip.sourceIn);
  const filters: string[] = [];

  if (clip.muted) {
    filters.push('volume=0');
  } else if (Math.abs(clip.volume - 1) > 0.001) {
    filters.push(`volume=${clip.volume.toFixed(3)}`);
  }

  if (clip.fadeIn > 0.001) {
    filters.push(`afade=t=in:st=0:d=${formatSeconds(Math.min(clip.fadeIn, duration))}`);
  }

  if (clip.fadeOut > 0.001) {
    const fadeDuration = Math.min(clip.fadeOut, duration);
    filters.push(`afade=t=out:st=${formatSeconds(Math.max(0, duration - fadeDuration))}:d=${formatSeconds(fadeDuration)}`);
  }

  return filters.length > 0 ? filters.join(',') : null;
}

export function createVideoTransformFilters(clip: TimelineExportClip, outputWidth: number, outputHeight: number) {
  const transform = clampClipTransform(clip.transform);
  const scale = transform.scale.toFixed(4);
  const x = transform.x.toFixed(4);
  const y = transform.y.toFixed(4);

  return [
    `scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=decrease`,
    Math.abs(transform.scale - 1) > 0.001 ? `scale=iw*${scale}:ih*${scale}` : null,
    `pad=max(iw\\,${outputWidth}):max(ih\\,${outputHeight}):(ow-iw)*${x}:(oh-ih)*${y}:color=black`,
    `crop=${outputWidth}:${outputHeight}:(iw-${outputWidth})*${x}:(ih-${outputHeight})*${y}`,
    'setsar=1',
  ].filter(Boolean) as string[];
}

export function canCopyTimelineClip(clip: TimelineExportClip) {
  const transform = clampClipTransform(clip.transform);

  return (
    !clip.muted &&
    Math.abs(clip.volume - 1) < 0.001 &&
    clip.fadeIn <= 0.001 &&
    clip.fadeOut <= 0.001 &&
    Math.abs(clip.effects.brightness - DEFAULT_EFFECT_SETTINGS.brightness) < 0.001 &&
    Math.abs(clip.effects.contrast - DEFAULT_EFFECT_SETTINGS.contrast) < 0.001 &&
    Math.abs(clip.effects.saturation - DEFAULT_EFFECT_SETTINGS.saturation) < 0.001 &&
    Math.abs(transform.scale - 1) < 0.001 &&
    Math.abs(transform.x - 0.5) < 0.001 &&
    Math.abs(transform.y - 0.5) < 0.001
  );
}

export function buildTimelineCopySegmentArgs({ clip, inputPath, outputPath }: TimelineCopySegmentCommandOptions) {
  const clipDuration = Math.max(0.1, clip.sourceOut - clip.sourceIn);

  return [
    '-ss',
    formatSeconds(clip.sourceIn),
    '-i',
    inputPath,
    '-t',
    formatSeconds(clipDuration),
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-c',
    'copy',
    '-avoid_negative_ts',
    'make_zero',
    '-movflags',
    'faststart',
    outputPath,
  ];
}

export function buildTimelineSegmentArgs({
  clip,
  clipTimelineStart,
  inputPath,
  outputFps = 30,
  outputHeight = 720,
  outputPath,
  outputWidth = 1280,
  textOverlays,
}: TimelineSegmentCommandOptions) {
  const clipDuration = Math.max(0.1, clip.sourceOut - clip.sourceIn);
  const effectFilter = createFfmpegEffectFilter(clip.effects);
  const videoFilters = [
    `fps=${outputFps}`,
    ...createVideoTransformFilters(clip, outputWidth, outputHeight),
    effectFilter ? `eq=${effectFilter}` : null,
    ...textOverlays.map((overlay) => createDrawTextFilter(overlay, clipTimelineStart, clipDuration)),
  ].filter(Boolean) as string[];
  const audioFilter = createAudioFilter(clip);
  const args = [
    '-ss',
    formatSeconds(clip.sourceIn),
    '-i',
    inputPath,
    '-t',
    formatSeconds(clipDuration),
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
  ];

  if (videoFilters.length > 0) {
    args.push('-vf', videoFilters.join(','));
  }

  if (audioFilter) {
    args.push('-af', audioFilter);
  }

  args.push(
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '22',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-b:a',
    '160k',
    '-movflags',
    'faststart',
    outputPath,
  );

  return args;
}

export function buildLayeredTimelineArgs({
  assets,
  clips,
  duration,
  outputFps = 30,
  outputHeight = 720,
  maskInputIndexByKey = {},
  maskInputPaths = [],
  outputPath,
  outputWidth = 1280,
  textOverlays,
  trackOrder = [],
}: TimelineLayeredExportOptions) {
  const assetIndexById = new Map(assets.map((asset, index) => [asset.id, index]));
  const assetKindById = new Map(assets.map((asset) => [asset.id, asset.kind ?? 'video'] as const));
  const trackIndexById = new Map(trackOrder.map((trackId, index) => [trackId, index]));
  const timelineDuration =
    duration ??
    Math.max(
      0.1,
      ...clips.map((clip) => clip.timelineStart + Math.max(0.1, clip.sourceOut - clip.sourceIn)),
      ...textOverlays.map((overlay) => overlay.end),
    );
  const args = [
    ...assets.flatMap((asset) => ['-i', asset.inputPath]),
    ...maskInputPaths.flatMap((path) => ['-i', path]),
  ];
  const filters: string[] = [`color=c=black:s=${outputWidth}x${outputHeight}:d=${formatSeconds(timelineDuration)}:r=${outputFps}[base0]`];
  const orderedClips = [...clips].sort((a, b) => {
    const trackDelta = (trackIndexById.get(a.trackId) ?? 0) - (trackIndexById.get(b.trackId) ?? 0);

    return trackDelta || a.timelineStart - b.timelineStart;
  });
  let baseLabel = 'base0';
  const audioLabels: string[] = [];

  orderedClips.forEach((clip, index) => {
    const inputIndex = assetIndexById.get(clip.assetId);

    if (inputIndex === undefined) {
      return;
    }

    const assetKind = assetKindById.get(clip.assetId) ?? 'video';
    const clipDuration = Math.max(0.1, clip.sourceOut - clip.sourceIn);

    if (assetKind === 'video') {
      const effectFilter = createFfmpegEffectFilter(clip.effects);
      const videoLabel = `v${index}`;
      const nextBaseLabel = `base${index + 1}`;
      const maskIdx =
        clip.mask?.enabled && clip.mask.maskKey in maskInputIndexByKey
          ? maskInputIndexByKey[clip.mask.maskKey]
          : undefined;

      if (maskIdx === undefined || !clip.mask) {
        // Unchanged pre-mask path.
        const videoFilters = [
          `trim=start=${formatSeconds(clip.sourceIn)}:end=${formatSeconds(clip.sourceOut)}`,
          `setpts=PTS-STARTPTS+${formatSeconds(clip.timelineStart)}/TB`,
          `fps=${outputFps}`,
          ...createVideoTransformFilters(clip, outputWidth, outputHeight),
          effectFilter ? `eq=${effectFilter}` : null,
          'format=rgba',
        ].filter(Boolean);
        filters.push(`[${inputIndex}:v]${videoFilters.join(',')}[${videoLabel}]`);
      } else {
        // Mask subgraph: process clip + matte in asset space (same
        // trim/setpts/fps so frames align), composite per mode, THEN apply
        // the shared transform/effects so the matte stays registered.
        const m = clip.mask;
        const trimSet = `trim=start=${formatSeconds(clip.sourceIn)}:end=${formatSeconds(
          clip.sourceOut,
        )},setpts=PTS-STARTPTS+${formatSeconds(clip.timelineStart)}/TB,fps=${outputFps}`;
        const cv = `cv${index}`;
        const rawm = `rm${index}`;
        const mlbl = `mk${index}`;
        const cvv = `cvv${index}`;
        const merged = `mg${index}`;
        filters.push(`[${inputIndex}:v]${trimSet}[${cv}]`);
        filters.push(`[${maskIdx}:v]${trimSet},format=gray[${rawm}]`);
        // Scale the matte to the clip-video size so the merges line up.
        filters.push(`[${rawm}][${cv}]scale2ref=w=iw:h=ih[${mlbl}][${cvv}]`);
        const featherSigma = Math.round(m.feather * 8);
        if (featherSigma > 0) filters.push(`[${mlbl}]gblur=sigma=${featherSigma}[${mlbl}]`);
        if (m.invert) filters.push(`[${mlbl}]negate[${mlbl}]`);
        if (m.mode === 'cutout') {
          filters.push(`[${cvv}]format=rgba[${cvv}r];[${cvv}r][${mlbl}]alphamerge[${merged}]`);
        } else {
          const dim = m.mode === 'blur-bg' ? `gblur=sigma=18` : `eq=brightness=-0.45:saturation=0.35`;
          // maskedmerge(base, overlay, mask): mask-bright→overlay,
          // mask-dark→base. Subject(white)=sharp/bright, bg=dim/blur.
          filters.push(
            `[${cvv}]split[${cvv}a][${cvv}b];[${cvv}b]${dim}[${cvv}d];[${cvv}d][${cvv}a][${mlbl}]maskedmerge[${merged}]`,
          );
        }
        const tailFilters = [
          ...createVideoTransformFilters(clip, outputWidth, outputHeight),
          effectFilter ? `eq=${effectFilter}` : null,
          'format=rgba',
        ].filter(Boolean);
        filters.push(`[${merged}]${tailFilters.join(',')}[${videoLabel}]`);
      }
      filters.push(
        `[${baseLabel}][${videoLabel}]overlay=0:0:eof_action=pass:enable='between(t,${formatSeconds(clip.timelineStart)},${formatSeconds(
          clip.timelineStart + clipDuration,
        )})'[${nextBaseLabel}]`,
      );
      baseLabel = nextBaseLabel;
    }

    if (!clip.muted) {
      const audioFilter = createAudioFilter(clip);
      const audioLabel = `a${index}`;
      const audioFilters = [
        `atrim=start=${formatSeconds(clip.sourceIn)}:end=${formatSeconds(clip.sourceOut)}`,
        `asetpts=PTS-STARTPTS+${formatSeconds(clip.timelineStart)}/TB`,
        audioFilter,
      ].filter(Boolean);
      filters.push(`[${inputIndex}:a]${audioFilters.join(',')}[${audioLabel}]`);
      audioLabels.push(`[${audioLabel}]`);
    }
  });

  const textFilters = textOverlays
    .map((overlay) => createDrawTextFilter(overlay, 0, timelineDuration))
    .filter(Boolean) as string[];
  const videoOutLabel = textFilters.length > 0 ? 'vout' : baseLabel;

  if (textFilters.length > 0) {
    filters.push(`[${baseLabel}]${textFilters.join(',')}[${videoOutLabel}]`);
  }

  if (audioLabels.length > 0) {
    filters.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:normalize=0[aout]`);
  }

  args.push('-filter_complex', filters.join(';'), '-map', `[${videoOutLabel}]`);

  if (audioLabels.length > 0) {
    args.push('-map', '[aout]', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '160k');
  } else {
    args.push('-an');
  }

  args.push(
    '-t',
    formatSeconds(timelineDuration),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '22',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    'faststart',
    outputPath,
  );

  return args;
}

export function buildConcatArgs(listPath: string, outputPath: string) {
  return ['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-movflags', 'faststart', outputPath];
}

export function createTimelineConcatList(segmentPaths: string[]) {
  return segmentPaths.map((path) => `file '${path.replace(/'/g, "'\\''")}'`).join('\n');
}

export function createTranscodeInputName(file: File) {
  const extension = file.name.match(/\.[a-z0-9]+$/i)?.[0] || '.mp4';

  return `input${extension.toLowerCase()}`;
}
