import { readFileSync } from 'node:fs';

function extractTypeFields(source, typeName) {
  const match = source.match(new RegExp(`export type ${typeName} = \\{([\\s\\S]*?)\\n\\};`));

  if (!match) {
    throw new Error(`Could not find exported type ${typeName}.`);
  }

  return [...match[1].matchAll(/^  ([A-Za-z][A-Za-z0-9_]*)[?:]:/gm)].map((field) => field[1]);
}

function createEditArrayCoverageCheck({ file, typeName, covered, omitted }) {
  return {
    description: `Edit Array Language covers ${typeName}`,
    file,
    test: (source) => {
      const ealSource = readFileSync('src/editArrayLanguage.ts', 'utf8');
      const fields = extractTypeFields(source, typeName);
      const declared = new Set([...covered, ...omitted]);
      const undeclared = fields.filter((field) => !declared.has(field));
      const missingFromGenerator = covered.filter((field) => !ealSource.includes(field));

      if (undeclared.length > 0 || missingFromGenerator.length > 0) {
        console.error(
          `EAL coverage failure for ${typeName}: undeclared=[${undeclared.join(', ')}], missingFromGenerator=[${missingFromGenerator.join(', ')}]`,
        );
        return false;
      }

      return true;
    },
  };
}

const checks = [
  {
    description: 'playback hot path is owned by timelineRuntime',
    file: 'src/App.tsx',
    test: (source) => source.includes('useTimelineRuntime') && !source.includes('requestAnimationFrame(tick)'),
  },
  {
    description: 'playhead uses direct transform refs',
    file: 'src/timelineRuntime.ts',
    test: (source) => source.includes('translate3d') && source.includes('requestVideoFrameCallback'),
  },
  {
    description: 'thumbnail encoding has worker path',
    file: 'src/useVideoThumbnails.ts',
    test: (source) => source.includes('new Worker') && source.includes('putCachedThumbnail'),
  },
  {
    description: 'performance HUD is wired',
    file: 'src/performanceMonitor.ts',
    test: (source) => source.includes('PerformanceObserver') && source.includes('longtask') && source.includes('setRenderedTimelineItems'),
  },
  {
    description: 'ffmpeg work is isolated in a worker',
    file: 'src/workers/transcodeWorker.ts',
    test: (source) => source.includes('@ffmpeg/ffmpeg') && source.includes("type: 'complete'"),
  },
  {
    description: 'timeline thumbnails are virtualized',
    file: 'src/App.tsx',
    test: (source) => source.includes('useVirtualizer') && source.includes('virtualThumbnails'),
  },
  {
    description: 'webgpu preview compositor is optional',
    file: 'src/previewCompositor.ts',
    test: (source) => source.includes('importExternalTexture') && source.includes('setGpuPreviewActive(false)'),
  },
  {
    description: 'Edit Array Language is persisted and exported',
    file: 'src/projectPersistence.ts',
    test: (source) =>
      source.includes('editArray') &&
      source.includes('createEditArrayFromRuntime') &&
      source.includes('edit-array.json'),
  },
  {
    description: 'Edit Array Language has live editor inspection',
    file: 'src/App.tsx',
    test: (source) => source.includes('edit-array-textarea') && source.includes('createEditArrayFromRuntime'),
  },
  createEditArrayCoverageCheck({
    covered: ['id', 'name', 'kind', 'type', 'size', 'duration', 'width', 'height'],
    file: 'src/projectModel.ts',
    omitted: ['file', 'originalUrl', 'playbackUrl', 'posterUrl', 'proxyStatus', 'proxyUrl'],
    typeName: 'ProjectAsset',
  }),
  createEditArrayCoverageCheck({
    covered: ['id', 'assetId', 'trackId', 'timelineStart', 'sourceIn', 'sourceOut', 'volume', 'muted', 'fadeIn', 'fadeOut', 'effects', 'transform'],
    file: 'src/projectModel.ts',
    omitted: [],
    typeName: 'TimelineClip',
  }),
  createEditArrayCoverageCheck({
    covered: ['id', 'kind', 'name', 'index', 'muted', 'locked', 'visible'],
    file: 'src/projectModel.ts',
    omitted: [],
    typeName: 'TimelineTrack',
  }),
  createEditArrayCoverageCheck({
    covered: ['id', 'text', 'start', 'end', 'x', 'y', 'size', 'align'],
    file: 'src/projectModel.ts',
    omitted: [],
    typeName: 'TextOverlay',
  }),
  createEditArrayCoverageCheck({
    covered: ['assets', 'clips', 'textOverlays', 'tracks'],
    file: 'src/projectModel.ts',
    omitted: ['selectedAssetId', 'selectedClipId', 'selectedTextId', 'selectedTrackId'],
    typeName: 'ProjectPresent',
  }),
  createEditArrayCoverageCheck({
    covered: ['id', 'name', 'kind', 'type', 'size', 'duration', 'width', 'height', 'fingerprint', 'mediaKey', 'posterKey'],
    file: 'src/projectPersistence.ts',
    omitted: [],
    typeName: 'PersistedAsset',
  }),
  createEditArrayCoverageCheck({
    covered: ['width', 'height', 'fps', 'sampleRate'],
    file: 'src/projectPersistence.ts',
    omitted: [],
    typeName: 'ProjectSettings',
  }),
];

const failures = checks.filter((check) => !check.test(readFileSync(check.file, 'utf8')));

if (failures.length > 0) {
  console.error('Performance gate failed:');
  failures.forEach((failure) => console.error(`- ${failure.description}`));
  process.exit(1);
}

console.log('Performance gate passed.');
