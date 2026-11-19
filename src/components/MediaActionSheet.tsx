import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  Film,
  ListMusic,
  ListPlus,
  Loader2,
  Moon,
  Play,
  Plus,
  Share,
  Trash2,
  X,
} from 'lucide-react';
import type {
  MediaItem,
  OfflineMediaFile,
  PlaylistRecord,
  SleepTimerOption,
  VideoQuality,
} from '../types/media';
import { formatDuration } from '../utils/formatters';
import { formatSleepCountdown } from '../utils/playerLogic';
import { ThumbnailArt } from './ThumbnailArt';

export interface ActionSheetTarget {
  id: string;
  title: string;
  uploader: string;
  duration: number;
  thumbnail: string;
  url: string;
  mediaItem?: MediaItem;
  offlineFile?: OfflineMediaFile;
  downloadEntryId?: string;
  includeSleepTimer?: boolean;
  queueIndex?: number;
}

interface MediaActionSheetProps {
  target: ActionSheetTarget | null;
  playlists: PlaylistRecord[];
  isSharingMp3?: boolean;
  sleepTimerOption?: SleepTimerOption;
  sleepTimerRemainingSec?: number | null;
  onSelectSleepTimer?: (option: SleepTimerOption) => void;
  onClose: () => void;
  onPlayNext: (target: ActionSheetTarget) => void;
  onAddToQueue: (target: ActionSheetTarget) => void;
  onDownloadAudioMp3: (item: MediaItem) => void;
  onDownloadVideo: (item: MediaItem, quality: VideoQuality) => void;
  onShareMp3: (target: ActionSheetTarget) => void;
  onToggleFileInPlaylist?: (playlistId: string, fileId: string) => void;
  onCreatePlaylistWithFile?: (name: string, target: ActionSheetTarget) => void;
  onRemoveFromQueue?: (queueIndex: number, target: ActionSheetTarget) => void;
  onDelete?: (target: ActionSheetTarget) => void;
}

const VIDEO_QUALITIES: VideoQuality[] = ['1080', '720', '480', '360'];

const SLEEP_OPTIONS: Array<{ id: SleepTimerOption; label: string }> = [
  { id: 'off', label: 'Off' },
  { id: '5', label: '5m' },
  { id: '15', label: '15m' },
  { id: '30', label: '30m' },
  { id: '45', label: '45m' },
  { id: '60', label: '60m' },
  { id: 'end', label: 'End of Track' },
];

const SHEET_EXIT_MS = 300;

