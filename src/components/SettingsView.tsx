import { useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Database,
  Film,
  Headphones,
  Loader2,
  Monitor,
  Moon,
  MoveHorizontal,
  Palette,
  RotateCcw,
  Server,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Trash2,
  XCircle,
} from 'lucide-react';
import { usePlayer } from '../context/PlayerContext';
import type {
  AccentThemeId,
  MediaFormatMode,
  SleepTimerOption,
  ThemeMode,
  UserProfile,
  VideoQuality,
} from '../types/media';
import { DEFAULT_BACKEND_URL, pingServer, type PingResult } from '../utils/api';
import { EQ_BANDS, EQ_PRESET_NAMES } from '../utils/equalizer';
import { formatMegabytes } from '../utils/formatters';
import { formatSleepCountdown } from '../utils/playerLogic';
import { ACCENT_THEMES } from '../utils/theme';

interface SettingsViewProps {
  backendUrl: string;
  onUpdateBackendUrl: (nextUrl: string) => void;
  themeMode: ThemeMode;
  onUpdateThemeMode: (mode: ThemeMode) => void;
  accentTheme: AccentThemeId;
  onUpdateAccentTheme: (theme: AccentThemeId) => void;
  swipeBetweenTabs: boolean;
  onUpdateSwipeBetweenTabs: (enabled: boolean) => void;
  defaultPlayMode: MediaFormatMode;
  onUpdateDefaultPlayMode: (mode: MediaFormatMode) => void;
  defaultQuality: VideoQuality;
  onUpdateDefaultQuality: (quality: VideoQuality) => void;
  autoplayRelated: boolean;
  onUpdateAutoplayRelated: (enabled: boolean) => void;
  userProfile?: UserProfile | null;
  onSaveUserProfile?: (profile: UserProfile) => void;
  onSignOutProfile?: () => void;
  listenHistoryCount?: number;
  onClearListenHistory?: () => void;
  offlineFileCount: number;
  offlineTotalBytes: number;
  playlistCount: number;
  onClearAllStorage: () => Promise<void>;
}

const THEME_MODES: Array<{ id: ThemeMode; label: string; icon: 'sun' | 'moon' | 'monitor' }> = [
  { id: 'light', label: 'Light', icon: 'sun' },
  { id: 'dark', label: 'Dark', icon: 'moon' },
  { id: 'system', label: 'System', icon: 'monitor' },
];

const QUALITY_OPTIONS: VideoQuality[] = ['1080', '720', '480', '360'];

const SLEEP_OPTIONS: Array<{ id: SleepTimerOption; label: string }> = [
  { id: 'off', label: 'Off' },
  { id: '5', label: '5m' },
  { id: '15', label: '15m' },
  { id: '30', label: '30m' },
  { id: '45', label: '45m' },
  { id: '60', label: '60m' },
  { id: 'end', label: 'End' },
];

