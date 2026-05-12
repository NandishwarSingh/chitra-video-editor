import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import coreURL from '@ffmpeg/core?url';
import wasmURL from '@ffmpeg/core/wasm?url';
import fontURL from '../assets/font.woff?url';
import { DEFAULT_EFFECT_SETTINGS } from '../effects';
import type { EffectSettings } from '../effects';
import {
  buildConcatArgs,
  buildExportMp4Args,
  buildLayeredTimelineArgs,
  buildProxyArgs,
  buildTimelineCopySegmentArgs,
  buildTimelineSegmentArgs,
  canCopyTimelineClip,
  createTimelineConcatList,
  createTranscodeInputName,
  type TimelineExportClip,
  type TimelineExportTextOverlay,
} from '../transcodeCommands';
import type { TranscodeKind } from '../transcodeClient';

type RunRequest = {
  assets?: Array<{ file: File; id: string }>;
  clips?: TimelineExportClip[];
  duration?: number;
  effects?: EffectSettings;
  file?: File;
  inPoint: number;
  jobId: string;
  kind: TranscodeKind;
  outputFps?: number;
  outputHeight?: number;
  outputWidth?: number;
  outPoint: number;
  targetHeight: number;
  textOverlays?: TimelineExportTextOverlay[];
  type: 'run';
};

type CancelRequest = {
  jobId: string;
  type: 'cancel';
};

type TranscodeRequest = RunRequest | CancelRequest;

const worker = self as unknown as Worker;
let activeFfmpeg: FFmpeg | null = null;
let ffmpegLogTail: string[] = [];

function postError(jobId: string, message: string) {
  const detail = ffmpegLogTail.slice(-8).join('\n').trim();

  worker.postMessage({
    jobId,
    message: detail ? `${message}\n${detail}` : message,
    type: 'error',
  });
}

export const DRAWTEXT_FONT_PATH = '/tmp/font.woff';

let fontBytesCache: Uint8Array | null = null;

async function loadDrawTextFont() {
  if (fontBytesCache) {
    return fontBytesCache;
  }

  const response = await fetch(fontURL);

  if (!response.ok) {
    throw new Error(`Failed to fetch drawtext font (${response.status}).`);
  }

  fontBytesCache = new Uint8Array(await response.arrayBuffer());
  return fontBytesCache;
}

async function loadFfmpeg(jobId: string) {
  const ffmpeg = new FFmpeg();
  activeFfmpeg = ffmpeg;
  ffmpegLogTail = [];

  ffmpeg.on('progress', ({ progress, time }) => {
    worker.postMessage({
      jobId,
      progress,
      time,
      type: 'progress',
    });
  });
  ffmpeg.on('log', ({ message }) => {
    ffmpegLogTail.push(message);
    if (ffmpegLogTail.length > 24) {
      ffmpegLogTail = ffmpegLogTail.slice(-24);
    }
  });

  await ffmpeg.load({
    coreURL,
    wasmURL,
  });

  return ffmpeg;
}

async function ensureDrawTextFont(ffmpeg: FFmpeg) {
  const fontBytes = await loadDrawTextFont();
  await ffmpeg.writeFile(DRAWTEXT_FONT_PATH, fontBytes);
}

function createAssetInputName(file: File, index: number) {
  const extension = file.name.match(/\.[a-z0-9]+$/i)?.[0] || '.mp4';

  return `asset_${index}${extension.toLowerCase()}`;
}

function hasLayeredTimeline(clips: TimelineExportClip[]) {
  const trackIds = new Set(clips.map((clip) => clip.trackId));

  if (trackIds.size > 1) {
    return true;
  }

  const ordered = [...clips].sort((a, b) => a.timelineStart - b.timelineStart);

  return ordered.some((clip, index) => {
    const previous = ordered[index - 1];

    return previous ? clip.timelineStart < previous.timelineStart + Math.max(0.1, previous.sourceOut - previous.sourceIn) - 0.001 : false;
  });
}

function canUseCopyTimelineExport(clips: TimelineExportClip[], textOverlays: TimelineExportTextOverlay[]) {
  if (textOverlays.length > 0 || hasLayeredTimeline(clips)) {
    return false;
  }

  const ordered = [...clips].sort((a, b) => a.timelineStart - b.timelineStart);
  let cursor = 0;

  return ordered.every((clip) => {
    const startsAtCursor = Math.abs(clip.timelineStart - cursor) < 0.05;
    cursor += Math.max(0.1, clip.sourceOut - clip.sourceIn);

    return startsAtCursor && canCopyTimelineClip(clip);
  });
}

async function readOutputBlob(ffmpeg: FFmpeg, outputPath: string) {
  const data = await ffmpeg.readFile(outputPath);
  const output = data instanceof Uint8Array ? data : new TextEncoder().encode(data);
  const outputCopy = new Uint8Array(output.byteLength);
  outputCopy.set(output);

  return new Blob([outputCopy.buffer], { type: 'video/mp4' });
}

function postComplete(request: RunRequest, blob: Blob, startedAt: number) {
  worker.postMessage({
    blob,
    jobId: request.jobId,
    kind: request.kind,
    outputBytes: blob.size,
    tookMs: performance.now() - startedAt,
    type: 'complete',
  });
}

