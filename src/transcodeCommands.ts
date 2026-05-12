import { DEFAULT_EFFECT_SETTINGS, type EffectSettings } from './effects';
import { createFfmpegEffectFilter } from './effects';
import { clampClipTransform, type ClipTransform } from './projectModel';

export type ExportMp4CommandOptions = {
  duration: number;
  effects: EffectSettings;
  inPoint: number;
  inputPath: string;
  outPoint: number;
  outputPath: string;
};

export type TimelineExportClip = {
  assetId: string;
  effects: EffectSettings;
  fadeIn: number;
  fadeOut: number;
  id: string;
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
  end: number;
  id: string;
  size: number;
  start: number;
  text: string;
  x: number;
  y: number;
};

export type TimelineLayeredExportOptions = {
  assets: Array<{ id: string; inputPath: string }>;
  clips: TimelineExportClip[];
  duration?: number;
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
  return text
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\n/g, ' ');
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

export function createDrawTextFilter(
  overlay: TimelineExportTextOverlay,
  clipTimelineStart: number,
  clipDuration: number,
  fontfile: string = DRAWTEXT_DEFAULT_FONTFILE,
) {
  const localStart = Math.max(0, overlay.start - clipTimelineStart);
  const localEnd = Math.min(clipDuration, overlay.end - clipTimelineStart);

  if (localEnd <= 0 || localStart >= clipDuration || localEnd <= localStart || overlay.text.trim().length === 0) {
    return null;
  }

  const x =
    overlay.align === 'left'
      ? `w*${overlay.x.toFixed(3)}`
      : overlay.align === 'center'
        ? `w*${overlay.x.toFixed(3)}-text_w/2`
        : `w*${overlay.x.toFixed(3)}-text_w`;

  const options = [
    `fontfile=${fontfile}`,
    `text='${escapeDrawText(overlay.text)}'`,
    'fontcolor=white',
    `fontsize=${Math.round(overlay.size)}`,
    `x=${x}`,
    `y=(h-text_h)*${overlay.y.toFixed(3)}`,
    `box=1`,
    `boxcolor=black@0.45`,
    `boxborderw=8`,
    `enable='between(t,${formatSeconds(localStart)},${formatSeconds(localEnd)})'`,
  ].join(':');

  return `drawtext=${options}`;
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
  outputPath,
  outputWidth = 1280,
  textOverlays,
  trackOrder = [],
}: TimelineLayeredExportOptions) {
  const assetIndexById = new Map(assets.map((asset, index) => [asset.id, index]));
  const trackIndexById = new Map(trackOrder.map((trackId, index) => [trackId, index]));
  const timelineDuration =
    duration ??
    Math.max(
      0.1,
      ...clips.map((clip) => clip.timelineStart + Math.max(0.1, clip.sourceOut - clip.sourceIn)),
      ...textOverlays.map((overlay) => overlay.end),
    );
  const args = assets.flatMap((asset) => ['-i', asset.inputPath]);
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

    const clipDuration = Math.max(0.1, clip.sourceOut - clip.sourceIn);
    const effectFilter = createFfmpegEffectFilter(clip.effects);
    const videoFilters = [
      `trim=start=${formatSeconds(clip.sourceIn)}:end=${formatSeconds(clip.sourceOut)}`,
      `setpts=PTS-STARTPTS+${formatSeconds(clip.timelineStart)}/TB`,
      `fps=${outputFps}`,
      ...createVideoTransformFilters(clip, outputWidth, outputHeight),
      effectFilter ? `eq=${effectFilter}` : null,
      'format=rgba',
    ].filter(Boolean);
    const videoLabel = `v${index}`;
    const nextBaseLabel = `base${index + 1}`;
    filters.push(`[${inputIndex}:v]${videoFilters.join(',')}[${videoLabel}]`);
    filters.push(
      `[${baseLabel}][${videoLabel}]overlay=0:0:eof_action=pass:enable='between(t,${formatSeconds(clip.timelineStart)},${formatSeconds(
        clip.timelineStart + clipDuration,
      )})'[${nextBaseLabel}]`,
    );
    baseLabel = nextBaseLabel;

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
