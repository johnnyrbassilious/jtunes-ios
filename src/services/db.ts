import type { OfflineMediaFile, PlaylistRecord } from '../types/media';

const DB_NAME = 'TubidyOfflineDB';
const DB_VERSION = 1;
const MEDIA_STORE = 'mediaFiles';
const PLAYLISTS_STORE = 'playlists';

function openTubidyDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const idb = typeof window !== 'undefined' ? window.indexedDB : undefined;
    if (!idb) {
      reject(new Error('IndexedDB is not supported in this browser.'));
      return;
    }

    const request = idb.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MEDIA_STORE)) {
        db.createObjectStore(MEDIA_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(PLAYLISTS_STORE)) {
        db.createObjectStore(PLAYLISTS_STORE, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('Failed to open TubidyOfflineDB.'));
  });
}

export async function saveMediaToDB(record: OfflineMediaFile): Promise<void> {
  const db = await openTubidyDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MEDIA_STORE, 'readwrite');
    tx.objectStore(MEDIA_STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error ?? new Error('Failed to save media file to TubidyOfflineDB.'));
  });
}

export async function getAllMediaFromDB(): Promise<OfflineMediaFile[]> {
  const db = await openTubidyDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MEDIA_STORE, 'readonly');
    const request = tx.objectStore(MEDIA_STORE).getAll();
    request.onsuccess = () => {
      const files = (request.result as OfflineMediaFile[]) ?? [];
      files.sort((a, b) => b.createdAt - a.createdAt);
      resolve(files);
    };
    request.onerror = () =>
      reject(request.error ?? new Error('Failed to read media files from TubidyOfflineDB.'));
  });
}

export async function deleteMediaFromDB(id: string): Promise<void> {
  const db = await openTubidyDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MEDIA_STORE, 'readwrite');
    tx.objectStore(MEDIA_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error ?? new Error('Failed to delete media file from TubidyOfflineDB.'));
  });
}

export async function clearAllMediaFromDB(): Promise<void> {
  const db = await openTubidyDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([MEDIA_STORE, PLAYLISTS_STORE], 'readwrite');
    tx.objectStore(MEDIA_STORE).clear();
    tx.objectStore(PLAYLISTS_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error ?? new Error('Failed to clear TubidyOfflineDB storage.'));
  });
}

export async function savePlaylistToDB(playlist: PlaylistRecord): Promise<void> {
  const db = await openTubidyDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PLAYLISTS_STORE, 'readwrite');
    tx.objectStore(PLAYLISTS_STORE).put(playlist);
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error ?? new Error('Failed to save playlist to TubidyOfflineDB.'));
  });
}

export async function getAllPlaylistsFromDB(): Promise<PlaylistRecord[]> {
  const db = await openTubidyDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PLAYLISTS_STORE, 'readonly');
    const request = tx.objectStore(PLAYLISTS_STORE).getAll();
    request.onsuccess = () => {
      const playlists = (request.result as PlaylistRecord[]) ?? [];
      playlists.sort((a, b) => b.createdAt - a.createdAt);
      resolve(playlists);
    };
    request.onerror = () =>
      reject(request.error ?? new Error('Failed to read playlists from TubidyOfflineDB.'));
  });
}

export async function deletePlaylistFromDB(id: string): Promise<void> {
  const db = await openTubidyDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PLAYLISTS_STORE, 'readwrite');
    tx.objectStore(PLAYLISTS_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error ?? new Error('Failed to delete playlist from TubidyOfflineDB.'));
  });
}

export function calculateMediaStorageStats(files: OfflineMediaFile[]): {
  count: number;
  totalBytes: number;
} {
  let totalBytes = 0;
  for (const file of files) {
    totalBytes += file.sizeBytes || file.blob?.size || 0;
  }
  return { count: files.length, totalBytes };
}