export function MediaActionSheet({
  target,
  playlists,
  isSharingMp3 = false,
  sleepTimerOption = 'off',
  sleepTimerRemainingSec = null,
  onSelectSleepTimer,
  onClose,
  onPlayNext,
  onAddToQueue,
  onDownloadAudioMp3,
  onDownloadVideo,
  onShareMp3,
  onToggleFileInPlaylist,
  onCreatePlaylistWithFile,
  onRemoveFromQueue,
  onDelete,
}: MediaActionSheetProps) {
  const [renderedTarget, setRenderedTarget] = useState<ActionSheetTarget | null>(target);
  const [isVisible, setIsVisible] = useState(false);

  const [showPlaylists, setShowPlaylists] = useState(false);
  const [showVideoQualities, setShowVideoQualities] = useState(false);
  const [showSleepTimer, setShowSleepTimer] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState('');

  const closeTimerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  useEffect(() => {
    clearTimers();
    if (target) {
      setRenderedTarget(target);
      setIsVisible(false);
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = window.requestAnimationFrame(() => {
          setIsVisible(true);
        });
      });
    } else if (renderedTarget) {
      setIsVisible(false);
      closeTimerRef.current = window.setTimeout(() => {
        setRenderedTarget(null);
      }, SHEET_EXIT_MS);
    }
    return clearTimers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  useEffect(() => {
    setShowPlaylists(false);
    setShowVideoQualities(false);
    setShowSleepTimer(false);
    setNewPlaylistName('');
  }, [target?.id]);

  const requestClose = useCallback(() => {
    clearTimers();
    setIsVisible(false);
    closeTimerRef.current = window.setTimeout(() => {
      setRenderedTarget(null);
      onClose();
    }, SHEET_EXIT_MS);
  }, [clearTimers, onClose]);

  useEffect(() => {
    if (!target) {
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        requestClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [target, requestClose]);

  if (!renderedTarget) {
    return null;
  }

  const downloadableItem: MediaItem | null =
    renderedTarget.mediaItem ??
    (renderedTarget.offlineFile?.sourceUrl
      ? {
          id: renderedTarget.offlineFile.id,
          url: renderedTarget.offlineFile.sourceUrl,
          title: renderedTarget.offlineFile.title,
          uploader: renderedTarget.offlineFile.uploader,
          duration: renderedTarget.offlineFile.duration,
          thumbnail: renderedTarget.offlineFile.thumbnail,
        }
      : null);

  const sleepBadgeText =
    sleepTimerRemainingSec !== null
      ? formatSleepCountdown(sleepTimerRemainingSec)
      : sleepTimerOption === 'end'
        ? 'End'
        : null;

  const handleCreatePlaylist = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newPlaylistName.trim();
    if (!trimmed || !onCreatePlaylistWithFile) {
      return;
    }
    onCreatePlaylistWithFile(trimmed, renderedTarget);
    setNewPlaylistName('');
  };

  return (
    <div
      className={`fixed inset-0 z-[90] flex items-end justify-center backdrop-blur-sm transition-opacity duration-200 sm:items-center sm:p-4 ${
        isVisible ? 'bg-black/55 opacity-100 dark:bg-black/70' : 'bg-black/0 opacity-0'
      }`}
      onClick={requestClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="action-sheet-title"
        onClick={(e) => e.stopPropagation()}
        className={`max-h-[88dvh] w-full max-w-md overflow-y-auto rounded-t-3xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5 pb-[max(1.25rem,env(safe-area-inset-bottom,0px))] shadow-2xl transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] sm:rounded-3xl ${
          isVisible
            ? 'translate-y-0 opacity-100 sm:scale-100'
            : 'translate-y-full opacity-0 sm:translate-y-6 sm:scale-95'
        }`}
      >
        <div className="mx-auto mb-4 h-1.5 w-10 rounded-full bg-[var(--text-secondary)]/30 sm:hidden" />

        {/* Item Header */}
        <div className="flex items-center justify-between gap-3 border-b border-[var(--border-subtle)] pb-4">
          <div className="flex min-w-0 items-center gap-3">
            <ThumbnailArt
              src={renderedTarget.thumbnail}
              alt={renderedTarget.title}
              mode={renderedTarget.offlineFile?.mediaType}
              className="h-12 w-16 rounded-xl"
              iconSize={18}
            />
            <div className="min-w-0">
              <h2
                id="action-sheet-title"
                className="line-clamp-1 text-sm font-semibold text-[var(--text-primary)]"
              >
                {renderedTarget.title}
              </h2>
              <p className="line-clamp-1 text-xs text-[var(--text-secondary)]">
                {renderedTarget.uploader}
                {renderedTarget.duration > 0 ? ` · ${formatDuration(renderedTarget.duration)}` : ''}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={requestClose}
            aria-label="Close menu"
            className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
          >
            <X size={20} />
          </button>
        </div>

        {/* Action Items */}
        <div className="mt-3 space-y-1.5">
          <button
            type="button"
            onClick={() => {
              onPlayNext(renderedTarget);
              requestClose();
            }}
            className="flex min-h-[46px] w-full items-center gap-3 rounded-2xl px-3.5 text-left text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-elevated)]"
          >
            <Play size={18} className="shrink-0 text-accent" />
            <span>Play Next</span>
          </button>

          <button
            type="button"
            onClick={() => {
              onAddToQueue(renderedTarget);
              requestClose();
            }}
            className="flex min-h-[46px] w-full items-center gap-3 rounded-2xl px-3.5 text-left text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-elevated)]"
          >
            <ListPlus size={18} className="shrink-0 text-accent" />
            <span>Add to Queue</span>
          </button>

          {downloadableItem && (
            <>
              <button
                type="button"
                onClick={() => {
                  onDownloadAudioMp3(downloadableItem);
                  requestClose();
                }}
                className="flex min-h-[46px] w-full items-center gap-3 rounded-2xl px-3.5 text-left text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-elevated)]"
              >
                <Download size={18} className="shrink-0 text-accent" />
                <span>Download Audio (MP3)</span>
              </button>

              <div>
                <button
                  type="button"
                  onClick={() => setShowVideoQualities((v) => !v)}
                  aria-expanded={showVideoQualities}
                  className="flex min-h-[46px] w-full items-center justify-between gap-3 rounded-2xl px-3.5 text-left text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-elevated)]"
                >
                  <span className="flex items-center gap-3">
                    <Film size={18} className="shrink-0 text-accent" />
                    <span>Download Video</span>
                  </span>
                  {showVideoQualities ? (
                    <ChevronDown size={17} className="text-[var(--text-secondary)]" />
                  ) : (
                    <ChevronRight size={17} className="text-[var(--text-secondary)]" />
                  )}
                </button>

                {showVideoQualities && (
                  <div className="grid grid-cols-4 gap-2 px-3.5 py-2 animate-tubidy-fade">
                    {VIDEO_QUALITIES.map((q) => (
                      <button
                        key={q}
                        type="button"
                        onClick={() => {
                          onDownloadVideo(downloadableItem, q);
                          requestClose();
                        }}
                        className="min-h-[42px] rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-app)] font-mono text-xs font-semibold text-[var(--text-primary)] transition-colors hover:border-[var(--accent-border)] hover:bg-[var(--bg-elevated)]"
                      >
                        {q}p
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          <button
            type="button"
            disabled={isSharingMp3}
            onClick={() => onShareMp3(renderedTarget)}
            className="flex min-h-[46px] w-full items-center gap-3 rounded-2xl px-3.5 text-left text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-elevated)] disabled:opacity-60"
          >
            {isSharingMp3 ? (
              <Loader2 size={18} className="shrink-0 animate-spin text-accent" />
            ) : (
              <Share size={18} className="shrink-0 text-accent" />
            )}
            <span>{isSharingMp3 ? 'Preparing MP3...' : 'Share MP3'}</span>
          </button>

          <div>
            <button
              type="button"
              onClick={() => setShowPlaylists((v) => !v)}
              aria-expanded={showPlaylists}
              className="flex min-h-[46px] w-full items-center justify-between gap-3 rounded-2xl px-3.5 text-left text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-elevated)]"
            >
              <span className="flex items-center gap-3">
                <ListMusic size={18} className="shrink-0 text-accent" />
                <span>Add to Playlist</span>
              </span>
              {showPlaylists ? (
                <ChevronDown size={17} className="text-[var(--text-secondary)]" />
              ) : (
                <ChevronRight size={17} className="text-[var(--text-secondary)]" />
              )}
            </button>

            {showPlaylists && (
              <div className="mt-1 space-y-2 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-app)] p-3 animate-tubidy-fade">
                {playlists.length > 0 && onToggleFileInPlaylist && (
                  <ul className="space-y-1">
                    {playlists.map((pl) => {
                      const inPlaylist = renderedTarget.offlineFile
                        ? pl.itemIds.includes(renderedTarget.offlineFile.id)
                        : false;
                      return (
                        <li key={pl.id}>
                          <button
                            type="button"
                            onClick={() => {
                              if (renderedTarget.offlineFile) {
                                onToggleFileInPlaylist(pl.id, renderedTarget.offlineFile.id);
                              } else if (onCreatePlaylistWithFile) {
                                onCreatePlaylistWithFile(`__EXISTING__:${pl.id}`, renderedTarget);
                                requestClose();
                              }
                            }}
                            className="flex min-h-[40px] w-full items-center justify-between rounded-xl px-2.5 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
                          >
                            <span className="truncate">{pl.name}</span>
                            {inPlaylist && <Check size={15} className="shrink-0 text-accent" />}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}

                {onCreatePlaylistWithFile && (
                  <form onSubmit={handleCreatePlaylist} className="flex items-center gap-2">
                    <input
                      type="text"
                      value={newPlaylistName}
                      onChange={(e) => setNewPlaylistName(e.target.value)}
                      placeholder="New playlist..."
                      className="h-10 min-w-0 flex-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-secondary)]/70 focus:border-[var(--accent)] focus:outline-none"
                    />
                    <button
                      type="submit"
                      disabled={!newPlaylistName.trim()}
                      aria-label="Create playlist"
                      className="inline-flex h-10 shrink-0 items-center gap-1 rounded-xl bg-accent px-3 text-xs font-semibold disabled:opacity-45"
                    >
                      <Plus size={14} />
                      <span>Add</span>
                    </button>
                  </form>
                )}
              </div>
            )}
          </div>

          {renderedTarget.includeSleepTimer && onSelectSleepTimer && (
            <div>
              <button
                type="button"
                onClick={() => setShowSleepTimer((v) => !v)}
                aria-expanded={showSleepTimer}
                className="flex min-h-[46px] w-full items-center justify-between gap-3 rounded-2xl px-3.5 text-left text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-elevated)]"
              >
                <span className="flex items-center gap-3">
                  <Moon size={18} className="shrink-0 text-accent" />
                  <span>Sleep Timer</span>
                  {sleepBadgeText && (
                    <span className="rounded-md bg-accent-soft px-2 py-0.5 font-mono text-[11px] font-semibold text-accent tabular-nums">
                      {sleepBadgeText}
                    </span>
                  )}
                </span>
                {showSleepTimer ? (
                  <ChevronDown size={17} className="text-[var(--text-secondary)]" />
                ) : (
                  <ChevronRight size={17} className="text-[var(--text-secondary)]" />
                )}
              </button>

              {showSleepTimer && (
                <div className="mt-1 grid grid-cols-4 gap-1.5 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-app)] p-3 animate-tubidy-fade">
                  {SLEEP_OPTIONS.map((opt) => {
                    const selected = sleepTimerOption === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => {
                          onSelectSleepTimer(opt.id);
                          requestClose();
                        }}
                        className={`min-h-[38px] rounded-xl border px-2 text-xs font-semibold transition-colors ${
                          opt.id === 'end' ? 'col-span-2' : ''
                        } ${
                          selected
                            ? 'border-accent bg-accent-soft text-accent'
                            : 'border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                        }`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {onRemoveFromQueue && typeof renderedTarget.queueIndex === 'number' && (
            <button
              type="button"
              onClick={() => {
                onRemoveFromQueue(renderedTarget.queueIndex!, renderedTarget);
                requestClose();
              }}
              className="flex min-h-[46px] w-full items-center gap-3 rounded-2xl px-3.5 text-left text-sm font-medium text-red-600 transition-colors hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
            >
              <Trash2 size={18} className="shrink-0" />
              <span>Remove from Queue</span>
            </button>
          )}

          {onDelete && (renderedTarget.offlineFile || renderedTarget.downloadEntryId) && (
            <button
              type="button"
              onClick={() => {
                onDelete(renderedTarget);
                requestClose();
              }}
              className="flex min-h-[46px] w-full items-center gap-3 rounded-2xl px-3.5 text-left text-sm font-medium text-red-600 transition-colors hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
            >
              <Trash2 size={18} className="shrink-0" />
              <span>Delete</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

