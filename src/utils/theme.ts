import type { AccentThemeId, ThemeMode } from '../types/media';

export interface AccentThemePreset {
  id: AccentThemeId;
  label: string;
  accent: string;
  hover: string;
  text: string;
  soft: string;
  border: string;
}

export const ACCENT_THEMES: readonly AccentThemePreset[] = [
  {
    id: 'crimson',
    label: 'Crimson Pink',
    accent: '#f43f5e',
    hover: '#fb7185',
    text: '#ffffff',
    soft: 'rgba(244, 63, 94, 0.16)',
    border: 'rgba(244, 63, 94, 0.45)',
  },
  {
    id: 'violet',
    label: 'Violet',
    accent: '#8b5cf6',
    hover: '#a78bfa',
    text: '#ffffff',
    soft: 'rgba(139, 92, 246, 0.16)',
    border: 'rgba(139, 92, 246, 0.45)',
  },
  {
    id: 'emerald',
    label: 'Emerald',
    accent: '#10b981',
    hover: '#34d399',
    text: '#052e16',
    soft: 'rgba(16, 185, 129, 0.16)',
    border: 'rgba(16, 185, 129, 0.45)',
  },
  {
    id: 'ocean',
    label: 'Ocean Blue',
    accent: '#3b82f6',
    hover: '#60a5fa',
    text: '#ffffff',
    soft: 'rgba(59, 130, 246, 0.16)',
    border: 'rgba(59, 130, 246, 0.45)',
  },
  {
    id: 'amber',
    label: 'Amber',
    accent: '#f59e0b',
    hover: '#fbbf24',
    text: '#1c1917',
    soft: 'rgba(245, 158, 11, 0.16)',
    border: 'rgba(245, 158, 11, 0.45)',
  },
  {
    id: 'monochrome',
    label: 'Monochrome',
    accent: '#e4e4e7',
    hover: '#ffffff',
    text: '#09090b',
    soft: 'rgba(161, 161, 170, 0.2)',
    border: 'rgba(161, 161, 170, 0.5)',
  },
] as const;

export function getAccentThemePreset(id: AccentThemeId): AccentThemePreset {
  return ACCENT_THEMES.find((t) => t.id === id) ?? ACCENT_THEMES[0];
}

export function resolveIsDarkTheme(mode: ThemeMode): boolean {
  if (mode === 'dark') {
    return true;
  }
  if (mode === 'light') {
    return false;
  }
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  return true;
}

export function applyThemeModeToDocument(mode: ThemeMode): boolean {
  const isDark = resolveIsDarkTheme(mode);
  if (typeof document === 'undefined') {
    return isDark;
  }
  const root = document.documentElement;
  if (isDark) {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
  root.style.colorScheme = isDark ? 'dark' : 'light';

  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) {
    metaTheme.setAttribute('content', isDark ? '#09090b' : '#f4f4f6');
  }
  return isDark;
}

export function subscribeToSystemThemeChange(
  onChange: (isDark: boolean) => void
): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const listener = (event: MediaQueryListEvent) => {
    onChange(event.matches);
  };
  if (typeof mediaQuery.addEventListener === 'function') {
    mediaQuery.addEventListener('change', listener);
    return () => mediaQuery.removeEventListener('change', listener);
  }
  mediaQuery.addListener(listener);
  return () => mediaQuery.removeListener(listener);
}

export function applyAccentThemeToDocument(
  id: AccentThemeId,
  isDark = true
): void {
  if (typeof document === 'undefined') {
    return;
  }
  const preset = getAccentThemePreset(id);
  const root = document.documentElement;
  // Ensure monochrome accent has readable contrast in light mode
  if (id === 'monochrome' && !isDark) {
    root.style.setProperty('--accent', '#18181b');
    root.style.setProperty('--accent-hover', '#27272a');
    root.style.setProperty('--accent-text', '#ffffff');
    root.style.setProperty('--accent-soft', 'rgba(24, 24, 27, 0.10)');
    root.style.setProperty('--accent-border', 'rgba(24, 24, 27, 0.35)');
    return;
  }
  root.style.setProperty('--accent', preset.accent);
  root.style.setProperty('--accent-hover', preset.hover);
  root.style.setProperty('--accent-text', preset.text);
  root.style.setProperty('--accent-soft', preset.soft);
  root.style.setProperty('--accent-border', preset.border);
}
