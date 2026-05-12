import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { createEditArrayFromDocument, createEditArrayFromRuntime, stringifyEditArray, type EditArrayProgram } from './editArrayLanguage';
import { createMediaFingerprint, createTypedVideoFile, inferVideoMimeType } from './mediaEngine';
import {
  createDefaultTracks,
  createInitialProject,
  idleJobStatus,
  normalizeTimelineClips,
  normalizeTimelineClip,
  normalizeTimelineTracks,
  type ProjectAsset,
  type ProjectHistory,
  type ProjectPresent,
  type TextOverlay,
  type TimelineClip,
  type TimelineTrack,
} from './projectModel';
import {
  createProjectMediaKey,
  createProjectPosterKey,
  deleteProjectBlobs,
  deleteProjectMediaBlob,
  deleteProjectPosterBlob,
  deleteProjectRecord,
  getProjectMediaBlob,
  getProjectPosterBlob,
  listProjectMediaKeys,
  putProjectMediaBlob,
  putProjectPosterBlob,
  putProjectRecord,
} from './projectStore';

export const PROJECT_SCHEMA_VERSION = 1;
export const PROJECT_PACKAGE_VERSION = 1;

export type ProjectSettings = {
  fps: number;
  height: number;
  sampleRate: 48000;
  width: number;
};

export type PersistedAsset = {
  duration: number;
  fingerprint: string;
  height: number;
  id: string;
  mediaKey: string;
  name: string;
  posterKey: string | null;
  size: number;
  type: string;
  width: number;
};

export type PersistedProjectDocument = {
  assets: PersistedAsset[];
  clips: TimelineClip[];
  textOverlays: TextOverlay[];
  tracks: TimelineTrack[];
};

export type ProjectRecord = {
  createdAt: number;
  document: PersistedProjectDocument;
  editArray: EditArrayProgram;
  id: string;
  name: string;
  schemaVersion: 1;
  settings: ProjectSettings;
  updatedAt: number;
};

export type HydratedProject = {
  canAutosave: boolean;
  history: ProjectHistory;
  objectUrls: string[];
  recoveryMessage: string | null;
};

type ChitraManifest = {
  exportedAt: number;
  mediaPaths: Record<string, string>;
  packageSchemaVersion: 1;
  posterPaths: Record<string, string>;
  project: ProjectRecord;
};

function uint8ToArrayBuffer(bytes: Uint8Array) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export const PROJECT_PRESETS = {
  landscape: { fps: 30, height: 1080, sampleRate: 48000, width: 1920 } satisfies ProjectSettings,
  square: { fps: 30, height: 1080, sampleRate: 48000, width: 1080 } satisfies ProjectSettings,
  vertical: { fps: 30, height: 1920, sampleRate: 48000, width: 1080 } satisfies ProjectSettings,
};

