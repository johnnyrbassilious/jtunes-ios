import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BottomTabBar } from './components/BottomTabBar';
import { DownloadsView } from './components/DownloadsView';
import { FullScreenPlayer } from './components/FullScreenPlayer';
import { LibraryView } from './components/LibraryView';
import {
  MediaActionSheet,
  type ActionSheetTarget,
} from './components/MediaActionSheet';
import { MiniPlayer } from './components/MiniPlayer';
import { SearchView } from './components/SearchView';
import { SettingsView } from './components/SettingsView';
import { SplashScreen } from './components/SplashScreen';
import { PlayerProvider, usePlayer } from './context/PlayerContext';
import {
  calculateMediaStorageStats,
  clearAllMediaFromDB,
  deleteMediaFromDB,
  deletePlaylistFromDB,
  getAllMediaFromDB,
  getAllPlaylistsFromDB,
  saveMediaToDB,
  savePlaylistToDB,
} from './services/db';
import type {
  AccentThemeId,
  ActiveDownload,
  MediaFormatMode,
  MediaItem,
  OfflineMediaFile,
  PlayableTrack,
  PlaylistRecord,
  SearchFilterType,
  TabId,
  ThemeMode,
  UserProfile,
  VideoQuality,
} from './types/media';
import {
  DEFAULT_BACKEND_URL,
  getSavedBackendUrl,
  saveBackendUrl,
} from './utils/api';
import { downloadMediaInChunks } from './utils/chunkDownloader';
import { normalizeBackendUrl, sanitizeFilename } from './utils/formatters';
import { shuffleItems } from './utils/libraryFilters';
import { convertBlobToMp3 } from './utils/mp3Encoder';
import {
  clearListenHistory,
  clearUserProfile,
  getSavedListenHistory,
  getSavedUserProfile,
  saveUserProfile,
} from './utils/profileAndHistory';
import {
  getSavedAccentTheme,
  getSavedAutoplayRelated,
  getSavedDefaultPlayMode,
  getSavedDefaultQuality,
  getSavedSwipeTabsEnabled,
  getSavedThemeMode,
  saveAccentTheme,
  saveAutoplayRelated,
  saveDefaultPlayMode,
  saveDefaultQuality,
  saveSwipeTabsEnabled,
  saveThemeMode,
} from './utils/settings';
import {
  applyAccentThemeToDocument,
  applyThemeModeToDocument,
  subscribeToSystemThemeChange,
} from './utils/theme';

const TAB_ORDER: readonly TabId[] = ['search', 'downloads', 'library', 'settings'] as const;

interface TubidyAppShellProps {
  backendUrl: string;
  onUpdateBackendUrl: (url: string) => void;
  themeMode: ThemeMode;
  resolvedIsDark: boolean;
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
  userProfile: UserProfile | null;
  onSaveUserProfile: (profile: UserProfile) => void;
  onSignOutProfile: () => void;
  listenHistoryCount: number;
  onClearListenHistory: () => void;
}

