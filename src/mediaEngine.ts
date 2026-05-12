export type MediaCapabilitiesSnapshot = {
  webCodecs: boolean;
  webGpu: boolean;
  wasm: boolean;
  offscreenCanvas: boolean;
  requestVideoFrameCallback: boolean;
};

type VideoElementWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: VideoFrameRequestCallback) => number;
};

export function detectMediaCapabilities(): MediaCapabilitiesSnapshot {
  const video = document.createElement('video') as VideoElementWithFrameCallback;

  return {
    webCodecs: 'VideoDecoder' in window && 'VideoFrame' in window,
    webGpu: 'gpu' in navigator,
    wasm: typeof WebAssembly !== 'undefined',
    offscreenCanvas: 'OffscreenCanvas' in window,
    requestVideoFrameCallback: typeof video.requestVideoFrameCallback === 'function',
  };
}

export function createMediaFingerprint(file: File, duration: number) {
  return `${file.name}:${file.size}:${file.lastModified}:${duration.toFixed(3)}`;
}

export function inferVideoMimeType(name: string, type = '') {
  const normalizedType = type.trim().toLowerCase();

  if (normalizedType.startsWith('video/') && normalizedType !== 'video') {
    return normalizedType;
  }

  const extension = name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? '';

  switch (extension) {
    case '.mp4':
    case '.m4v':
      return 'video/mp4';
    case '.mov':
      return 'video/quicktime';
    case '.webm':
      return 'video/webm';
    case '.mkv':
      return 'video/x-matroska';
    case '.avi':
      return 'video/x-msvideo';
    case '.3gp':
      return 'video/3gpp';
    default:
      return normalizedType.startsWith('video/') ? normalizedType : 'video/mp4';
  }
}

export function inferAudioMimeType(name: string, type = '') {
  const normalizedType = type.trim().toLowerCase();

  if (normalizedType.startsWith('audio/') && normalizedType !== 'audio') {
    return normalizedType;
  }

  const extension = name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? '';

  switch (extension) {
    case '.mp3':
      return 'audio/mpeg';
    case '.wav':
      return 'audio/wav';
    case '.m4a':
      return 'audio/mp4';
    case '.aac':
      return 'audio/aac';
    case '.ogg':
    case '.oga':
      return 'audio/ogg';
    case '.flac':
      return 'audio/flac';
    case '.opus':
      return 'audio/opus';
    default:
      return normalizedType.startsWith('audio/') ? normalizedType : 'audio/mpeg';
  }
}

export type MediaKind = 'audio' | 'video';

export function detectMediaKind(file: Pick<File, 'name' | 'type'>): MediaKind {
  const type = (file.type || '').toLowerCase();

  if (type.startsWith('audio/')) {
    return 'audio';
  }

  if (type.startsWith('video/')) {
    return 'video';
  }

  return /\.(mp3|wav|m4a|aac|ogg|oga|flac|opus)$/i.test(file.name) ? 'audio' : 'video';
}

export function inferMediaMimeType(name: string, type = '') {
  return detectMediaKind({ name, type }) === 'audio' ? inferAudioMimeType(name, type) : inferVideoMimeType(name, type);
}

export function isSupportedVideoFile(file: File) {
  return file.type.startsWith('video/') || /\.(mp4|m4v|mov|webm|mkv|avi|3gp)$/i.test(file.name);
}

export function isSupportedAudioFile(file: File) {
  return file.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|oga|flac|opus)$/i.test(file.name);
}

export function isSupportedMediaFile(file: File) {
  return isSupportedVideoFile(file) || isSupportedAudioFile(file);
}

export function createTypedVideoFile(blob: Blob, name: string, lastModified = Date.now(), type = blob.type) {
  const filename = name.split('/').pop() || name || 'video.mp4';
  const inferredType = inferVideoMimeType(filename, type);

  if (blob instanceof File && blob.name === filename && blob.type === inferredType) {
    return blob;
  }

  return new File([blob], filename, {
    lastModified,
    type: inferredType,
  });
}

export function createTypedMediaFile(blob: Blob, name: string, lastModified = Date.now(), type = blob.type) {
  const filename = name.split('/').pop() || name || 'media';
  const kind = detectMediaKind({ name: filename, type });
  const inferredType = kind === 'audio' ? inferAudioMimeType(filename, type) : inferVideoMimeType(filename, type);

  if (blob instanceof File && blob.name === filename && blob.type === inferredType) {
    return blob;
  }

  return new File([blob], filename, {
    lastModified,
    type: inferredType,
  });
}

const previewSupportCache = new Map<string, boolean>();

function canPreviewNatively(mimeType: string) {
  if (typeof document === 'undefined') {
    return false;
  }

  const cached = previewSupportCache.get(mimeType);

  if (cached !== undefined) {
    return cached;
  }

  const support = document.createElement('video').canPlayType(mimeType);
  const playable = support === 'probably' || support === 'maybe';
  previewSupportCache.set(mimeType, playable);

  return playable;
}

export function shouldUsePreviewProxy(file: File, width: number, height: number) {
  const megapixels = (width * height) / 1_000_000;
  const largeFile = file.size > 500 * 1024 * 1024;
  const highResolution = megapixels >= 8;
  const fileName = file.name || '';
  const effectiveType = inferVideoMimeType(fileName, file.type || '').toLowerCase();
  const canPlayOriginal = canPreviewNatively(effectiveType);
  const extensionNeedsProxy = /\.(mkv|avi|3gp)$/i.test(fileName) && !canPlayOriginal;
  const containerNeedsProxy = !canPlayOriginal && !['video/mp4', 'video/webm', 'video/quicktime'].includes(effectiveType);

  return largeFile || highResolution || extensionNeedsProxy || containerNeedsProxy;
}
