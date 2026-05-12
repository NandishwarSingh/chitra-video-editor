import { describe, expect, it } from 'vitest';
import {
  createMediaFingerprint,
  createTypedMediaFile,
  createTypedVideoFile,
  detectMediaKind,
  inferAudioMimeType,
  inferMediaMimeType,
  inferVideoMimeType,
  isSupportedAudioFile,
  isSupportedMediaFile,
  isSupportedVideoFile,
  shouldUsePreviewProxy,
} from './mediaEngine';

describe('media engine helpers', () => {
  it('creates stable media fingerprints from file metadata', () => {
    const file = new File(['abc'], 'clip.mp4', {
      lastModified: 123,
      type: 'video/mp4',
    });

    expect(createMediaFingerprint(file, 10)).toBe('clip.mp4:3:123:10.000');
  });

  it('recommends proxies for high-resolution or large files', () => {
    const smallFile = new File(['abc'], 'small.mp4');
    const largeFile = { size: 501 * 1024 * 1024 } as File;

    expect(shouldUsePreviewProxy(smallFile, 1920, 1080)).toBe(false);
    expect(shouldUsePreviewProxy(smallFile, 3840, 2160)).toBe(true);
    expect(shouldUsePreviewProxy(largeFile, 1920, 1080)).toBe(true);
    expect(shouldUsePreviewProxy(new File(['abc'], 'clip.mov', { type: 'video/quicktime' }), 1920, 1080)).toBe(false);
    expect(shouldUsePreviewProxy(new File(['abc'], 'clip.mov', { type: 'video/quicktime' }), 3840, 2160)).toBe(true);
  });

  it('infers playable video MIME types for reopened media', () => {
    expect(inferVideoMimeType('clip.mp4', '')).toBe('video/mp4');
    expect(inferVideoMimeType('clip.mov', 'application/octet-stream')).toBe('video/quicktime');
    expect(isSupportedVideoFile(new File(['abc'], 'folder/clip.webm', { type: '' }))).toBe(true);

    const typed = createTypedVideoFile(new Blob(['abc'], { type: '' }), 'folder/clip.mp4');
    expect(typed.name).toBe('clip.mp4');
    expect(typed.type).toBe('video/mp4');
  });

  it('recognises audio files by MIME and extension', () => {
    expect(isSupportedAudioFile(new File(['abc'], 'song.mp3', { type: 'audio/mpeg' }))).toBe(true);
    expect(isSupportedAudioFile(new File(['abc'], 'song.flac', { type: '' }))).toBe(true);
    expect(isSupportedAudioFile(new File(['abc'], 'clip.mp4', { type: 'video/mp4' }))).toBe(false);

    expect(isSupportedMediaFile(new File(['abc'], 'song.wav'))).toBe(true);
    expect(isSupportedMediaFile(new File(['abc'], 'clip.mov'))).toBe(true);
    expect(isSupportedMediaFile(new File(['abc'], 'readme.txt'))).toBe(false);
  });

  it('detects media kind from MIME or extension', () => {
    expect(detectMediaKind({ name: 'a.mp3', type: 'audio/mpeg' })).toBe('audio');
    expect(detectMediaKind({ name: 'a.wav', type: '' })).toBe('audio');
    expect(detectMediaKind({ name: 'a.mp4', type: 'video/mp4' })).toBe('video');
    expect(detectMediaKind({ name: 'a.mov', type: '' })).toBe('video');
    expect(detectMediaKind({ name: 'unknown', type: '' })).toBe('video');
  });

  it('infers audio MIME types from extensions', () => {
    expect(inferAudioMimeType('a.mp3', '')).toBe('audio/mpeg');
    expect(inferAudioMimeType('a.wav', 'application/octet-stream')).toBe('audio/wav');
    expect(inferAudioMimeType('a.flac', '')).toBe('audio/flac');
    expect(inferAudioMimeType('a.m4a', '')).toBe('audio/mp4');
  });

  it('chooses the right MIME inferrer via inferMediaMimeType', () => {
    expect(inferMediaMimeType('clip.mp4', '')).toBe('video/mp4');
    expect(inferMediaMimeType('song.mp3', '')).toBe('audio/mpeg');
  });

  it('preserves audio type when reopening a typed media file', () => {
    const typed = createTypedMediaFile(new Blob(['abc'], { type: '' }), 'song.mp3');
    expect(typed.name).toBe('song.mp3');
    expect(typed.type).toBe('audio/mpeg');
  });
});
