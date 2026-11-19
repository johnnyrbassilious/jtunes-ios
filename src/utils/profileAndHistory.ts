import type {
  ListenHistoryEntry,
  MediaItem,
  PlayableTrack,
  UserProfile,
} from '../types/media';

export const SEARCH_HISTORY_STORAGE_KEY = 'tubidy_search_history';
export const USER_PROFILE_STORAGE_KEY = 'tubidy_user_profile';
export const LISTEN_HISTORY_STORAGE_KEY = 'tubidy_listen_history';

const MAX_SEARCH_HISTORY = 12;
const MAX_LISTEN_HISTORY = 100;

export function getSavedSearchHistory(): string[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(SEARCH_HISTORY_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .slice(0, MAX_SEARCH_HISTORY);
  } catch {
    return [];
  }
}

export function addSearchHistoryEntry(query: string): string[] {
  const trimmed = query.trim();
  const existing = getSavedSearchHistory();
  if (!trimmed) {
    return existing;
  }
  const lower = trimmed.toLowerCase();
  const next = [
    trimmed,
    ...existing.filter((item) => item.toLowerCase() !== lower),
  ].slice(0, MAX_SEARCH_HISTORY);

  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(SEARCH_HISTORY_STORAGE_KEY, JSON.stringify(next));
  }
  return next;
}

export function removeSearchHistoryEntry(query: string): string[] {
  const lower = query.trim().toLowerCase();
  const next = getSavedSearchHistory().filter((item) => item.toLowerCase() !== lower);
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(SEARCH_HISTORY_STORAGE_KEY, JSON.stringify(next));
  }
  return next;
}

export function clearSearchHistory(): string[] {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(SEARCH_HISTORY_STORAGE_KEY, JSON.stringify([]));
  }
  return [];
}

export function getSavedUserProfile(): UserProfile | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(USER_PROFILE_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<UserProfile>;
    if (
      parsed &&
      typeof parsed.name === 'string' &&
      parsed.name.trim().length > 0
    ) {
      return {
        name: parsed.name.trim(),
        email: typeof parsed.email === 'string' ? parsed.email.trim() : '',
        provider:
          parsed.provider === 'google' || parsed.provider === 'apple'
            ? parsed.provider
            : 'local',
        signedInAt:
          typeof parsed.signedInAt === 'number' ? parsed.signedInAt : Date.now(),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveUserProfile(profile: UserProfile): UserProfile {
  const normalized: UserProfile = {
    name: profile.name.trim(),
    email: profile.email.trim(),
    provider: profile.provider,
    signedInAt: profile.signedInAt || Date.now(),
  };
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(USER_PROFILE_STORAGE_KEY, JSON.stringify(normalized));
  }
  return normalized;
}

export function clearUserProfile(): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(USER_PROFILE_STORAGE_KEY);
  }
}

export function getSavedListenHistory(): ListenHistoryEntry[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(LISTEN_HISTORY_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter(
        (entry): entry is ListenHistoryEntry =>
          Boolean(entry) &&
          typeof entry === 'object' &&
          typeof entry.id === 'string' &&
          typeof entry.title === 'string'
      )
      .slice(0, MAX_LISTEN_HISTORY);
  } catch {
    return [];
  }
}

export function recordListenHistoryEntry(
  entry: Omit<ListenHistoryEntry, 'timestamp'>
): ListenHistoryEntry[] {
  const existing = getSavedListenHistory();
  const nextEntry: ListenHistoryEntry = {
    ...entry,
    timestamp: Date.now(),
  };
  const deduped = existing.filter((item) => item.id !== entry.id);
  const next = [nextEntry, ...deduped].slice(0, MAX_LISTEN_HISTORY);
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(LISTEN_HISTORY_STORAGE_KEY, JSON.stringify(next));
  }
  return next;
}

export function clearListenHistory(): ListenHistoryEntry[] {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(LISTEN_HISTORY_STORAGE_KEY, JSON.stringify([]));
  }
  return [];
}

