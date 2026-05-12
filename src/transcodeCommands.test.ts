import { describe, expect, it } from 'vitest';
import { DEFAULT_EFFECT_SETTINGS } from './effects';
import { DEFAULT_CLIP_TRANSFORM } from './projectModel';
import {
  buildConcatArgs,
  buildExportMp4Args,
  buildLayeredTimelineArgs,
  buildProxyArgs,
  buildTimelineCopySegmentArgs,
  buildTimelineSegmentArgs,
  canCopyTimelineClip,
  createAudioFilter,
  createDrawTextFilter,
  createTimelineConcatList,
  createTranscodeInputName,
} from './transcodeCommands';

describe('transcode command builders', () => {
  it('builds a 720p h264 proxy command with optional audio', () => {
    expect(buildProxyArgs('input.mov', 'proxy.mp4')).toEqual([
      '-i',
      'input.mov',
      '-map',
      '0:v:0',
      '-map',
      '0:a?',
      '-vf',
      'scale=-2:720',
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
      'proxy.mp4',
    ]);
  });

  it('builds a trimmed mp4 export command with optional audio mapping', () => {
    expect(
      buildExportMp4Args({
        duration: 20,
        effects: DEFAULT_EFFECT_SETTINGS,
        inPoint: 2,
        inputPath: 'input.mp4',
        outPoint: 7,
        outputPath: 'export.mp4',
      }),
    ).toContain('0:a?');
  });

  it('adds matching effect filters to the export command', () => {
    const args = buildExportMp4Args({
      duration: 20,
      effects: {
        brightness: 0.1,
        contrast: 1.2,
        saturation: 0.8,
      },
      inPoint: 0,
      inputPath: 'input.mp4',
      outPoint: 10,
      outputPath: 'export.mp4',
    });

    expect(args).toContain('eq=brightness=0.100:contrast=1.200:saturation=0.800');
  });

  it('keeps the source extension for ffmpeg input names', () => {
    const file = new File(['abc'], 'Clip.MOV');

    expect(createTranscodeInputName(file)).toBe('input.mov');
  });

  it('builds a segment command with trim, effects, text, and audio filters', () => {
    const args = buildTimelineSegmentArgs({
      clip: {
        assetId: 'asset-a',
        effects: {
          brightness: 0.1,
          contrast: 1.1,
          saturation: 0.9,
        },
        fadeIn: 0.5,
        fadeOut: 1,
        id: 'clip-a',
        muted: false,
        sourceIn: 2,
        sourceOut: 7,
        timelineStart: 10,
        trackId: 'video-1',
        transform: { scale: 1.2, x: 0.45, y: 0.35 },
        volume: 0.75,
      },
      clipTimelineStart: 10,
      inputPath: 'asset-a.mp4',
      outputFps: 24,
      outputHeight: 1920,
      outputPath: 'segment-0.mp4',
      outputWidth: 1080,
      textOverlays: [
        {
          align: 'center',
          end: 13,
          id: 'text-a',
          size: 32,
          start: 11,
          text: 'Hello',
          x: 0.5,
          y: 0.2,
        },
      ],
    });

    expect(args.join(' ')).toContain('eq=brightness=0.100:contrast=1.100:saturation=0.900,drawtext:text=');
    expect(args.join(' ')).toContain('fps=24,scale=1080:1920');
    expect(args.join(' ')).toContain('scale=iw*1.2000:ih*1.2000');
    expect(args.join(' ')).toContain('crop=1080:1920:(iw-1080)*0.4500:(ih-1920)*0.3500');
    expect(args.join(' ')).toContain('volume=0.750,afade=t=in:st=0:d=0.500,afade=t=out:st=4.000:d=1.000');
    expect(args).toContain('segment-0.mp4');
  });

  it('builds audio filters for mute and fades', () => {
    expect(
      createAudioFilter({
        assetId: 'asset-a',
        effects: DEFAULT_EFFECT_SETTINGS,
        fadeIn: 0,
        fadeOut: 0.5,
        id: 'clip-a',
        muted: true,
        sourceIn: 0,
        sourceOut: 2,
        timelineStart: 0,
        trackId: 'video-1',
        transform: DEFAULT_CLIP_TRANSFORM,
        volume: 1,
      }),
    ).toBe('volume=0,afade=t=out:st=1.500:d=0.500');
  });

  it('builds a stream-copy segment for unedited passthrough clips', () => {
    const clip = {
      assetId: 'asset-a',
      effects: DEFAULT_EFFECT_SETTINGS,
      fadeIn: 0,
      fadeOut: 0,
      id: 'clip-a',
      muted: false,
      sourceIn: 2,
      sourceOut: 7,
      timelineStart: 0,
      trackId: 'video-1',
      transform: DEFAULT_CLIP_TRANSFORM,
      volume: 1,
    };

    expect(canCopyTimelineClip(clip)).toBe(true);
    expect(buildTimelineCopySegmentArgs({ clip, inputPath: 'input.mov', outputPath: 'segment.mp4' })).toEqual([
      '-ss',
      '2.000',
      '-i',
      'input.mov',
      '-t',
      '5.000',
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
      'segment.mp4',
    ]);
  });

  it('builds drawtext only when an overlay intersects the segment', () => {
    expect(
      createDrawTextFilter(
        {
          align: 'center',
          end: 2,
          id: 'text-a',
          size: 24,
          start: 1,
          text: 'Title',
          x: 0.5,
          y: 0.4,
        },
        10,
        3,
      ),
    ).toBeNull();
  });

  it('anchors drawtext at the alignment edge', () => {
    const make = (align: 'left' | 'center' | 'right') =>
      createDrawTextFilter({ align, end: 5, id: 't', size: 24, start: 0, text: 'X', x: 0.5, y: 0.5 }, 0, 5) ?? '';

    expect(make('left')).toContain('x=w*0.500');
    expect(make('left')).not.toContain('text_w');
    expect(make('center')).toContain('x=w*0.500-text_w/2');
    expect(make('right')).toContain('x=w*0.500-text_w');
  });

  it('builds concat inputs for rendered timeline segments', () => {
    expect(createTimelineConcatList(['segment-0.mp4', 'segment-1.mp4'])).toBe(
      "file 'segment-0.mp4'\nfile 'segment-1.mp4'",
    );
    expect(buildConcatArgs('concat.txt', 'export.mp4')).toEqual([
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      'concat.txt',
      '-c',
      'copy',
      '-movflags',
      'faststart',
      'export.mp4',
    ]);
  });

  it('builds a layered timeline filter graph for overlapping tracks', () => {
    const args = buildLayeredTimelineArgs({
      assets: [
        { id: 'asset-a', inputPath: 'a.mp4' },
        { id: 'asset-b', inputPath: 'b.mp4' },
      ],
      clips: [
        {
          assetId: 'asset-a',
          effects: DEFAULT_EFFECT_SETTINGS,
          fadeIn: 0,
          fadeOut: 0,
          id: 'clip-a',
          muted: false,
          sourceIn: 0,
          sourceOut: 4,
          timelineStart: 0,
          trackId: 'video-1',
          transform: DEFAULT_CLIP_TRANSFORM,
          volume: 1,
        },
        {
          assetId: 'asset-b',
          effects: { ...DEFAULT_EFFECT_SETTINGS, brightness: 0.1 },
          fadeIn: 0,
          fadeOut: 0,
          id: 'clip-b',
          muted: true,
          sourceIn: 1,
          sourceOut: 3,
          timelineStart: 1,
          trackId: 'video-2',
          transform: DEFAULT_CLIP_TRANSFORM,
          volume: 1,
        },
      ],
      outputHeight: 1920,
      outputPath: 'layered.mp4',
      outputWidth: 1080,
      textOverlays: [],
      trackOrder: ['video-1', 'video-2'],
    });
    const command = args.join(' ');

    expect(command).toContain('color=c=black:s=1080x1920');
    expect(command).toContain('overlay=0:0');
    expect(command).toContain('eq=brightness=0.100');
    expect(command).toContain('[base2]');
    expect(args).toContain('layered.mp4');
  });
});