async function runSingleSourceJob(request: RunRequest, ffmpeg: FFmpeg, startedAt: number) {
  if (!request.file) {
    throw new Error('No input file was provided.');
  }

  const inputPath = createTranscodeInputName(request.file);
  const outputPath = request.kind === 'generate-proxy' ? 'proxy.mp4' : 'export.mp4';
  const args =
    request.kind === 'generate-proxy'
      ? buildProxyArgs(inputPath, outputPath, request.targetHeight)
      : buildExportMp4Args({
          duration: request.duration ?? Math.max(0.1, request.outPoint - request.inPoint),
          effects: request.effects ?? DEFAULT_EFFECT_SETTINGS,
          inPoint: request.inPoint,
          inputPath,
          outPoint: request.outPoint,
          outputPath,
        });

  await ffmpeg.writeFile(inputPath, await fetchFile(request.file));

  const exitCode = await ffmpeg.exec(args);

  if (exitCode !== 0) {
    throw new Error(`FFmpeg exited with code ${exitCode}.`);
  }

  const blob = await readOutputBlob(ffmpeg, outputPath);

  postComplete(request, blob, startedAt);

  await Promise.allSettled([ffmpeg.deleteFile(inputPath), ffmpeg.deleteFile(outputPath)]);
}

async function runTimelineExportJob(request: RunRequest, ffmpeg: FFmpeg, startedAt: number) {
  const assets = request.assets ?? [];
  const clips = request.clips ?? [];

  if (assets.length === 0 || clips.length === 0) {
    throw new Error('Timeline export needs at least one asset and one clip.');
  }

  if ((request.textOverlays ?? []).length > 0) {
    await ensureDrawTextFont(ffmpeg);
  }

  const assetInputPaths = new Map<string, string>();
  const cleanupPaths: string[] = [];

  for (const [index, asset] of assets.entries()) {
    const inputPath = createAssetInputName(asset.file, index);
    assetInputPaths.set(asset.id, inputPath);
    cleanupPaths.push(inputPath);
    await ffmpeg.writeFile(inputPath, await fetchFile(asset.file));
  }

  if (hasLayeredTimeline(clips)) {
    const outputPath = 'layered-timeline-export.mp4';
    cleanupPaths.push(outputPath);
    const exitCode = await ffmpeg.exec(
      buildLayeredTimelineArgs({
        assets: assets.map((asset) => ({
          id: asset.id,
          inputPath: assetInputPaths.get(asset.id) as string,
        })),
        clips,
        outputFps: request.outputFps,
        outputHeight: request.outputHeight,
        outputPath,
        outputWidth: request.outputWidth,
        textOverlays: request.textOverlays ?? [],
        trackOrder: [...new Set(clips.map((clip) => clip.trackId))],
      }),
    );

    if (exitCode !== 0) {
      throw new Error('FFmpeg failed while compositing layered timeline.');
    }

    worker.postMessage({
      jobId: request.jobId,
      progress: 0.95,
      time: 0,
      type: 'progress',
    });

    const blob = await readOutputBlob(ffmpeg, outputPath);
    postComplete(request, blob, startedAt);
    await Promise.allSettled(cleanupPaths.map((path) => ffmpeg.deleteFile(path)));
    return;
  }

  const segmentPaths: string[] = [];
  const orderedClips = [...clips].sort((a, b) => a.timelineStart - b.timelineStart);
  const useCopySegments = canUseCopyTimelineExport(orderedClips, request.textOverlays ?? []);

  for (const [index, clip] of orderedClips.entries()) {
    const inputPath = assetInputPaths.get(clip.assetId);

    if (!inputPath) {
      throw new Error(`Missing media for clip ${clip.id}.`);
    }

    const outputPath = `segment_${index}.mp4`;
    const args = useCopySegments
      ? buildTimelineCopySegmentArgs({
          clip,
          inputPath,
          outputPath,
        })
      : buildTimelineSegmentArgs({
          clip,
          clipTimelineStart: clip.timelineStart,
          inputPath,
          outputFps: request.outputFps,
          outputHeight: request.outputHeight,
          outputPath,
          outputWidth: request.outputWidth,
          textOverlays: request.textOverlays ?? [],
        });
    const exitCode = await ffmpeg.exec(args);

    if (exitCode !== 0) {
      throw new Error(`FFmpeg failed while rendering segment ${index + 1}.`);
    }

    segmentPaths.push(outputPath);
    cleanupPaths.push(outputPath);
    worker.postMessage({
      jobId: request.jobId,
      progress: (index + 1) / (orderedClips.length + 1),
      time: 0,
      type: 'progress',
    });
  }

  const listPath = 'concat.txt';
  const outputPath = 'timeline-export.mp4';
  cleanupPaths.push(listPath, outputPath);
  await ffmpeg.writeFile(listPath, new TextEncoder().encode(createTimelineConcatList(segmentPaths)));

  const exitCode = await ffmpeg.exec(buildConcatArgs(listPath, outputPath));

  if (exitCode !== 0) {
    throw new Error('FFmpeg failed while concatenating timeline segments.');
  }

  const blob = await readOutputBlob(ffmpeg, outputPath);
  postComplete(request, blob, startedAt);
  await Promise.allSettled(cleanupPaths.map((path) => ffmpeg.deleteFile(path)));
}

async function runJob(request: RunRequest) {
  const startedAt = performance.now();
  const ffmpeg = await loadFfmpeg(request.jobId);

  if (request.kind === 'export-timeline-mp4') {
    await runTimelineExportJob(request, ffmpeg, startedAt);
  } else {
    await runSingleSourceJob(request, ffmpeg, startedAt);
  }

  ffmpeg.terminate();
  activeFfmpeg = null;
}

worker.onmessage = (event: MessageEvent<TranscodeRequest>) => {
  const request = event.data;

  if (request.type === 'cancel') {
    activeFfmpeg?.terminate();
    activeFfmpeg = null;
    return;
  }

  runJob(request).catch((error) => {
    activeFfmpeg?.terminate();
    activeFfmpeg = null;
    postError(request.jobId, error instanceof Error ? error.message : 'Transcode failed.');
  });
};
