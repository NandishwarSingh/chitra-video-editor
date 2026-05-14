const DB_NAME = 'chitra-project-store';
import type { ProjectRecord } from './projectPersistence';

const DB_VERSION = 5;
const THUMBNAIL_STORE = 'thumbnail-cache';
const PROXY_STORE = 'proxy-cache';
const JOB_METADATA_STORE = 'job-metadata';
const PROJECTS_STORE = 'projects';
const PROJECT_MEDIA_STORE = 'project-media';
const PROJECT_POSTERS_STORE = 'project-posters';
const TRANSCRIPT_STORE = 'asset-transcripts';
const BEAT_STORE = 'asset-beats';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb() {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(THUMBNAIL_STORE)) {
        db.createObjectStore(THUMBNAIL_STORE);
      }

      if (!db.objectStoreNames.contains(PROXY_STORE)) {
        db.createObjectStore(PROXY_STORE);
      }

      if (!db.objectStoreNames.contains(JOB_METADATA_STORE)) {
        db.createObjectStore(JOB_METADATA_STORE);
      }

      if (!db.objectStoreNames.contains(PROJECTS_STORE)) {
        db.createObjectStore(PROJECTS_STORE, { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains(PROJECT_MEDIA_STORE)) {
        db.createObjectStore(PROJECT_MEDIA_STORE);
      }

      if (!db.objectStoreNames.contains(PROJECT_POSTERS_STORE)) {
        db.createObjectStore(PROJECT_POSTERS_STORE);
      }

      if (!db.objectStoreNames.contains(TRANSCRIPT_STORE)) {
        db.createObjectStore(TRANSCRIPT_STORE);
      }

      if (!db.objectStoreNames.contains(BEAT_STORE)) {
        db.createObjectStore(BEAT_STORE);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}

async function runTransaction<T>(
  storeName: string,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
) {
  const db = await openDb();

  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    const request = action(store);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getCachedThumbnail(key: string) {
  try {
    return (await runTransaction<Blob | undefined>(THUMBNAIL_STORE, 'readonly', (store) => store.get(key))) ?? null;
  } catch {
    return null;
  }
}

export async function putCachedThumbnail(key: string, blob: Blob) {
  try {
    await runTransaction<IDBValidKey>(THUMBNAIL_STORE, 'readwrite', (store) => store.put(blob, key));
  } catch {
    // Caching should never block editing.
  }
}

export function createThumbnailCacheKey(mediaFingerprint: string, time: number, width: number) {
  return `thumbnail:v1:${mediaFingerprint}:${time.toFixed(2)}:${width}`;
}

export async function getCachedProxy(key: string) {
  try {
    return (await runTransaction<Blob | undefined>(PROXY_STORE, 'readonly', (store) => store.get(key))) ?? null;
  } catch {
    return null;
  }
}

export async function putCachedProxy(key: string, blob: Blob) {
  try {
    await runTransaction<IDBValidKey>(PROXY_STORE, 'readwrite', (store) => store.put(blob, key));
  } catch {
    // Proxy caching should never block editing.
  }
}

export async function deleteCachedProxy(key: string) {
  try {
    await runTransaction<undefined>(PROXY_STORE, 'readwrite', (store) => store.delete(key));
  } catch {
    // Cache cleanup should never block editing.
  }
}

export async function putJobMetadata(key: string, metadata: Record<string, unknown>) {
  try {
    await runTransaction<IDBValidKey>(JOB_METADATA_STORE, 'readwrite', (store) => store.put(metadata, key));
  } catch {
    // Job metadata is useful for diagnostics, not required for editing.
  }
}

export function createProxyCacheKey(mediaFingerprint: string, targetHeight: number) {
  return `proxy:v2:${mediaFingerprint}:${targetHeight}`;
}

export async function listProjectRecords() {
  try {
    const records = await runTransaction<ProjectRecord[]>(PROJECTS_STORE, 'readonly', (store) => store.getAll());

    return records.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export async function getProjectRecord(id: string) {
  try {
    return (await runTransaction<ProjectRecord | undefined>(PROJECTS_STORE, 'readonly', (store) => store.get(id))) ?? null;
  } catch {
    return null;
  }
}

export async function putProjectRecord(record: ProjectRecord) {
  await runTransaction<IDBValidKey>(PROJECTS_STORE, 'readwrite', (store) => store.put(record));
}

export async function deleteProjectRecord(id: string) {
  await runTransaction<undefined>(PROJECTS_STORE, 'readwrite', (store) => store.delete(id));
}

export function createProjectMediaKey(projectId: string, assetId: string) {
  return `${projectId}:${assetId}:source`;
}

export function createProjectPosterKey(projectId: string, assetId: string) {
  return `${projectId}:${assetId}:poster`;
}

export async function putProjectMediaBlob(key: string, blob: Blob) {
  await runTransaction<IDBValidKey>(PROJECT_MEDIA_STORE, 'readwrite', (store) => store.put(blob, key));
}

export async function getProjectMediaBlob(key: string) {
  return (await runTransaction<Blob | undefined>(PROJECT_MEDIA_STORE, 'readonly', (store) => store.get(key))) ?? null;
}

export async function listProjectMediaKeys(projectId: string) {
  try {
    const keys = await runTransaction<IDBValidKey[]>(PROJECT_MEDIA_STORE, 'readonly', (store) => store.getAllKeys());
    const prefix = `${projectId}:`;

    return keys.filter((key): key is string => typeof key === 'string' && key.startsWith(prefix) && key.endsWith(':source'));
  } catch {
    return [];
  }
}

export async function deleteProjectMediaBlob(key: string) {
  await runTransaction<undefined>(PROJECT_MEDIA_STORE, 'readwrite', (store) => store.delete(key));
}

export async function putProjectPosterBlob(key: string, blob: Blob) {
  await runTransaction<IDBValidKey>(PROJECT_POSTERS_STORE, 'readwrite', (store) => store.put(blob, key));
}

export async function getProjectPosterBlob(key: string) {
  return (await runTransaction<Blob | undefined>(PROJECT_POSTERS_STORE, 'readonly', (store) => store.get(key))) ?? null;
}

export async function deleteProjectPosterBlob(key: string) {
  await runTransaction<undefined>(PROJECT_POSTERS_STORE, 'readwrite', (store) => store.delete(key));
}

export async function deleteProjectBlobs(record: ProjectRecord) {
  await Promise.allSettled([
    ...record.document.assets.map((asset) => deleteProjectMediaBlob(asset.mediaKey)),
    ...record.document.assets
      .filter((asset) => asset.posterKey)
      .map((asset) => deleteProjectPosterBlob(asset.posterKey as string)),
  ]);
}

export type StoredTranscriptWord = {
  end: number;
  start: number;
  word: string;
};

export type StoredTranscriptSegment = {
  end: number;
  start: number;
  text: string;
};

export type StoredAssetTranscript = {
  createdAt: number;
  duration: number | null;
  language: string | null;
  model: string;
  provider: string;
  segments: StoredTranscriptSegment[];
  text: string;
  words: StoredTranscriptWord[];
};

// Transcripts are keyed by the asset's content fingerprint so re-importing
// the same media file (across projects, browser reloads, even between IndexedDB
// migrations) immediately picks up the cached transcript without a re-spend.
export async function putAssetTranscript(fingerprint: string, transcript: StoredAssetTranscript) {
  await runTransaction<IDBValidKey>(TRANSCRIPT_STORE, 'readwrite', (store) =>
    store.put(transcript, fingerprint),
  );
}

export async function getAssetTranscript(fingerprint: string): Promise<StoredAssetTranscript | null> {
  try {
    return (
      (await runTransaction<StoredAssetTranscript | undefined>(TRANSCRIPT_STORE, 'readonly', (store) =>
        store.get(fingerprint),
      )) ?? null
    );
  } catch {
    return null;
  }
}

export async function deleteAssetTranscript(fingerprint: string) {
  await runTransaction<undefined>(TRANSCRIPT_STORE, 'readwrite', (store) => store.delete(fingerprint));
}

export type StoredBeatData = {
  beats: number[];
  bpm: number | null;
  createdAt: number;
  duration: number;
  sampleRate: number;
};

export async function putAssetBeats(fingerprint: string, beats: StoredBeatData) {
  await runTransaction<IDBValidKey>(BEAT_STORE, 'readwrite', (store) => store.put(beats, fingerprint));
}

export async function getAssetBeats(fingerprint: string): Promise<StoredBeatData | null> {
  try {
    return (
      (await runTransaction<StoredBeatData | undefined>(BEAT_STORE, 'readonly', (store) =>
        store.get(fingerprint),
      )) ?? null
    );
  } catch {
    return null;
  }
}

export async function deleteAssetBeats(fingerprint: string) {
  await runTransaction<undefined>(BEAT_STORE, 'readwrite', (store) => store.delete(fingerprint));
}