export function SettingsView({
  backendUrl,
  onUpdateBackendUrl,
  themeMode,
  onUpdateThemeMode,
  accentTheme,
  onUpdateAccentTheme,
  swipeBetweenTabs,
  onUpdateSwipeBetweenTabs,
  defaultPlayMode,
  onUpdateDefaultPlayMode,
  defaultQuality,
  onUpdateDefaultQuality,
  autoplayRelated,
  onUpdateAutoplayRelated,
  offlineFileCount,
  offlineTotalBytes,
  playlistCount,
  onClearAllStorage,
}: SettingsViewProps) {
  const {
    sleepTimerOption,
    sleepTimerRemainingSec,
    setSleepTimer,
    eqGains,
    activeEqPreset,
    setEqBandGain,
    applyEqPreset,
    initEqualizer,
  } = usePlayer();

  const [isTesting, setIsTesting] = useState(false);
  const [pingResult, setPingResult] = useState<PingResult | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [isEqOpen, setIsEqOpen] = useState(false);

  const handleTestConnection = async () => {
    setIsTesting(true);
    const result = await pingServer(backendUrl);
    setPingResult(result);
    setIsTesting(false);
  };

  const handleResetDefaultUrl = () => {
    onUpdateBackendUrl(DEFAULT_BACKEND_URL);
    setPingResult(null);
  };

  const handleConfirmClearStorage = async () => {
    setIsClearing(true);
    try {
      await onClearAllStorage();
      setShowClearConfirm(false);
    } finally {
      setIsClearing(false);
    }
  };

  const handleToggleEq = () => {
    if (!isEqOpen) {
      initEqualizer();
    }
    setIsEqOpen((prev) => !prev);
  };

  const hasStoredItems = offlineFileCount > 0 || playlistCount > 0;

  return (
    <section aria-label="Settings" className="space-y-4">
      <h1 className="text-2xl font-bold tracking-tight text-[var(--text-primary)]">
        Settings
      </h1>

      {/* 1. Appearance & Theme */}
      <div className="rounded-3xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 space-y-4">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Palette size={17} className="text-accent" />
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">
              Appearance & Theme
            </h2>
          </div>

          {/* Compact Single-Row Light / Dark / System Segmented Pill */}
          <div
            role="radiogroup"
            aria-label="Theme Mode"
            className="grid grid-cols-3 gap-1 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-app)] p-1"
          >
            {THEME_MODES.map((opt) => {
              const isSelected = themeMode === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  onClick={() => onUpdateThemeMode(opt.id)}
                  className={`flex h-9 items-center justify-center gap-1.5 rounded-xl text-xs font-semibold transition-all duration-200 ${
                    isSelected
                      ? 'bg-[var(--bg-surface)] text-accent shadow-sm ring-1 ring-[var(--border-subtle)]'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  {opt.icon === 'sun' ? (
                    <Sun size={14} />
                  ) : opt.icon === 'moon' ? (
                    <Moon size={14} />
                  ) : (
                    <Monitor size={14} />
                  )}
                  <span>{opt.label}</span>
                </button>
              );
            })}
          </div>

          {/* All 6 Accent Swatches in a Single Even Horizontal Row */}
          <div
            aria-label="Accent Colors"
            className="grid grid-cols-6 place-items-center gap-2 pt-0.5"
          >
            {ACCENT_THEMES.map((preset) => {
              const isSelected = accentTheme === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  aria-pressed={isSelected}
                  aria-label={preset.label}
                  title={preset.label}
                  onClick={() => onUpdateAccentTheme(preset.id)}
                  className={`flex h-10 w-10 items-center justify-center rounded-full transition-transform duration-200 active:scale-95 ${
                    isSelected
                      ? 'ring-2 ring-[var(--text-primary)] ring-offset-2 ring-offset-[var(--bg-surface)] scale-105'
                      : 'opacity-85 hover:opacity-100'
                  }`}
                  style={{ backgroundColor: preset.accent }}
                >
                  {isSelected && (
                    <Check size={16} style={{ color: preset.text }} strokeWidth={3} />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-[var(--border-subtle)] pt-3.5">
          <div className="flex items-center gap-2">
            <MoveHorizontal size={16} className="text-accent" />
            <span className="text-sm font-semibold text-[var(--text-primary)]">
              Swipe Between Tabs
            </span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={swipeBetweenTabs}
            aria-label="Swipe Between Tabs"
            onClick={() => onUpdateSwipeBetweenTabs(!swipeBetweenTabs)}
            className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors ${
              swipeBetweenTabs ? 'bg-accent' : 'bg-zinc-400 dark:bg-zinc-700'
            }`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                swipeBetweenTabs ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
      </div>

      {/* 2. Playback & Audio */}
      <div className="rounded-3xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 space-y-4">
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">
            Default Media Mode
          </h2>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              aria-pressed={defaultPlayMode === 'video'}
              onClick={() => onUpdateDefaultPlayMode('video')}
              className={`flex min-h-[42px] items-center justify-center gap-2 rounded-2xl border px-3 text-xs font-semibold transition-colors ${
                defaultPlayMode === 'video'
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-[var(--border-subtle)] bg-[var(--bg-app)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              <Film size={15} />
              <span>Video + Audio</span>
            </button>

            <button
              type="button"
              aria-pressed={defaultPlayMode === 'audio'}
              onClick={() => onUpdateDefaultPlayMode('audio')}
              className={`flex min-h-[42px] items-center justify-center gap-2 rounded-2xl border px-3 text-xs font-semibold transition-colors ${
                defaultPlayMode === 'audio'
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-[var(--border-subtle)] bg-[var(--bg-app)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              <Headphones size={15} />
              <span>Audio Only</span>
            </button>
          </div>
        </div>

        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">
            Default Video Quality
          </h2>
          <div className="grid grid-cols-4 gap-2">
            {QUALITY_OPTIONS.map((q) => {
              const isSelected = defaultQuality === q;
              return (
                <button
                  key={q}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => onUpdateDefaultQuality(q)}
                  className={`min-h-[40px] rounded-xl border font-mono text-xs font-semibold transition-colors ${
                    isSelected
                      ? 'border-accent bg-accent-soft text-accent'
                      : 'border-[var(--border-subtle)] bg-[var(--bg-app)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  {q}p
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-[var(--border-subtle)] pt-3.5">
          <div className="flex items-center gap-2">
            <Sparkles size={16} className="text-accent" />
            <span className="text-sm font-semibold text-[var(--text-primary)]">
              Autoplay Related Media
            </span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={autoplayRelated}
            aria-label="Autoplay Related Media"
            onClick={() => onUpdateAutoplayRelated(!autoplayRelated)}
            className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors ${
              autoplayRelated ? 'bg-accent' : 'bg-zinc-400 dark:bg-zinc-700'
            }`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                autoplayRelated ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>

        {/* Sleep Timer */}
        <div className="space-y-2.5 border-t border-[var(--border-subtle)] pt-3.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Moon size={16} className="text-accent" />
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">Sleep Timer</h2>
            </div>
            {sleepTimerRemainingSec !== null ? (
              <span className="font-mono text-xs font-semibold text-accent tabular-nums">
                {formatSleepCountdown(sleepTimerRemainingSec)}
              </span>
            ) : sleepTimerOption === 'end' ? (
              <span className="text-xs font-semibold text-accent">End of Track</span>
            ) : null}
          </div>

          <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-7">
            {SLEEP_OPTIONS.map((opt) => {
              const isSelected = sleepTimerOption === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => setSleepTimer(opt.id)}
                  className={`min-h-[38px] rounded-xl border text-xs font-semibold transition-colors ${
                    isSelected
                      ? 'border-accent bg-accent-soft text-accent'
                      : 'border-[var(--border-subtle)] bg-[var(--bg-app)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Collapsible 5-Band Equalizer */}
        <div className="border-t border-[var(--border-subtle)] pt-3.5 space-y-3">
          <button
            type="button"
            onClick={handleToggleEq}
            aria-expanded={isEqOpen}
            className="flex min-h-[40px] w-full items-center justify-between rounded-2xl text-left"
          >
            <span className="flex items-center gap-2">
              <SlidersHorizontal size={16} className="text-accent" />
              <span className="text-sm font-semibold text-[var(--text-primary)]">
                Equalizer (5-Band EQ)
              </span>
            </span>
            <span className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
              <span className="font-medium text-accent">{activeEqPreset}</span>
              {isEqOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </span>
          </button>

          {isEqOpen && (
            <div aria-label="5-Band Equalizer" className="space-y-3.5 pt-1 animate-tubidy-fade">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {EQ_PRESET_NAMES.map((preset) => {
                  const isSelected = activeEqPreset === preset;
                  return (
                    <button
                      key={preset}
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => applyEqPreset(preset)}
                      className={`min-h-[38px] rounded-xl border px-2.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                        isSelected
                          ? 'border-accent bg-accent-soft text-accent'
                          : 'border-[var(--border-subtle)] bg-[var(--bg-app)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                      }`}
                    >
                      {preset}
                    </button>
                  );
                })}
              </div>

              <div className="space-y-2.5">
                {EQ_BANDS.map((band) => {
                  const gain = eqGains[band.index] ?? 0;
                  const formattedGain = `${gain > 0 ? '+' : ''}${gain.toFixed(1)} dB`;
                  return (
                    <div key={band.freq} className="flex items-center gap-3">
                      <label
                        htmlFor={`settings-eq-band-${band.freq}`}
                        className="w-14 shrink-0 font-mono text-xs font-medium text-[var(--text-secondary)] tabular-nums"
                      >
                        {band.label}
                      </label>
                      <input
                        id={`settings-eq-band-${band.freq}`}
                        type="range"
                        min={-12}
                        max={12}
                        step={0.5}
                        value={gain}
                        onChange={(e) => setEqBandGain(band.index, Number(e.target.value))}
                        aria-label={`Equalizer ${band.label} gain`}
                        style={{
                          background: `linear-gradient(to right, var(--accent) ${((gain + 12) / 24) * 100}%, var(--bg-elevated) ${((gain + 12) / 24) * 100}%)`,
                        }}
                        className="tubidy-scrubber h-2 flex-1 rounded-full"
                      />
                      <span className="w-16 shrink-0 text-right font-mono text-xs tabular-nums text-[var(--text-primary)]">
                        {formattedGain}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 3. Server URL */}
      <div className="rounded-3xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Server size={16} className="text-accent" />
            <label
              htmlFor="backend-url-input"
              className="text-sm font-semibold text-[var(--text-primary)]"
            >
              Server URL
            </label>
          </div>

          {pingResult && pingResult.online && (
            <div
              role="status"
              className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300"
            >
              <CheckCircle2 size={13} className="text-emerald-600 dark:text-emerald-400" />
              <span>Online · {pingResult.latencyMs}ms</span>
            </div>
          )}

          {pingResult && !pingResult.online && (
            <div
              role="alert"
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-[11px] font-medium text-red-700 dark:text-red-300"
            >
              <XCircle size={13} className="shrink-0 text-red-600 dark:text-red-400" />
              <span className="truncate max-w-[160px]">{pingResult.error || 'Offline'}</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <input
            id="backend-url-input"
            type="url"
            value={backendUrl}
            onChange={(e) => {
              onUpdateBackendUrl(e.target.value);
              if (pingResult) {
                setPingResult(null);
              }
            }}
            placeholder={DEFAULT_BACKEND_URL}
            spellCheck={false}
            className="h-11 min-w-0 flex-1 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-app)] px-3.5 font-mono text-xs text-[var(--text-primary)] placeholder:text-[var(--text-secondary)]/60 focus:border-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-soft)]"
          />
          <button
            type="button"
            disabled={isTesting}
            onClick={() => void handleTestConnection()}
            className="inline-flex h-11 items-center justify-center gap-1.5 rounded-2xl bg-accent px-3.5 text-xs font-semibold transition-colors active:scale-[0.98] disabled:opacity-60 whitespace-nowrap shrink-0"
          >
            {isTesting ? (
              <Loader2 size={15} className="animate-spin" />
            ) : (
              <Activity size={15} />
            )}
            <span>Test</span>
          </button>
          <button
            type="button"
            onClick={handleResetDefaultUrl}
            aria-label="Reset Server URL"
            title="Reset Server URL"
            className="flex h-11 w-11 items-center justify-center rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-app)] text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] shrink-0"
          >
            <RotateCcw size={15} />
          </button>
        </div>
      </div>

      {/* 4. Offline Storage */}
      <div className="rounded-3xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <Database size={16} className="text-accent shrink-0" />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                Offline Storage
              </h2>
              <p className="font-mono text-xs tabular-nums text-[var(--text-secondary)]">
                {offlineFileCount} {offlineFileCount === 1 ? 'File' : 'Files'} ·{' '}
                {formatMegabytes(offlineTotalBytes)}
              </p>
            </div>
          </div>

          <button
            type="button"
            disabled={!hasStoredItems}
            onClick={() => setShowClearConfirm(true)}
            className="inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-xl border border-red-300 bg-red-50 px-3.5 text-xs font-semibold text-red-700 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-45 dark:border-red-500/30 dark:bg-red-950/30 dark:text-red-200 dark:hover:bg-red-900/40 shrink-0"
          >
            <Trash2 size={14} />
            <span>Clear</span>
          </button>
        </div>

        {showClearConfirm && (
          <div
            role="alertdialog"
            aria-labelledby="clear-storage-heading"
            className="rounded-2xl border border-red-300 bg-red-50 p-3.5 space-y-3 dark:border-red-500/40 dark:bg-red-950/40"
          >
            <div className="flex items-center gap-2">
              <AlertTriangle size={16} className="shrink-0 text-red-600 dark:text-red-400" />
              <h3
                id="clear-storage-heading"
                className="text-xs font-semibold text-red-900 dark:text-red-100"
              >
                Delete all offline files and playlists?
              </h3>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={isClearing}
                onClick={() => void handleConfirmClearStorage()}
                className="inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-xl bg-red-600 px-3.5 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-60"
              >
                {isClearing && <Loader2 size={13} className="animate-spin" />}
                <span>Clear All</span>
              </button>
              <button
                type="button"
                disabled={isClearing}
                onClick={() => setShowClearConfirm(false)}
                className="inline-flex min-h-[40px] items-center justify-center rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3.5 text-xs font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