export function getTopListenedArtists(
  history: readonly ListenHistoryEntry[],
  limit = 5
): string[] {
  const scores = new Map<string, { label: string; score: number }>();
  history.forEach((item, index) => {
    const rawArtist = (item.uploader || '').replace(/\s*-\s*Topic$/i, '').trim();
    if (
      !rawArtist ||
      rawArtist.toLowerCase() === 'unknown uploader' ||
      rawArtist.toLowerCase() === 'unknown artist'
    ) {
      return;
    }
    const key = rawArtist.toLowerCase();
    const recencyWeight = Math.max(0.25, 1 - index * 0.04);
    const current = scores.get(key);
    if (current) {
      current.score += recencyWeight;
    } else {
      scores.set(key, { label: rawArtist, score: recencyWeight });
    }
  });

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.label);
}

export function getFuzzyLocalSuggestions(
  query: string,
  searchHistory: readonly string[],
  libraryTitles: readonly string[]
): string[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) {
    return [];
  }
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const seen = new Set<string>();
  const matches: Array<{ text: string; score: number }> = [];

  for (const candidate of [...searchHistory, ...libraryTitles]) {
    const clean = candidate.trim();
    if (!clean) {
      continue;
    }
    const lower = clean.toLowerCase();
    if (seen.has(lower) || lower === trimmed) {
      continue;
    }
    seen.add(lower);

    let score = 0;
    if (lower.startsWith(trimmed)) {
      score = 3;
    } else if (lower.includes(trimmed)) {
      score = 2;
    } else if (tokens.length > 0 && tokens.every((t) => lower.includes(t))) {
      score = 1;
    }

    if (score > 0) {
      matches.push({ text: clean, score });
    }
  }

  return matches
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map((m) => m.text);
}

export function normalizeSongTitleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(
      /\b(?:official\s+video|official\s+audio|music\s+video|lyric\s+video|lyrics|remix|live|acoustic|slowed|reverb|instrumental|cover|hd|4k|hq|audio|video)\b/gi,
      ' '
    )
    .replace(/\b(?:feat\.?|ft\.?)\s+[^-|]+/gi, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function filterDistinctRelatedItems(
  related: readonly MediaItem[],
  currentTrack: { id: string; title: string },
  existingIds: ReadonlySet<string>
): MediaItem[] {
  const currentKey = normalizeSongTitleKey(currentTrack.title);
  const seenKeys = new Set<string>();
  if (currentKey) {
    seenKeys.add(currentKey);
  }

  const distinct: MediaItem[] = [];
  for (const item of related) {
    if (item.id === currentTrack.id || existingIds.has(item.id)) {
      continue;
    }
    const key = normalizeSongTitleKey(item.title);
    if (currentKey && key && (key === currentKey || key.includes(currentKey) || currentKey.includes(key))) {
      continue;
    }
    if (key && seenKeys.has(key)) {
      continue;
    }
    if (key) {
      seenKeys.add(key);
    }
    distinct.push(item);
  }
  return distinct;
}

export function rebuildQueueForNewSelection(
  prevQueue: readonly PlayableTrack[],
  currentIndex: number,
  newTrack: PlayableTrack
): { queue: PlayableTrack[]; currentIndex: number } {
  // Keep tracks explicitly added by the user via Play Next / Add to Queue
  // that are still upcoming (or any manual track other than the new track)
  const manualUpcoming = prevQueue.filter(
    (track, idx) =>
      track.id !== newTrack.id &&
      track.queueOrigin === 'manual' &&
      idx !== currentIndex
  );

  const nextTrack: PlayableTrack = {
    ...newTrack,
    queueOrigin: newTrack.queueOrigin ?? 'manual',
  };

  return {
    queue: [nextTrack, ...manualUpcoming],
    currentIndex: 0,
  };
}

export function moveQueueItem(
  queue: readonly PlayableTrack[],
  fromIndex: number,
  toIndex: number,
  currentIndex: number
): { queue: PlayableTrack[]; currentIndex: number } {
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= queue.length ||
    toIndex >= queue.length ||
    fromIndex === toIndex
  ) {
    return { queue: [...queue], currentIndex };
  }

  const next = [...queue];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);

  let nextCurrent = currentIndex;
  if (currentIndex === fromIndex) {
    nextCurrent = toIndex;
  } else if (fromIndex < currentIndex && toIndex >= currentIndex) {
    nextCurrent = currentIndex - 1;
  } else if (fromIndex > currentIndex && toIndex <= currentIndex) {
    nextCurrent = currentIndex + 1;
  }

  return { queue: next, currentIndex: nextCurrent };
}
