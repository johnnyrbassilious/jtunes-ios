import type {
  AccentThemeId,
  MediaFormatMode,
  ThemeMode,
  VideoQuality,
} from '../types/media';

const THEME_MODE_STORAGE_KEY = 'tubidy_theme_mode';
const ACCENT_STORAGE_KEY = 'tubidy_accent_theme';
const PLAY_MODE_STORAGE_KEY = 'tubidy_default_play_mode';
const QUALITY_STORAGE_KEY = 'tubidy_default_quality';
const AUTOPLAY_RELATED_STORAGE_KEY = 'tubidy_autoplay_related';
const SWIPE_TABS_STORAGE_KEY = 'tubidy_swipe_tabs';

export function getSavedThemeMode(): ThemeMode {
  if (typeof window === 'undefined' || !window.localStorage) {
    return 'dark';
  }
  const val = window.localStorage.getItem(THEME_MODE_STORAGE_KEY);
  if (val === 'light' || val === 'dark' || val === 'system') {
    return val;
  }
  return 'dark';
}

export function saveThemeMode(mode: ThemeMode): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(THEME_MODE_STORAGE_KEY, mode);
  }
}

export function getSavedAccentTheme(): AccentThemeId {
  if (typeof window === 'undefined' || !window.localStorage) {
    return 'crimson';
  }
  const val = window.localStorage.getItem(ACCENT_STORAGE_KEY);
  if (
    val === 'crimson' ||
    val === 'violet' ||
    val === 'emerald' ||
    val === 'ocean' ||
    val === 'amber' ||
    val === 'monochrome'
  ) {
    return val;
  }
  return 'crimson';
}

export function saveAccentTheme(id: AccentThemeId): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(ACCENT_STORAGE_KEY, id);
  }
}

export function getSavedDefaultPlayMode(): MediaFormatMode {
  if (typeof window === 'undefined' || !window.localStorage) {
    return 'video';
  }
  const val = window.localStorage.getItem(PLAY_MODE_STORAGE_KEY);
  return val === 'audio' ? 'audio' : 'video';
}

export function saveDefaultPlayMode(mode: MediaFormatMode): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(PLAY_MODE_STORAGE_KEY, mode);
  }
}

export function getSavedDefaultQuality(): VideoQuality {
  if (typeof window === 'undefined' || !window.localStorage) {
    return '720';
  }
  const val = window.localStorage.getItem(QUALITY_STORAGE_KEY);
  if (val === '1080' || val === '720' || val === '480' || val === '360') {
    return val;
  }
  return '720';
}

export function saveDefaultQuality(quality: VideoQuality): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(QUALITY_STORAGE_KEY, quality);
  }
}

export function getSavedAutoplayRelated(): boolean {
  if (typeof window === 'undefined' || !window.localStorage) {
    return true;
  }
  const val = window.localStorage.getItem(AUTOPLAY_RELATED_STORAGE_KEY);
  return val === null ? true : val === 'true';
}

export function saveAutoplayRelated(enabled: boolean): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(AUTOPLAY_RELATED_STORAGE_KEY, String(enabled));
  }
}

export function getSavedSwipeTabsEnabled(): boolean {
  if (typeof window === 'undefined' || !window.localStorage) {
    return true;
  }
  const val = window.localStorage.getItem(SWIPE_TABS_STORAGE_KEY);
  return val === null ? true : val === 'true';
}

export function saveSwipeTabsEnabled(enabled: boolean): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(SWIPE_TABS_STORAGE_KEY, String(enabled));
  }
}