export function createProjectId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `project-${crypto.randomUUID()}`;
  }

  return `project-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createBlankProjectRecord(name: string, settings: ProjectSettings = PROJECT_PRESETS.vertical): ProjectRecord {
  const now = Date.now();

  return {
    createdAt: now,
    document: {
      assets: [],
      clips: [],
      textOverlays: [],
      tracks: createDefaultTracks(),
    },
    editArray: createEditArrayFromDocument(
      {
        assets: [],
        clips: [],
        textOverlays: [],
        tracks: createDefaultTracks(),
      },
      settings,
      name.trim() || 'Untitled Project',
    ),
    id: createProjectId(),
    name: name.trim() || 'Untitled Project',
    schemaVersion: PROJECT_SCHEMA_VERSION,
    settings,
    updatedAt: now,
  };
}

export function sortProjectRecords(records: ProjectRecord[]) {
  return [...records].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function serializeRuntimeProject(project: ProjectPresent, projectId: string): PersistedProjectDocument {
  return {
    assets: project.assets.map((asset) => ({
      duration: asset.duration,
      fingerprint: createMediaFingerprint(asset.file, asset.duration),
      height: asset.height,
      id: asset.id,
      mediaKey: createProjectMediaKey(projectId, asset.id),
      name: asset.name,
      posterKey: asset.posterUrl ? createProjectPosterKey(projectId, asset.id) : null,
      size: asset.size,
      type: inferVideoMimeType(asset.file.name || asset.name, asset.type || asset.file.type),
      width: asset.width,
    })),
    clips: project.clips.map((clip) => normalizeTimelineClip(clip)),
    textOverlays: project.textOverlays.map((overlay) => ({ ...overlay })),
    tracks: normalizeTimelineTracks(project.tracks),
  };
}

export async function storeRuntimeAssetBlobs(projectId: string, asset: ProjectAsset) {
  await putProjectMediaBlob(
    createProjectMediaKey(projectId, asset.id),
    createTypedVideoFile(asset.file, asset.file.name || asset.name, asset.file.lastModified, asset.type || asset.file.type),
  );

  if (asset.posterUrl?.startsWith('data:')) {
    await putProjectPosterBlob(createProjectPosterKey(projectId, asset.id), dataUrlToBlob(asset.posterUrl));
  }
}

export async function storeRuntimePoster(projectId: string, assetId: string, posterUrl: string | null) {
  if (!posterUrl?.startsWith('data:')) {
    return;
  }

  await putProjectPosterBlob(createProjectPosterKey(projectId, assetId), dataUrlToBlob(posterUrl));
}

export async function deleteRuntimeAssetBlobs(projectId: string, assetId: string) {
  await Promise.allSettled([
    deleteProjectMediaBlob(createProjectMediaKey(projectId, assetId)),
    deleteProjectPosterBlob(createProjectPosterKey(projectId, assetId)),
  ]);
}

export async function deleteOrphanProjectMediaBlobs(projectId: string, activeAssetIds: string[]) {
  const activeAssetIdSet = new Set(activeAssetIds);
  const mediaKeys = await listProjectMediaKeys(projectId);

  await Promise.allSettled(
    mediaKeys
      .filter((key) => {
        const [, assetId] = key.split(':');

        return assetId && !activeAssetIdSet.has(assetId);
      })
      .map((key) => deleteProjectMediaBlob(key)),
  );
}

export async function saveRuntimeProjectRecord(
  record: ProjectRecord,
  project: ProjectPresent,
  name: string,
  settings: ProjectSettings,
  options: { allowAssetLoss?: boolean } = {},
) {
  if (record.document.assets.length > 0 && project.assets.length === 0 && !options.allowAssetLoss) {
    throw new Error('Refusing to autosave an empty media state over a project that still has persisted assets.');
  }

  const nextRecord: ProjectRecord = {
    ...record,
    document: serializeRuntimeProject(project, record.id),
    editArray: createEditArrayFromRuntime(project, settings, name.trim() || 'Untitled Project'),
    name: name.trim() || 'Untitled Project',
    settings,
    updatedAt: Date.now(),
  };

  await putProjectRecord(nextRecord);
  void deleteOrphanProjectMediaBlobs(record.id, nextRecord.document.assets.map((asset) => asset.id));
  return nextRecord;
}

export function shouldRecoverOrphanProjectMedia(persistedAssetCount: number, hydratedAssetCount: number) {
  return persistedAssetCount > 0 && hydratedAssetCount === 0;
}

export async function hydrateProjectRecord(record: ProjectRecord): Promise<HydratedProject> {
  const objectUrls: string[] = [];
  const assets: ProjectAsset[] = [];
  const tracks = normalizeTimelineTracks(record.document.tracks);
  const missingAssetNames: string[] = [];
  const seenAssetIds = new Set<string>();

  for (const asset of record.document.assets) {
    const mediaBlob = await getProjectMediaBlob(asset.mediaKey);

    if (!mediaBlob) {
      missingAssetNames.push(asset.name);
      continue;
    }

    const posterBlob = asset.posterKey ? await getProjectPosterBlob(asset.posterKey) : null;
    seenAssetIds.add(asset.id);
    assets.push(createRuntimeAssetFromPersisted(asset, mediaBlob, posterBlob, (blob) => {
      const url = URL.createObjectURL(blob);
      objectUrls.push(url);
      return url;
    }));
  }

  const recoveredAssets = shouldRecoverOrphanProjectMedia(record.document.assets.length, assets.length)
    ? await recoverOrphanProjectAssets(record, seenAssetIds, (blob) => {
        const url = URL.createObjectURL(blob);
        objectUrls.push(url);
        return url;
      })
    : [];
  assets.push(...recoveredAssets);

  const clips = normalizeTimelineClips(record.document.clips, tracks).filter((clip) =>
    assets.some((asset) => asset.id === clip.assetId),
  );
  const recoveryMessage =
    missingAssetNames.length > 0
      ? `Missing embedded media for ${missingAssetNames.length} asset${missingAssetNames.length === 1 ? '' : 's'}; loaded what could be recovered.`
      : recoveredAssets.length > 0
        ? `Recovered ${recoveredAssets.length} orphaned media asset${recoveredAssets.length === 1 ? '' : 's'} from local storage.`
        : null;

  return {
    canAutosave: missingAssetNames.length === 0 && recoveredAssets.length === 0,
    history: {
      ...createInitialProject(),
      present: {
        assets,
        clips,
        selectedAssetId: assets[0]?.id ?? null,
        selectedClipId: null,
        selectedTextId: null,
        selectedTrackId: tracks[0]?.id ?? null,
        textOverlays: record.document.textOverlays,
        tracks,
      },
    },
    objectUrls,
    recoveryMessage,
  };
}

export function isProjectFullyHydrated(project: { assets: Array<{ duration: number; width: number; height: number }> }) {
  return project.assets.every((asset) => asset.duration > 0 && asset.width > 0 && asset.height > 0);
}

async function recoverOrphanProjectAssets(
  record: ProjectRecord,
  existingAssetIds: Set<string>,
  createObjectUrl: (blob: Blob) => string,
) {
  const keys = await listProjectMediaKeys(record.id);
  const recovered: ProjectAsset[] = [];

  for (const key of keys) {
    const [, assetId] = key.split(':');

    if (!assetId || existingAssetIds.has(assetId) || record.document.assets.some((asset) => asset.id === assetId)) {
      continue;
    }

    const mediaBlob = await getProjectMediaBlob(key);

    if (!mediaBlob) {
      continue;
    }

    const fileName = mediaBlob instanceof File && mediaBlob.name ? mediaBlob.name : `${assetId}.mp4`;
    recovered.push(
      createRuntimeAssetFromPersisted(
        {
          duration: 0,
          fingerprint: '',
          height: 0,
          id: assetId,
          mediaKey: key,
          name: fileName,
          posterKey: null,
          size: mediaBlob.size,
          type: inferVideoMimeType(fileName, mediaBlob.type),
          width: 0,
        },
        mediaBlob,
        null,
        createObjectUrl,
      ),
    );
  }

  return recovered;
}

export function createRuntimeAssetFromPersisted(
  asset: PersistedAsset,
  mediaBlob: Blob,
  posterBlob: Blob | null,
  createObjectUrl: (blob: Blob) => string,
): ProjectAsset {
  const file = createTypedVideoFile(mediaBlob, asset.name, Date.now(), asset.type || mediaBlob.type);
  const originalUrl = createObjectUrl(file);
  const posterUrl = posterBlob ? createObjectUrl(posterBlob) : null;

  return {
    duration: asset.duration,
    file,
    height: asset.height,
    id: asset.id,
    name: asset.name,
    originalUrl,
    playbackUrl: originalUrl,
    posterUrl,
    proxyStatus: idleJobStatus,
    proxyUrl: null,
    size: asset.size,
    type: file.type,
    width: asset.width,
  };
}

export async function createProjectPackage(record: ProjectRecord) {
  const mediaPaths: Record<string, string> = {};
  const posterPaths: Record<string, string> = {};
  const files: Record<string, Uint8Array> = {};

  for (const asset of record.document.assets) {
    const mediaBlob = await getProjectMediaBlob(asset.mediaKey);

    if (!mediaBlob) {
      throw new Error(`Missing media for ${asset.name}.`);
    }

    const mediaPath = `media/${asset.id}/${asset.name}`;
    mediaPaths[asset.id] = mediaPath;
    files[mediaPath] = new Uint8Array(await mediaBlob.arrayBuffer());

    if (asset.posterKey) {
      const posterBlob = await getProjectPosterBlob(asset.posterKey);

      if (posterBlob) {
        const posterPath = `posters/${asset.id}.jpg`;
        posterPaths[asset.id] = posterPath;
        files[posterPath] = new Uint8Array(await posterBlob.arrayBuffer());
      }
    }
  }

  const manifest: ChitraManifest = {
    exportedAt: Date.now(),
    mediaPaths,
    packageSchemaVersion: PROJECT_PACKAGE_VERSION,
    posterPaths,
    project: record,
  };
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  files['edit-array.json'] = strToU8(stringifyEditArray(record.editArray ?? createEditArrayFromDocument(record.document, record.settings, record.name)));

  return new Blob([uint8ToArrayBuffer(zipSync(files))], { type: 'application/octet-stream' });
}

export async function importProjectPackage(file: File): Promise<ProjectRecord> {
  const unzipped = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const manifestBytes = unzipped['manifest.json'];

  if (!manifestBytes) {
    throw new Error('This is not a valid Chitra project package.');
  }

  const manifest = JSON.parse(strFromU8(manifestBytes)) as ChitraManifest;

  if (manifest.packageSchemaVersion !== PROJECT_PACKAGE_VERSION || manifest.project.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    throw new Error('Unsupported Chitra project version.');
  }

  const nextProjectId = createProjectId();
  const now = Date.now();
  const nextAssets: PersistedAsset[] = [];
  const mediaWrites: Array<{ blob: Blob; key: string }> = [];
  const posterWrites: Array<{ blob: Blob; key: string }> = [];

  for (const asset of manifest.project.document.assets) {
    const mediaPath = manifest.mediaPaths[asset.id];
    const mediaBytes = mediaPath ? unzipped[mediaPath] : null;

    if (!mediaBytes) {
      throw new Error(`Package is missing media for ${asset.name}.`);
    }

    const mediaKey = createProjectMediaKey(nextProjectId, asset.id);
    const posterPath = manifest.posterPaths[asset.id];
    const posterBytes = posterPath ? unzipped[posterPath] : null;
    const posterKey = posterBytes ? createProjectPosterKey(nextProjectId, asset.id) : null;

    mediaWrites.push({
      blob: new Blob([uint8ToArrayBuffer(mediaBytes)], { type: asset.type }),
      key: mediaKey,
    });

    if (posterBytes && posterKey) {
      posterWrites.push({
        blob: new Blob([uint8ToArrayBuffer(posterBytes)], { type: 'image/jpeg' }),
        key: posterKey,
      });
    }

    nextAssets.push({
      ...asset,
      mediaKey,
      posterKey,
    });
  }

  const nextRecord: ProjectRecord = {
    ...manifest.project,
    createdAt: now,
    document: {
      ...manifest.project.document,
      assets: nextAssets,
      tracks: normalizeTimelineTracks(manifest.project.document.tracks),
    },
    editArray:
      manifest.project.editArray ??
      createEditArrayFromDocument(
        {
          ...manifest.project.document,
          assets: nextAssets,
          tracks: normalizeTimelineTracks(manifest.project.document.tracks),
        },
        manifest.project.settings,
        manifest.project.name,
      ),
    id: nextProjectId,
    updatedAt: now,
  };

  await Promise.all([
    ...mediaWrites.map((write) => putProjectMediaBlob(write.key, write.blob)),
    ...posterWrites.map((write) => putProjectPosterBlob(write.key, write.blob)),
  ]);
  await putProjectRecord(nextRecord);

  return nextRecord;
}

export async function duplicateStoredProject(record: ProjectRecord) {
  const nextProjectId = createProjectId();
  const now = Date.now();
  const nextAssets: PersistedAsset[] = [];

  for (const asset of record.document.assets) {
    const mediaBlob = await getProjectMediaBlob(asset.mediaKey);

    if (!mediaBlob) {
      throw new Error(`Missing media for ${asset.name}.`);
    }

    const mediaKey = createProjectMediaKey(nextProjectId, asset.id);
    const posterKey = asset.posterKey ? createProjectPosterKey(nextProjectId, asset.id) : null;
    await putProjectMediaBlob(mediaKey, mediaBlob);

    if (asset.posterKey && posterKey) {
      const posterBlob = await getProjectPosterBlob(asset.posterKey);
      if (posterBlob) {
        await putProjectPosterBlob(posterKey, posterBlob);
      }
    }

    nextAssets.push({
      ...asset,
      mediaKey,
      posterKey,
    });
  }

  const nextRecord: ProjectRecord = {
    ...record,
    createdAt: now,
    document: {
      ...record.document,
      assets: nextAssets,
      tracks: normalizeTimelineTracks(record.document.tracks),
    },
    editArray: record.editArray ?? createEditArrayFromDocument(record.document, record.settings, record.name),
    id: nextProjectId,
    name: `${record.name} Copy`,
    updatedAt: now,
  };

  await putProjectRecord(nextRecord);
  return nextRecord;
}

export async function deleteStoredProject(record: ProjectRecord) {
  await deleteProjectBlobs(record);
  await deleteProjectRecord(record.id);
}

export function dataUrlToBlob(dataUrl: string) {
  const [header, data] = dataUrl.split(',');
  const mime = header.match(/data:([^;,]+)/)?.[1] ?? 'application/octet-stream';
  const isBase64 = /;\s*base64/i.test(header);

  if (!isBase64) {
    return new Blob([decodeURIComponent(data ?? '')], { type: mime });
  }

  const binary = atob(data ?? '');
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Blob([bytes], { type: mime });
}
