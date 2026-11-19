import type { OfflineMediaFile } from '../types/media';

export type MediaTypeFilter = 'all' | 'video' | 'audio';

export function filterOfflineMediaFiles(
  files: OfflineMediaFile[],
  mediaFilter: MediaTypeFilter,
  searchQuery: string
): OfflineMediaFile[] {
  const normalizedQuery = searchQuery.trim().toLowerCase();

  return files.filter((file) => {
    if (mediaFilter !== 'all' && file.mediaType !== mediaFilter) {
      return false;
    }
    if (normalizedQuery.length > 0) {
      const matchesTitle = file.title.toLowerCase().includes(normalizedQuery);
      const matchesUploader = file.uploader.toLowerCase().includes(normalizedQuery);
      return matchesTitle || matchesUploader;
    }
    return true;
  });
}

export function shuffleItems<T>(items: readonly T[], rng: () => number = Math.random): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = copy[i];
    copy[i] = copy[j];
    copy[j] = tmp;
  }
  return copy;
}