function TubidyAppShell({
  backendUrl,
  onUpdateBackendUrl,
  themeMode,
  resolvedIsDark,
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
  userProfile,
  onSaveUserProfile,
  onSignOutProfile,
  listenHistoryCount,
  onClearListenHistory,
}: TubidyAppShellProps) {
  const {
    currentTrack,
    isExpanded,
    sleepTimerOption,
    sleepTimerRemainingSec,
    setSleepTimer,
    playTrack,
    playQueue,
    playNextInQueue,
    addToQueue,
  } = usePlayer();

  const [activeTab, setActiveTab] = useState<TabId>('search');
  const [tabDirection, setTabDirection] = useState<-1 | 0 | 1>(0);

  // Strict zero-mock-data rule: every state list initializes as empty []
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<SearchFilterType>('all');
  const [searchResults, setSearchResults] = useState<MediaItem[]>([]);
  const [activeDownloads, setActiveDownloads] = useState<ActiveDownload[]>([]);
  const [completedDownloads, setCompletedDownloads] = useState<ActiveDownload[]>([]);
  const [libraryFiles, setLibraryFiles] = useState<OfflineMediaFile[]>([]);
  const [playlists, setPlaylists] = useState<PlaylistRecord[]>([]);

  const [actionTarget, setActionTarget] = useState<ActionSheetTarget | null>(null);
  const [isSharingMp3, setIsSharingMp3] = useState(false);
  const [useRemoteLogo, setUseRemoteLogo] = useState(false);

  useEffect(() => {
    setUseRemoteLogo(false);
  }, [backendUrl]);

  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const exportObjectUrlRef = useRef<string | null>(null);
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);

  const selectTabWithDirection = useCallback(
    (nextTab: TabId) => {
      if (nextTab === activeTab) {
        return;
      }
      const prevIdx = TAB_ORDER.indexOf(activeTab);
      const nextIdx = TAB_ORDER.indexOf(nextTab);
      setTabDirection(nextIdx > prevIdx ? 1 : -1);
      setActiveTab(nextTab);
    },
    [activeTab]
  );

  // Hydrate offline mediaFiles & playlists from TubidyOfflineDB on launch
  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const [storedFiles, storedPlaylists] = await Promise.all([
          getAllMediaFromDB(),
          getAllPlaylistsFromDB(),
        ]);
        if (mounted) {
          setLibraryFiles(storedFiles);
          setPlaylists(storedPlaylists);
        }
      } catch {
        // IndexedDB unavailable; remain empty []
      }
    })();

    return () => {
      mounted = false;
      if (exportObjectUrlRef.current) {
        URL.revokeObjectURL(exportObjectUrlRef.current);
        exportObjectUrlRef.current = null;
      }
    };
  }, []);

  const offlineFileToPlayable = useCallback(
    (file: OfflineMediaFile): PlayableTrack => ({
      id: `offline-${file.id}`,
      title: file.title,
      uploader: file.uploader,
      duration: file.duration,
      thumbnail: file.thumbnail,
      sourceUrl: file.sourceUrl || '',
      streamUrl: '',
      mode: file.mediaType,
      isOffline: true,
      offlineFileId: file.id,
      offlineBlob: file.blob,
    }),
    []
  );

  const actionTargetToPlayable = useCallback(
    (target: ActionSheetTarget): PlayableTrack | null => {
      if (target.offlineFile) {
        return offlineFileToPlayable(target.offlineFile);
      }
      if (!target.url) {
        return null;
      }
      const mediaItem = target.mediaItem;
      return {
        id: target.id,
        title: target.title,
        uploader: target.uploader,
        duration: target.duration,
        thumbnail: target.thumbnail,
        url: target.url,
        sourceUrl: target.url,
        streamUrl: mediaItem?.directStreamUrl ?? '',
        directStreamUrl: mediaItem?.directStreamUrl,
        isLiveRadio: mediaItem?.isLiveRadio,
        mode: mediaItem?.mediaType ?? defaultPlayMode,
        isOffline: false,
      };
    },
    [defaultPlayMode, offlineFileToPlayable]
  );

  const handlePlayNextFromMenu = useCallback(
    (target: ActionSheetTarget) => {
      const track = actionTargetToPlayable(target);
      if (track) {
        playNextInQueue(track);
      }
    },
    [actionTargetToPlayable, playNextInQueue]
  );

  const handleAddToQueueFromMenu = useCallback(
    (target: ActionSheetTarget) => {
      const track = actionTargetToPlayable(target);
      if (track) {
        addToQueue(track);
      }
    },
    [actionTargetToPlayable, addToQueue]
  );

  const handlePlayOfflineFile = useCallback(
    (file: OfflineMediaFile) => {
      playTrack(offlineFileToPlayable(file));
    },
    [offlineFileToPlayable, playTrack]
  );

  const handlePlayOfflineFileById = useCallback(
    (offlineFileId: string) => {
      const target = libraryFiles.find((f) => f.id === offlineFileId);
      if (target) {
        handlePlayOfflineFile(target);
      }
    },
    [libraryFiles, handlePlayOfflineFile]
  );

  const handlePlayOfflineFilesList = useCallback(
    (files: OfflineMediaFile[], startIndex = 0) => {
      if (files.length === 0) {
        return;
      }
      playQueue(files.map(offlineFileToPlayable), startIndex);
    },
    [offlineFileToPlayable, playQueue]
  );

  const runDownloadAndSave = useCallback(
    async (downloadEntry: ActiveDownload, attachToPlaylistId?: string) => {
      const controller = new AbortController();
      abortControllersRef.current.set(downloadEntry.id, controller);

      const updateActive = (patch: Partial<ActiveDownload>) => {
        setActiveDownloads((prev) =>
          prev.map((d) => (d.id === downloadEntry.id ? { ...d, ...patch } : d))
        );
      };

      try {
        updateActive({ status: 'downloading', progress: 0, chunkIndex: 1 });

        const downloaded = await downloadMediaInChunks({
          backendUrl,
          targetUrl: downloadEntry.item.url,
          mode: downloadEntry.mode,
          quality: downloadEntry.quality,
          signal: controller.signal,
          onProgress: (p) => {
            updateActive({
              receivedBytes: p.receivedBytes,
              totalBytes: p.totalBytes,
              progress: p.progress,
              chunkIndex: p.chunkIndex,
            });
          },
        });

        if (controller.signal.aborted) {
          throw new DOMException('Download cancelled', 'AbortError');
        }

        let finalBlob = downloaded.blob;
        const finalMediaType: 'video' | 'audio' =
          downloadEntry.mode === 'audio' ? 'audio' : 'video';

        if (downloadEntry.mode === 'audio') {
          updateActive({ status: 'encoding', progress: 100 });
          finalBlob = await convertBlobToMp3(downloaded.blob);
        }

        if (controller.signal.aborted) {
          throw new DOMException('Download cancelled', 'AbortError');
        }

        updateActive({ status: 'saving', progress: 100 });

        const offlineId = `media-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const record: OfflineMediaFile = {
          id: offlineId,
          title: downloadEntry.item.title,
          uploader: downloadEntry.item.uploader,
          duration: downloadEntry.item.duration,
          thumbnail: downloadEntry.item.thumbnail,
          mediaType: finalMediaType,
          formatLabel: downloadEntry.formatLabel,
          sizeBytes: finalBlob.size,
          createdAt: Date.now(),
          blob: finalBlob,
          sourceUrl: downloadEntry.item.url,
        };

        await saveMediaToDB(record);
        setLibraryFiles((prev) => [record, ...prev]);

        if (attachToPlaylistId) {
          setPlaylists((prev) =>
            prev.map((pl) => {
              if (pl.id !== attachToPlaylistId || pl.itemIds.includes(offlineId)) {
                return pl;
              }
              const updated = { ...pl, itemIds: [...pl.itemIds, offlineId] };
              void savePlaylistToDB(updated);
              return updated;
            })
          );
        }

        const completedEntry: ActiveDownload = {
          ...downloadEntry,
          status: 'completed',
          progress: 100,
          receivedBytes: finalBlob.size,
          totalBytes: finalBlob.size,
          offlineFileId: offlineId,
        };

        setActiveDownloads((prev) => prev.filter((d) => d.id !== downloadEntry.id));
        setCompletedDownloads((prev) => [completedEntry, ...prev]);
      } catch (err) {
        if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
          updateActive({ status: 'cancelled' });
          return;
        }
        updateActive({
          status: 'error',
          error: err instanceof Error ? err.message : 'Unable to complete download.',
        });
      } finally {
        abortControllersRef.current.delete(downloadEntry.id);
      }
    },
    [backendUrl]
  );

  const handleDownloadAudioMp3 = useCallback(
    (item: MediaItem, attachToPlaylistId?: string) => {
      const downloadId = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const entry: ActiveDownload = {
        id: downloadId,
        item,
        mode: 'audio',
        quality: 'highest',
        formatLabel: 'MP3 Audio',
        status: 'resolving',
        progress: 0,
        receivedBytes: 0,
        totalBytes: null,
        chunkIndex: 1,
        createdAt: Date.now(),
      };
      setActiveDownloads((prev) => [entry, ...prev]);
      selectTabWithDirection('downloads');
      void runDownloadAndSave(entry, attachToPlaylistId);
    },
    [runDownloadAndSave, selectTabWithDirection]
  );

  const handleDownloadVideo = useCallback(
    (item: MediaItem, quality: VideoQuality) => {
      const downloadId = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const entry: ActiveDownload = {
        id: downloadId,
        item,
        mode: 'video',
        quality,
        formatLabel: `${quality}p MP4`,
        status: 'resolving',
        progress: 0,
        receivedBytes: 0,
        totalBytes: null,
        chunkIndex: 1,
        createdAt: Date.now(),
      };
      setActiveDownloads((prev) => [entry, ...prev]);
      selectTabWithDirection('downloads');
      void runDownloadAndSave(entry);
    },
    [runDownloadAndSave, selectTabWithDirection]
  );

  // Convert/package audio as MP3 (audio/mpeg) and trigger native iOS Share Sheet or download fallback
  const handleShareMp3 = useCallback(
    async (target: ActionSheetTarget) => {
      if (isSharingMp3) {
        return;
      }
      setIsSharingMp3(true);
      try {
        let sourceBlob: Blob | null = target.offlineFile?.blob ?? null;
        if (!sourceBlob && target.url) {
          const downloaded = await downloadMediaInChunks({
            backendUrl,
            targetUrl: target.url,
            mode: 'audio',
            quality: 'highest',
            signal: new AbortController().signal,
            onProgress: () => {},
          });
          sourceBlob = downloaded.blob;
        }
        if (!sourceBlob) {
          return;
        }

        const mp3Blob = await convertBlobToMp3(sourceBlob);
        const safeFileName = sanitizeFilename(target.title, 'mp3');
        const mp3File = new File([mp3Blob], safeFileName, { type: 'audio/mpeg' });

        if (
          typeof navigator !== 'undefined' &&
          typeof navigator.canShare === 'function' &&
          typeof navigator.share === 'function' &&
          navigator.canShare({ files: [mp3File] })
        ) {
          try {
            await navigator.share({
              files: [mp3File],
              title: target.title,
            });
            setActionTarget(null);
            return;
          } catch (err) {
            if (err instanceof Error && err.name === 'AbortError') {
              setActionTarget(null);
              return;
            }
          }
        }

        if (exportObjectUrlRef.current) {
          URL.revokeObjectURL(exportObjectUrlRef.current);
          exportObjectUrlRef.current = null;
        }
        const objectUrl = URL.createObjectURL(mp3File);
        exportObjectUrlRef.current = objectUrl;

        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = safeFileName;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        setActionTarget(null);
      } finally {
        setIsSharingMp3(false);
      }
    },
    [backendUrl, isSharingMp3]
  );

  const handleCancelDownload = useCallback((id: string) => {
    const controller = abortControllersRef.current.get(id);
    if (controller) {
      controller.abort();
    }
    setActiveDownloads((prev) =>
      prev.map((d) => (d.id === id ? { ...d, status: 'cancelled' } : d))
    );
  }, []);

  const handleRetryDownload = useCallback(
    (download: ActiveDownload) => {
      const resetEntry: ActiveDownload = {
        ...download,
        status: 'resolving',
        progress: 0,
        receivedBytes: 0,
        totalBytes: null,
        chunkIndex: 1,
        error: undefined,
      };
      setActiveDownloads((prev) =>
        prev.map((d) => (d.id === download.id ? resetEntry : d))
      );
      void runDownloadAndSave(resetEntry);
    },
    [runDownloadAndSave]
  );

  const handleRemoveActiveDownload = useCallback((id: string) => {
    setActiveDownloads((prev) => prev.filter((d) => d.id !== id));
  }, []);

  const handleClearCompletedDownloads = useCallback(() => {
    setCompletedDownloads([]);
    setActiveDownloads((prev) =>
      prev.filter((d) => d.status !== 'error' && d.status !== 'cancelled')
    );
  }, []);

  const handleDeleteOfflineFile = useCallback(async (id: string) => {
    await deleteMediaFromDB(id);
    setLibraryFiles((prev) => prev.filter((f) => f.id !== id));
    setPlaylists((prev) =>
      prev.map((pl) => {
        if (!pl.itemIds.includes(id)) {
          return pl;
        }
        const updated = { ...pl, itemIds: pl.itemIds.filter((itemId) => itemId !== id) };
        void savePlaylistToDB(updated);
        return updated;
      })
    );
  }, []);

  const handleDeleteFromMenu = useCallback(
    (target: ActionSheetTarget) => {
      if (target.offlineFile) {
        void handleDeleteOfflineFile(target.offlineFile.id);
      }
      if (target.downloadEntryId) {
        setCompletedDownloads((prev) =>
          prev.filter((d) => d.id !== target.downloadEntryId)
        );
      }
    },
    [handleDeleteOfflineFile]
  );

  const handleCreatePlaylist = useCallback((name: string) => {
    const newPlaylist: PlaylistRecord = {
      id: `pl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name,
      createdAt: Date.now(),
      itemIds: [],
    };
    setPlaylists((prev) => [newPlaylist, ...prev]);
    void savePlaylistToDB(newPlaylist);
    return newPlaylist;
  }, []);

  const handleCreatePlaylistWithTarget = useCallback(
    (nameOrExisting: string, target: ActionSheetTarget) => {
      if (nameOrExisting.startsWith('__EXISTING__:')) {
        const playlistId = nameOrExisting.replace('__EXISTING__:', '');
        if (target.mediaItem) {
          handleDownloadAudioMp3(target.mediaItem, playlistId);
        }
        return;
      }

      const initialIds = target.offlineFile ? [target.offlineFile.id] : [];
      const created: PlaylistRecord = {
        id: `pl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: nameOrExisting,
        createdAt: Date.now(),
        itemIds: initialIds,
      };
      setPlaylists((prev) => [created, ...prev]);
      void savePlaylistToDB(created);

      if (!target.offlineFile && target.mediaItem) {
        handleDownloadAudioMp3(target.mediaItem, created.id);
        setActionTarget(null);
      }
    },
    [handleDownloadAudioMp3]
  );

  const handleDeletePlaylist = useCallback((id: string) => {
    setPlaylists((prev) => prev.filter((pl) => pl.id !== id));
    void deletePlaylistFromDB(id);
  }, []);

  const handleToggleFileInPlaylist = useCallback((playlistId: string, fileId: string) => {
    setPlaylists((prev) =>
      prev.map((pl) => {
        if (pl.id !== playlistId) {
          return pl;
        }
        const exists = pl.itemIds.includes(fileId);
        const nextIds = exists
          ? pl.itemIds.filter((id) => id !== fileId)
          : [...pl.itemIds, fileId];
        const updated = { ...pl, itemIds: nextIds };
        void savePlaylistToDB(updated);
        return updated;
      })
    );
  }, []);

  const resolvePlaylistFiles = useCallback(
    (playlist: PlaylistRecord): OfflineMediaFile[] => {
      const fileMap = new Map(libraryFiles.map((f) => [f.id, f]));
      return playlist.itemIds
        .map((id) => fileMap.get(id))
        .filter((f): f is OfflineMediaFile => Boolean(f));
    },
    [libraryFiles]
  );

  const handlePlayPlaylist = useCallback(
    (playlist: PlaylistRecord) => {
      const tracks = resolvePlaylistFiles(playlist);
      if (tracks.length > 0) {
        handlePlayOfflineFilesList(tracks, 0);
      }
    },
    [resolvePlaylistFiles, handlePlayOfflineFilesList]
  );

  const handleShufflePlaylist = useCallback(
    (playlist: PlaylistRecord) => {
      const tracks = resolvePlaylistFiles(playlist);
      if (tracks.length > 0) {
        handlePlayOfflineFilesList(shuffleItems(tracks), 0);
      }
    },
    [resolvePlaylistFiles, handlePlayOfflineFilesList]
  );

  const handleClearAllStorage = useCallback(async () => {
    await clearAllMediaFromDB();
    setLibraryFiles([]);
    setPlaylists([]);
  }, []);

  const activeDownloadCount = useMemo(
    () =>
      activeDownloads.filter(
        (d) =>
          d.status === 'resolving' ||
          d.status === 'downloading' ||
          d.status === 'encoding' ||
          d.status === 'saving'
      ).length,
    [activeDownloads]
  );

  const storageStats = useMemo(() => calculateMediaStorageStats(libraryFiles), [libraryFiles]);
  const libraryTitles = useMemo(() => libraryFiles.map((f) => f.title), [libraryFiles]);

  const tabAnimationClass =
    tabDirection > 0
      ? 'animate-tubidy-slide-left'
      : tabDirection < 0
        ? 'animate-tubidy-slide-right'
        : 'animate-tubidy-fade';

  return (
    <div className="h-dvh overflow-y-auto overflow-x-hidden bg-[var(--bg-app)] text-[var(--text-primary)] select-none transition-colors duration-200">
      <header className="sticky top-0 z-20 border-b border-[var(--border-subtle)] bg-[var(--bg-header)] backdrop-blur-xl pt-safe">
        <div className="mx-auto flex h-12 max-w-5xl items-center justify-between px-4">
          <img
            src={
              useRemoteLogo
                ? `${normalizeBackendUrl(backendUrl) || DEFAULT_BACKEND_URL}/${
                    resolvedIsDark ? 'logo-dark.png' : 'logo-light.png'
                  }`
                : resolvedIsDark
                  ? '/logo-dark.png'
                  : '/logo-light.png'
            }
            alt="Jtunes"
            onError={() => {
              if (!useRemoteLogo) {
                setUseRemoteLogo(true);
              }
            }}
            className="h-7 w-auto object-contain select-none shrink-0"
          />

          {libraryFiles.length > 0 && (
            <button
              type="button"
              onClick={() => selectTabWithDirection('library')}
              className="text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] font-mono tabular-nums whitespace-nowrap shrink-0"
            >
              {libraryFiles.length} Offline
            </button>
          )}
        </div>
      </header>

      <main
        onTouchStart={(e) => {
          if (!swipeBetweenTabs || isExpanded || actionTarget) {
            swipeStartRef.current = null;
            return;
          }
          const target = e.target as HTMLElement | null;
          if (
            target?.closest('input, textarea, [role="tablist"], .overflow-x-auto')
          ) {
            swipeStartRef.current = null;
            return;
          }
          const t = e.touches[0];
          if (t) {
            swipeStartRef.current = { x: t.clientX, y: t.clientY };
          }
        }}
        onTouchEnd={(e) => {
          const start = swipeStartRef.current;
          swipeStartRef.current = null;
          if (!start || !swipeBetweenTabs || isExpanded || actionTarget) {
            return;
          }
          const t = e.changedTouches[0];
          if (!t) {
            return;
          }
          const deltaX = t.clientX - start.x;
          const deltaY = t.clientY - start.y;
          if (Math.abs(deltaX) > 65 && Math.abs(deltaX) > Math.abs(deltaY) * 1.4) {
            const idx = TAB_ORDER.indexOf(activeTab);
            if (deltaX < 0 && idx < TAB_ORDER.length - 1) {
              selectTabWithDirection(TAB_ORDER[idx + 1]);
            } else if (deltaX > 0 && idx > 0) {
              selectTabWithDirection(TAB_ORDER[idx - 1]);
            }
          }
        }}
        className={`mx-auto w-full max-w-5xl px-4 pt-5 ${
          currentTrack ? 'pb-40' : 'pb-24'
        }`}
      >
        <div key={activeTab} className={tabAnimationClass}>
          {activeTab === 'search' && (
            <SearchView
              backendUrl={backendUrl}
              defaultPlayMode={defaultPlayMode}
              searchQuery={searchQuery}
              onSearchQueryChange={setSearchQuery}
              activeFilter={activeFilter}
              onActiveFilterChange={setActiveFilter}
              searchResults={searchResults}
              libraryTitles={libraryTitles}
              onSearchResultsChange={setSearchResults}
              onOpenActionMenu={setActionTarget}
            />
          )}

          {activeTab === 'downloads' && (
            <DownloadsView
              activeDownloads={activeDownloads}
              completedDownloads={completedDownloads}
              libraryFiles={libraryFiles}
              onCancelDownload={handleCancelDownload}
              onRetryDownload={handleRetryDownload}
              onRemoveActiveDownload={handleRemoveActiveDownload}
              onClearCompleted={handleClearCompletedDownloads}
              onPlayOfflineFile={handlePlayOfflineFileById}
              onOpenActionMenu={setActionTarget}
            />
          )}

          {activeTab === 'library' && (
            <LibraryView
              libraryFiles={libraryFiles}
              playlists={playlists}
              onPlayOfflineFile={handlePlayOfflineFile}
              onPlayOfflineFilesList={handlePlayOfflineFilesList}
              onOpenActionMenu={setActionTarget}
              onCreatePlaylist={handleCreatePlaylist}
              onDeletePlaylist={handleDeletePlaylist}
              onToggleFileInPlaylist={handleToggleFileInPlaylist}
              onPlayPlaylist={handlePlayPlaylist}
              onShufflePlaylist={handleShufflePlaylist}
            />
          )}

          {activeTab === 'settings' && (
            <SettingsView
              backendUrl={backendUrl}
              onUpdateBackendUrl={onUpdateBackendUrl}
              themeMode={themeMode}
              onUpdateThemeMode={onUpdateThemeMode}
              accentTheme={accentTheme}
              onUpdateAccentTheme={onUpdateAccentTheme}
              swipeBetweenTabs={swipeBetweenTabs}
              onUpdateSwipeBetweenTabs={onUpdateSwipeBetweenTabs}
              defaultPlayMode={defaultPlayMode}
              onUpdateDefaultPlayMode={onUpdateDefaultPlayMode}
              defaultQuality={defaultQuality}
              onUpdateDefaultQuality={onUpdateDefaultQuality}
              autoplayRelated={autoplayRelated}
              onUpdateAutoplayRelated={onUpdateAutoplayRelated}
              userProfile={userProfile}
              onSaveUserProfile={onSaveUserProfile}
              onSignOutProfile={onSignOutProfile}
              listenHistoryCount={listenHistoryCount}
              onClearListenHistory={onClearListenHistory}
              offlineFileCount={storageStats.count}
              offlineTotalBytes={storageStats.totalBytes}
              playlistCount={playlists.length}
              onClearAllStorage={handleClearAllStorage}
            />
          )}
        </div>
      </main>

      <MiniPlayer />
      <FullScreenPlayer />

      <MediaActionSheet
        target={actionTarget}
        playlists={playlists}
        isSharingMp3={isSharingMp3}
        sleepTimerOption={sleepTimerOption}
        sleepTimerRemainingSec={sleepTimerRemainingSec}
        onSelectSleepTimer={setSleepTimer}
        onClose={() => setActionTarget(null)}
        onPlayNext={handlePlayNextFromMenu}
        onAddToQueue={handleAddToQueueFromMenu}
        onDownloadAudioMp3={(item) => handleDownloadAudioMp3(item)}
        onDownloadVideo={handleDownloadVideo}
        onShareMp3={(t) => void handleShareMp3(t)}
        onToggleFileInPlaylist={handleToggleFileInPlaylist}
        onCreatePlaylistWithFile={handleCreatePlaylistWithTarget}
        onDelete={handleDeleteFromMenu}
      />

      <BottomTabBar
        activeTab={activeTab}
        onSelectTab={selectTabWithDirection}
        activeDownloadCount={activeDownloadCount}
      />
    </div>
  );
}

export default function App() {
  const [showSplash, setShowSplash] = useState<boolean>(true);
  const [backendUrl, setBackendUrl] = useState<string>(() => getSavedBackendUrl());
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => getSavedThemeMode());
  const [resolvedIsDark, setResolvedIsDark] = useState<boolean>(() =>
    applyThemeModeToDocument(getSavedThemeMode())
  );
  const [accentTheme, setAccentTheme] = useState<AccentThemeId>(() => getSavedAccentTheme());
  const [swipeBetweenTabs, setSwipeBetweenTabs] = useState<boolean>(() =>
    getSavedSwipeTabsEnabled()
  );
  const [defaultPlayMode, setDefaultPlayMode] = useState<MediaFormatMode>(() =>
    getSavedDefaultPlayMode()
  );
  const [defaultQuality, setDefaultQuality] = useState<VideoQuality>(() =>
    getSavedDefaultQuality()
  );
  const [autoplayRelated, setAutoplayRelated] = useState<boolean>(() =>
    getSavedAutoplayRelated()
  );
  const [userProfile, setUserProfile] = useState<UserProfile | null>(() =>
    getSavedUserProfile()
  );
  const [listenHistoryCount, setListenHistoryCount] = useState<number>(
    () => getSavedListenHistory().length
  );

  // Apply themeMode + accentTheme immediately and listen live to OS theme when set to 'system'
  useEffect(() => {
    const isDark = applyThemeModeToDocument(themeMode);
    setResolvedIsDark(isDark);
    applyAccentThemeToDocument(accentTheme, isDark);

    if (themeMode !== 'system') {
      return;
    }
    return subscribeToSystemThemeChange(() => {
      const nextIsDark = applyThemeModeToDocument('system');
      setResolvedIsDark(nextIsDark);
      applyAccentThemeToDocument(accentTheme, nextIsDark);
    });
  }, [themeMode, accentTheme]);

  const handleUpdateBackendUrl = useCallback((nextUrl: string) => {
    setBackendUrl(nextUrl);
    saveBackendUrl(nextUrl);
  }, []);

  const handleUpdateThemeMode = useCallback(
    (nextMode: ThemeMode) => {
      setThemeMode(nextMode);
      saveThemeMode(nextMode);
      const isDark = applyThemeModeToDocument(nextMode);
      setResolvedIsDark(isDark);
      applyAccentThemeToDocument(accentTheme, isDark);
    },
    [accentTheme]
  );

  const handleUpdateAccentTheme = useCallback(
    (next: AccentThemeId) => {
      setAccentTheme(next);
      saveAccentTheme(next);
      const isDark = applyThemeModeToDocument(themeMode);
      setResolvedIsDark(isDark);
      applyAccentThemeToDocument(next, isDark);
    },
    [themeMode]
  );

  const handleUpdateSwipeBetweenTabs = useCallback((enabled: boolean) => {
    setSwipeBetweenTabs(enabled);
    saveSwipeTabsEnabled(enabled);
  }, []);

  const handleUpdateDefaultPlayMode = useCallback((mode: MediaFormatMode) => {
    setDefaultPlayMode(mode);
    saveDefaultPlayMode(mode);
  }, []);

  const handleUpdateDefaultQuality = useCallback((quality: VideoQuality) => {
    setDefaultQuality(quality);
    saveDefaultQuality(quality);
  }, []);

  const handleUpdateAutoplayRelated = useCallback((enabled: boolean) => {
    setAutoplayRelated(enabled);
    saveAutoplayRelated(enabled);
  }, []);

  const handleSaveUserProfile = useCallback((profile: UserProfile) => {
    const saved = saveUserProfile(profile);
    setUserProfile(saved);
  }, []);

  const handleSignOutProfile = useCallback(() => {
    clearUserProfile();
    setUserProfile(null);
  }, []);

  const handleClearListenHistory = useCallback(() => {
    clearListenHistory();
    setListenHistoryCount(0);
  }, []);

  return (
    <>
      {showSplash && (
        <SplashScreen
          backendUrl={backendUrl}
          onComplete={() => setShowSplash(false)}
        />
      )}
      <PlayerProvider
        backendUrl={backendUrl}
        defaultPlayMode={defaultPlayMode}
        defaultQuality={defaultQuality}
        autoplayRelated={autoplayRelated}
        onToggleAutoplayRelated={() => handleUpdateAutoplayRelated(!autoplayRelated)}
        onListenHistoryUpdated={setListenHistoryCount}
      >
        <TubidyAppShell
          backendUrl={backendUrl}
          onUpdateBackendUrl={handleUpdateBackendUrl}
          themeMode={themeMode}
          resolvedIsDark={resolvedIsDark}
          onUpdateThemeMode={handleUpdateThemeMode}
          accentTheme={accentTheme}
          onUpdateAccentTheme={handleUpdateAccentTheme}
          swipeBetweenTabs={swipeBetweenTabs}
          onUpdateSwipeBetweenTabs={handleUpdateSwipeBetweenTabs}
          defaultPlayMode={defaultPlayMode}
          onUpdateDefaultPlayMode={handleUpdateDefaultPlayMode}
          defaultQuality={defaultQuality}
          onUpdateDefaultQuality={handleUpdateDefaultQuality}
          autoplayRelated={autoplayRelated}
          onUpdateAutoplayRelated={handleUpdateAutoplayRelated}
          userProfile={userProfile}
          onSaveUserProfile={handleSaveUserProfile}
          onSignOutProfile={handleSignOutProfile}
          listenHistoryCount={listenHistoryCount}
          onClearListenHistory={handleClearListenHistory}
        />
      </PlayerProvider>
    </>
  );
}
