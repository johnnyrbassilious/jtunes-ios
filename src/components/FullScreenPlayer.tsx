import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ChevronDown,
  Gauge,
  GripVertical,
  Headphones,
  ListMusic,
  MicVocal,
  MoreVertical,
  Pause,
  Play,
  Repeat,
  Repeat1,
  RotateCcw,
  RotateCw,
  SkipBack,
  SkipForward,
  Video,
  X,
} from 'lucide-react';
import { usePlayer } from '../context/PlayerContext';
import {
  getAllPlaylistsFromDB,
  saveMediaToDB,
  savePlaylistToDB,
} from '../services/db';
import type {
  MediaItem,
  OfflineMediaFile,
  PlayableTrack,
  PlaylistRecord,
  VideoQuality,
} from '../types/media';
import { getSavedBackendUrl } from '../utils/api';
import { downloadMediaInChunks } from '../utils/chunkDownloader';
import { formatDuration, sanitizeFilename } from '../utils/formatters';
import {
  fetchTrackLyrics,
  getActiveLyricIndex,
  type TrackLyricsResult,
} from '../utils/lyrics';
import { convertBlobToMp3 } from '../utils/mp3Encoder';
import { PLAYBACK_RATES } from '../utils/playerLogic';
import { MediaActionSheet, type ActionSheetTarget } from './MediaActionSheet';
import { ThumbnailArt } from './ThumbnailArt';

export function FullScreenPlayer() {
  const {
    queue,
    currentIndex,
    currentTrack,
    isPlaying,
    isBuffering,
    currentTime,
    duration,
    playbackRate,
    loopMode,
    audioOnlyMode,
    autoplayRelated,
    isExpanded,
    isQueueOpen,
    isLyricsViewOpen,
    playerError,
    pipMessage,
    sleepTimerOption,
    sleepTimerRemainingSec,
    isUsingYouTubeFallback,
    jumpToQueueIndex,
    playNextInQueue,
    addToQueue,
    reorderQueueItem,
    removeFromQueue,
    togglePlayPause,
    seekTo,
    skipBy,
    playNext,
    playPrevious,
    setPlaybackRate,
    cycleLoopMode,
    toggleAudioOnlyMode,
    toggleAutoplayRelated,
    setExpanded,
    setQueueOpen: setIsQueueOpen,
    setLyricsViewOpen,
    clearPlayerError,
    setSleepTimer,
  } = usePlayer();

  const [showSpeedBar, setShowSpeedBar] = useState(false);
  const [lyrics, setLyrics] = useState<TrackLyricsResult>({
    synced: [],
    plain: [],
    hasLyrics: false,
  });

  // Top-right "..." action sheet state for current track
  const [trackMenuTarget, setTrackMenuTarget] = useState<ActionSheetTarget | null>(null);
  const [playlists, setPlaylists] = useState<PlaylistRecord[]>([]);
  const [isSharingMp3, setIsSharingMp3] = useState(false);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  // Real-time vertical drag & smooth sheet mount states
  const [playerEntered, setPlayerEntered] = useState(false);
  const [dragOffsetY, setDragOffsetY] = useState(0);
  const [isDraggingPlayer, setIsDraggingPlayer] = useState(false);
  const [isDismissing, setIsDismissing] = useState(false);

  const [queueMounted, setQueueMounted] = useState(false);
  const [queueEntered, setQueueEntered] = useState(false);
  const [drawerDragY, setDrawerDragY] = useState(0);
  const [isDraggingDrawer, setIsDraggingDrawer] = useState(false);
  const [queueDrag, setQueueDrag] = useState<{
    pointerId: number;
    fromIndex: number;
    targetIndex: number;
    startY: number;
    deltaY: number;
    rowHeight: number;
    originCenterY: number;
  } | null>(null);

  const activeLyricRef = useRef<HTMLButtonElement | null>(null);
  const queueScrollContainerRef = useRef<HTMLDivElement | null>(null);
  const nowPlayingSectionRef = useRef<HTMLDivElement | null>(null);
  const nowPlayingRowElsRef = useRef>(new Map());
  const nowPlayingCentersRef = useRef<Array<{ idx: number; centerY: number; height: number }>>([]);
  const queueDragRef = useRef<{
    pointerId: number;
    fromIndex: number;
    targetIndex: number;
    startY: number;
    deltaY: number;
    rowHeight: number;
    originCenterY: number;
  } | null>(null);
  const topSwipeRef = useRef<{ x: number; y: number } | null>(null);
  const bottomSwipeRef = useRef<{ x: number; y: number } | null>(null);
  const drawerSwipeRef = useRef<{ x: number; y: number } | null>(null);
  const shareUrlRef = useRef<string | null>(null);
  const dismissTimerRef = useRef<number | null>(null);
  const playerEnterRafRef = useRef<number | null>(null);
  const queueTimerRef = useRef<number | null>(null);
  const queueRafRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (shareUrlRef.current) {
        URL.revokeObjectURL(shareUrlRef.current);
        shareUrlRef.current = null;
      }
      if (dismissTimerRef.current !== null) {
        window.clearTimeout(dismissTimerRef.current);
      }
      if (playerEnterRafRef.current !== null) {
        window.cancelAnimationFrame(playerEnterRafRef.current);
      }
      if (queueTimerRef.current !== null) {
        window.clearTimeout(queueTimerRef.current);
      }
      if (queueRafRef.current !== null) {
        window.cancelAnimationFrame(queueRafRef.current);
      }
    };
  }, []);

  // Reset drag & drawer states and trigger smooth entrance when player opens
  useEffect(() => {
    if (playerEnterRafRef.current !== null) {
      window.cancelAnimationFrame(playerEnterRafRef.current);
      playerEnterRafRef.current = null;
    }
    if (dismissTimerRef.current !== null) {
      window.clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }

    if (isExpanded) {
      setDragOffsetY(0);
      setIsDraggingPlayer(false);
      setIsDismissing(false);
      setDrawerDragY(0);
      setIsDraggingDrawer(false);
      setPlayerEntered(false);
      playerEnterRafRef.current = window.requestAnimationFrame(() => {
        playerEnterRafRef.current = window.requestAnimationFrame(() => {
          setPlayerEntered(true);
        });
      });
    } else {
      setPlayerEntered(false);
      setIsQueueOpen(false);
      setQueueMounted(false);
      setQueueEntered(false);
      setTrackMenuTarget(null);
    }
  }, [isExpanded, setIsQueueOpen]);

  // Smooth bottom-up slide animation for Up Next sheet
  useEffect(() => {
    if (queueTimerRef.current !== null) {
      window.clearTimeout(queueTimerRef.current);
      queueTimerRef.current = null;
    }
    if (queueRafRef.current !== null) {
      window.cancelAnimationFrame(queueRafRef.current);
      queueRafRef.current = null;
    }

    if (isQueueOpen) {
      setQueueMounted(true);
      setQueueEntered(false);
      setDrawerDragY(0);
      setIsDraggingDrawer(false);
      queueRafRef.current = window.requestAnimationFrame(() => {
        queueRafRef.current = window.requestAnimationFrame(() => {
          setQueueEntered(true);
        });
      });
    } else if (queueMounted) {
      queueDragRef.current = null;
      setQueueDrag(null);
      setQueueEntered(false);
      queueTimerRef.current = window.setTimeout(() => {
        setQueueMounted(false);
        setDrawerDragY(0);
      }, 300);
    }
  }, [isQueueOpen, queueMounted]);

  // Track active row drag on window so fast moves and iOS WKWebView touch drags never drop or read stale state
  useEffect(() => {
    const handleWindowPointerMove = (e: PointerEvent) => {
      const current = queueDragRef.current;
      if (!current || e.pointerId !== current.pointerId) {
        return;
      }
      e.preventDefault();

      const deltaY = e.clientY - current.startY;
      const draggedCenterY = current.originCenterY + deltaY;
      const centers = nowPlayingCentersRef.current;

      let nextTarget = current.fromIndex;
      if (deltaY > 0) {
        for (const slot of centers) {
          if (slot.idx > current.fromIndex && draggedCenterY > slot.centerY) {
            nextTarget = slot.idx;
          }
        }
      } else if (deltaY < 0) {
        for (let i = centers.length - 1; i >= 0; i -= 1) {
          const slot = centers[i];
          if (slot.idx < current.fromIndex && draggedCenterY < slot.centerY) {
            nextTarget = slot.idx;
          }
        }
      }

      const scrollContainer = queueScrollContainerRef.current;
      if (scrollContainer) {
        const containerRect = scrollContainer.getBoundingClientRect();
        if (e.clientY < containerRect.top + 48) {
          scrollContainer.scrollTop = Math.max(0, scrollContainer.scrollTop - 8);
        } else if (e.clientY > containerRect.bottom - 48) {
          scrollContainer.scrollTop += 8;
        }
      }

      const updated = { ...current, deltaY, targetIndex: nextTarget };
      queueDragRef.current = updated;
      setQueueDrag(updated);
    };

    const finishWindowDrag = (e: PointerEvent, commit: boolean) => {
      const current = queueDragRef.current;
      if (!current || e.pointerId !== current.pointerId) {
        return;
      }
      queueDragRef.current = null;
      nowPlayingCentersRef.current = [];
      setQueueDrag(null);

      if (commit && current.targetIndex !== current.fromIndex) {
        reorderQueueItem(current.fromIndex, current.targetIndex);
      }
    };

    const onPointerUp = (e: PointerEvent) => finishWindowDrag(e, true);
    const onPointerCancel = (e: PointerEvent) => finishWindowDrag(e, false);

    window.addEventListener('pointermove', handleWindowPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    return () => {
      window.removeEventListener('pointermove', handleWindowPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
    };
  }, [reorderQueueItem]);

  // Auto-scroll Up Next smoothly so NOW PLAYING sits near the top while previous tracks remain scrollable above
  useEffect(() => {
    if (!isQueueOpen || !queueEntered) {
      return;
    }
    const timer = window.setTimeout(() => {
      const container = queueScrollContainerRef.current;
      const nowPlayingEl = nowPlayingSectionRef.current;
      if (!container || !nowPlayingEl) {
        return;
      }
      const targetTop = Math.max(0, nowPlayingEl.offsetTop - 12);
      container.scrollTo({ top: targetTop, behavior: 'smooth' });
    }, 60);

    return () => window.clearTimeout(timer);
  }, [isQueueOpen, queueEntered, currentIndex]);

  // Fetch time-synced / plain lyrics automatically on track change
  useEffect(() => {
    setLyricsViewOpen(false);
    setLyrics({ synced: [], plain: [], hasLyrics: false });

    if (!currentTrack || currentTrack.isLiveRadio) {
      return;
    }

    const controller = new AbortController();
    void fetchTrackLyrics(
      currentTrack.title,
      currentTrack.uploader,
      fetch,
      controller.signal
    ).then((res) => {
      if (!controller.signal.aborted) {
        setLyrics(res);
      }
    });

    return () => controller.abort();
  }, [
    currentTrack?.id,
    currentTrack?.title,
    currentTrack?.uploader,
    currentTrack?.isLiveRadio,
    setLyricsViewOpen,
  ]);

  const activeLyricIndex = useMemo(
    () => getActiveLyricIndex(lyrics.synced, currentTime),
    [lyrics.synced, currentTime]
  );

  // Auto-scroll active synced lyric line into view
  useEffect(() => {
    if (!isLyricsViewOpen || activeLyricIndex < 0) {
      return;
    }
    activeLyricRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });
  }, [isLyricsViewOpen, activeLyricIndex]);

  // Auto-clear brief inline action notice
  useEffect(() => {
    if (!actionNotice) {
      return;
    }
    const timer = window.setTimeout(() => setActionNotice(null), 3200);
    return () => window.clearTimeout(timer);
  }, [actionNotice]);

  const triggerSmoothMinimize = useCallback(() => {
    if (isDismissing) {
      return;
    }
    setIsDraggingPlayer(false);
    setIsDismissing(true);
    if (dismissTimerRef.current !== null) {
      window.clearTimeout(dismissTimerRef.current);
    }
    dismissTimerRef.current = window.setTimeout(() => {
      setExpanded(false);
    }, 320);
  }, [isDismissing, setExpanded]);

  const openTrackMenu = useCallback(
    async (
      track: PlayableTrack,
      options?: { includeSleepTimer?: boolean; queueIndex?: number }
    ) => {
      try {
        const storedPlaylists = await getAllPlaylistsFromDB();
        setPlaylists(storedPlaylists);
      } catch {
        setPlaylists([]);
      }

      const url = track.sourceUrl || track.url || '';
      const offlineBlob = track.offlineBlob ?? track.blob;
      const offlineFile: OfflineMediaFile | undefined =
        track.isOffline && track.offlineFileId && offlineBlob
          ? {
              id: track.offlineFileId,
              title: track.title,
              uploader: track.uploader,
              duration: track.duration,
              thumbnail: track.thumbnail,
              mediaType: track.mode,
              formatLabel: track.mode === 'audio' ? 'Audio' : 'Video',
              sizeBytes: offlineBlob.size,
              createdAt: Date.now(),
              blob: offlineBlob,
              sourceUrl: url,
            }
          : undefined;

      const mediaItem: MediaItem | undefined =
        !track.isOffline && url
          ? {
              id: track.id,
              url,
              title: track.title,
              uploader: track.uploader,
              duration: track.duration,
              thumbnail: track.thumbnail,
              mediaType: track.mode,
              isLiveRadio: track.isLiveRadio,
              directStreamUrl: track.directStreamUrl,
            }
          : undefined;

      setTrackMenuTarget({
        id: track.id,
        title: track.title,
        uploader: track.uploader,
        duration: track.duration,
        thumbnail: track.thumbnail,
        url,
        mediaItem,
        offlineFile,
        includeSleepTimer: options?.includeSleepTimer,
        queueIndex: options?.queueIndex,
      });
    },
    []
  );

  const openCurrentTrackMenu = useCallback(async () => {
    if (!currentTrack) {
      return;
    }
    await openTrackMenu(currentTrack, { includeSleepTimer: true });
  }, [currentTrack, openTrackMenu]);

  const targetToPlayable = useCallback(
    (target: ActionSheetTarget): PlayableTrack | null => {
      if (
        typeof target.queueIndex === 'number' &&
        target.queueIndex >= 0 &&
        target.queueIndex < queue.length
      ) {
        const queued = queue[target.queueIndex];
        if (queued && queued.id === target.id) {
          return {
            ...queued,
            queueOrigin: 'manual',
          };
        }
      }
      if (target.offlineFile) {
        return {
          id: `offline-${target.offlineFile.id}`,
          title: target.offlineFile.title,
          uploader: target.offlineFile.uploader,
          duration: target.offlineFile.duration,
          thumbnail: target.offlineFile.thumbnail,
          sourceUrl: target.offlineFile.sourceUrl || '',
          streamUrl: '',
          mode: target.offlineFile.mediaType,
          isOffline: true,
          offlineFileId: target.offlineFile.id,
          offlineBlob: target.offlineFile.blob,
          queueOrigin: 'manual',
        };
      }
      if (!target.url) {
        return null;
      }
      return {
        id: target.id,
        title: target.title,
        uploader: target.uploader,
        duration: target.duration,
        thumbnail: target.thumbnail,
        url: target.url,
        sourceUrl: target.url,
        streamUrl: target.mediaItem?.directStreamUrl ?? '',
        directStreamUrl: target.mediaItem?.directStreamUrl,
        isLiveRadio: target.mediaItem?.isLiveRadio,
        mode: target.mediaItem?.mediaType ?? currentTrack?.mode ?? 'audio',
        isOffline: false,
        queueOrigin: 'manual',
      };
    },
    [currentTrack?.mode, queue]
  );

  const handleDownloadFromPlayer = useCallback(
    async (
      item: MediaItem,
      mode: 'audio' | 'video',
      quality: string,
      attachToPlaylistId?: string
    ) => {
      try {
        setActionNotice(
          mode === 'audio' ? 'Downloading MP3...' : `Downloading ${quality}p MP4...`
        );
        const downloaded = await downloadMediaInChunks({
          backendUrl: getSavedBackendUrl(),
          targetUrl: item.url,
          mode,
          quality,
          signal: new AbortController().signal,
          onProgress: () => {},
        });

        const finalBlob =
          mode === 'audio' ? await convertBlobToMp3(downloaded.blob) : downloaded.blob;

        const offlineId = `media-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const record: OfflineMediaFile = {
          id: offlineId,
          title: item.title,
          uploader: item.uploader,
          duration: item.duration,
          thumbnail: item.thumbnail,
          mediaType: mode,
          formatLabel: mode === 'audio' ? 'MP3 Audio' : `${quality}p MP4`,
          sizeBytes: finalBlob.size,
          createdAt: Date.now(),
          blob: finalBlob,
          sourceUrl: item.url,
        };

        await saveMediaToDB(record);

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

        setActionNotice(
          mode === 'audio' ? 'Saved MP3 to Library' : `Saved ${quality}p MP4 to Library`
        );
      } catch (err) {
        setActionNotice(err instanceof Error ? err.message : 'Download failed.');
      }
    },
    []
  );

  const handleShareMp3FromPlayer = useCallback(
    async (target: ActionSheetTarget) => {
      if (isSharingMp3) {
        return;
      }
      setIsSharingMp3(true);
      try {
        let sourceBlob: Blob | null = target.offlineFile?.blob ?? null;
        if (!sourceBlob && target.url) {
          const downloaded = await downloadMediaInChunks({
            backendUrl: getSavedBackendUrl(),
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
        const safeName = sanitizeFilename(target.title, 'mp3');
        const mp3File = new File([mp3Blob], safeName, { type: 'audio/mpeg' });

        if (
          typeof navigator !== 'undefined' &&
          typeof navigator.canShare === 'function' &&
          typeof navigator.share === 'function' &&
          navigator.canShare({ files: [mp3File] })
        ) {
          try {
            await navigator.share({ files: [mp3File], title: target.title });
            setTrackMenuTarget(null);
            return;
          } catch (err) {
            if (err instanceof Error && err.name === 'AbortError') {
              setTrackMenuTarget(null);
              return;
            }
          }
        }

        if (shareUrlRef.current) {
          URL.revokeObjectURL(shareUrlRef.current);
          shareUrlRef.current = null;
        }
        const objectUrl = URL.createObjectURL(mp3File);
        shareUrlRef.current = objectUrl;
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = safeName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTrackMenuTarget(null);
      } catch (err) {
        setActionNotice(err instanceof Error ? err.message : 'Unable to share MP3.');
      } finally {
        setIsSharingMp3(false);
      }
    },
    [isSharingMp3]
  );

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

  const handleCreatePlaylistWithFile = useCallback(
    (nameOrExisting: string, target: ActionSheetTarget) => {
      if (nameOrExisting.startsWith('__EXISTING__:')) {
        const playlistId = nameOrExisting.replace('__EXISTING__:', '');
        if (target.mediaItem) {
          void handleDownloadFromPlayer(target.mediaItem, 'audio', 'highest', playlistId);
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
        void handleDownloadFromPlayer(target.mediaItem, 'audio', 'highest', created.id);
      } else {
        setActionNotice(`Added to "${created.name}"`);
      }
    },
    [handleDownloadFromPlayer]
  );

  const queueSections = useMemo(() => {
    const nowPlaying: Array<{ track: PlayableTrack; queueIdx: number }> = [];
    const autoplay: Array<{ track: PlayableTrack; queueIdx: number }> = [];

    queue.forEach((track, idx) => {
      if (track.queueOrigin === 'auto') {
        autoplay.push({ track, queueIdx: idx });
      } else {
        nowPlaying.push({ track, queueIdx: idx });
      }
    });

    return { nowPlaying, autoplay };
  }, [queue]);

  if (!isExpanded || !currentTrack) {
    return null;
  }

  const effectiveDuration =
    duration > 0 ? duration : Math.max(currentTrack.duration, currentTime, 1);
  const progressPercent = Math.min(100, Math.max(0, (currentTime / effectiveDuration) * 100));
  const hasSleepTimerActive = sleepTimerOption !== 'off' || sleepTimerRemainingSec !== null;

  const loopAriaLabel =
    loopMode === 'off'
      ? 'Loop off'
      : loopMode === 'all'
        ? 'Loop queue'
        : 'Loop current track';

  const handlePlayerTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    if (t) {
      topSwipeRef.current = { x: t.clientX, y: t.clientY };
      setIsDraggingPlayer(true);
    }
  };

  const handlePlayerTouchMove = (e: React.TouchEvent) => {
    const start = topSwipeRef.current;
    const t = e.touches[0];
    if (!start || !t) {
      return;
    }
    const deltaY = t.clientY - start.y;
    const deltaX = t.clientX - start.x;
    if (deltaY > 0 && Math.abs(deltaY) >= Math.abs(deltaX)) {
      setDragOffsetY(deltaY);
    } else {
      setDragOffsetY(0);
    }
  };

  const handlePlayerTouchEnd = (e: React.TouchEvent) => {
    const start = topSwipeRef.current;
    topSwipeRef.current = null;
    setIsDraggingPlayer(false);
    const t = e.changedTouches[0];
    const deltaY = start && t ? t.clientY - start.y : dragOffsetY;
    const deltaX = start && t ? t.clientX - start.x : 0;

    if (dragOffsetY > 80 || (deltaY > 80 && Math.abs(deltaY) > Math.abs(deltaX))) {
      triggerSmoothMinimize();
    } else {
      setDragOffsetY(0);
    }
  };

  const handlePlayerTouchCancel = () => {
    topSwipeRef.current = null;
    setIsDraggingPlayer(false);
    setDragOffsetY(0);
  };

  const handleRowDragPointerDown = (e: React.PointerEvent<HTMLButtonElement>, idx: number) => {
    e.preventDefault();
    e.stopPropagation();

    const centers: Array<{ idx: number; centerY: number; height: number }> = [];
    queueSections.nowPlaying.forEach(({ queueIdx }) => {
      const el = nowPlayingRowElsRef.current.get(queueIdx);
      if (el) {
        const rect = el.getBoundingClientRect();
        centers.push({
          idx: queueIdx,
          centerY: rect.top + rect.height / 2,
          height: rect.height,
        });
      }
    });
    centers.sort((a, b) => a.idx - b.idx);
    nowPlayingCentersRef.current = centers;

    const currentMetric = centers.find((c) => c.idx === idx);
    const rowHeight = currentMetric?.height ?? 64;
    const originCenterY = currentMetric?.centerY ?? e.clientY;

    const initialDrag = {
      pointerId: e.pointerId,
      fromIndex: idx,
      targetIndex: idx,
      startY: e.clientY,
      deltaY: 0,
      rowHeight,
      originCenterY,
    };
    queueDragRef.current = initialDrag;
    setQueueDrag(initialDrag);
  };

  const getNowPlayingDragStyle = (idx: number): React.CSSProperties | undefined => {
    if (!queueDrag) {
      return undefined;
    }
    if (idx === queueDrag.fromIndex) {
      return {
        transform: `translate3d(0, ${queueDrag.deltaY}px, 0) scale(1.015)`,
      };
    }
    if (
      queueDrag.fromIndex < queueDrag.targetIndex &&
      idx > queueDrag.fromIndex &&
      idx <= queueDrag.targetIndex
    ) {
      return {
        transform: `translate3d(0, ${-queueDrag.rowHeight}px, 0)`,
      };
    }
    if (
      queueDrag.fromIndex > queueDrag.targetIndex &&
      idx >= queueDrag.targetIndex &&
      idx < queueDrag.fromIndex
    ) {
      return {
        transform: `translate3d(0, ${queueDrag.rowHeight}px, 0)`,
      };
    }
    return {
      transform: 'translate3d(0, 0, 0)',
    };
  };

  const renderQueueRow = (
    track: PlayableTrack,
    idx: number,
    isNowPlayingSection: boolean
  ) => {
    const isCurrent = idx === currentIndex;
    const isDraggedRow = isNowPlayingSection && queueDrag?.fromIndex === idx;
    const dragStyle = isNowPlayingSection ? getNowPlayingDragStyle(idx) : undefined;
    const canDrag = isNowPlayingSection && queueSections.nowPlaying.length > 1;

    const dragHandle = isNowPlayingSection ? (
      <button
        type="button"
        disabled={!canDrag}
        onPointerDown={(e) => {
          if (canDrag) {
            handleRowDragPointerDown(e, idx);
          }
        }}
        aria-label={`Drag to reorder ${track.title}`}
        style={{ touchAction: 'none' }}
        className={`flex min-h-[38px] min-w-[30px] shrink-0 touch-none select-none items-center justify-center rounded-lg text-[var(--text-secondary)] transition-colors ${
          canDrag
            ? 'cursor-grab hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] active:cursor-grabbing'
            : 'cursor-default opacity-35'
        }`}
      >
        <GripVertical size={16} />
      </button>
    ) : null;

    if (isCurrent) {
      return (
        <li
          key={`${track.id}-${idx}`}
          ref={(el) => {
            if (!isNowPlayingSection) {
              return;
            }
            if (el) {
              nowPlayingRowElsRef.current.set(idx, el);
            } else {
              nowPlayingRowElsRef.current.delete(idx);
            }
          }}
          style={dragStyle}
          className={`py-1.5 ${
            isDraggedRow
              ? 'relative z-20 transition-none'
              : queueDrag && isNowPlayingSection
                ? 'transition-transform duration-150 ease-out'
                : ''
          }`}
        >
          <div
            ref={nowPlayingSectionRef}
            className={`flex items-center gap-2 rounded-2xl border p-2 ${
              isDraggedRow
                ? 'border-[var(--accent)]/60 bg-[var(--bg-elevated)] shadow-xl'
                : 'border-accent-soft bg-accent-soft/60'
            }`}
          >
            {dragHandle}

            <div className="relative shrink-0">
              <ThumbnailArt
                src={track.thumbnail}
                alt={track.title}
                mode={track.mode}
                className="h-11 w-14 rounded-xl"
                iconSize={15}
              />
              <div
                aria-hidden="true"
                className="absolute inset-0 flex items-end justify-center gap-0.5 rounded-xl bg-black/45 pb-2"
              >
                <span
                  className={`h-3.5 w-1 rounded-full bg-[var(--accent)] ${
                    isPlaying ? 'tubidy-eq-bar-1' : 'scale-y-50'
                  }`}
                />
                <span
                  className={`h-3.5 w-1 rounded-full bg-[var(--accent)] ${
                    isPlaying ? 'tubidy-eq-bar-2' : 'scale-y-75'
                  }`}
                />
                <span
                  className={`h-3.5 w-1 rounded-full bg-[var(--accent)] ${
                    isPlaying ? 'tubidy-eq-bar-3' : 'scale-y-50'
                  }`}
                />
              </div>
            </div>

            <div className="min-w-0 flex-1 pl-0.5">
              <p className="truncate text-xs font-bold text-accent">
                {track.title}
              </p>
              <p className="truncate text-[11px] text-[var(--text-secondary)]">
                {track.uploader}
              </p>
            </div>

            <button
              type="button"
              onClick={() =>
                void openTrackMenu(track, {
                  includeSleepTimer: true,
                  queueIndex: idx,
                })
              }
              aria-label={`More options for ${track.title}`}
              className="flex min-h-[36px] min-w-[36px] shrink-0 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
            >
              <MoreVertical size={16} />
            </button>
          </div>
        </li>
      );
    }

    return (
      <li
        key={`${track.id}-${idx}`}
        ref={(el) => {
          if (!isNowPlayingSection) {
            return;
          }
          if (el) {
            nowPlayingRowElsRef.current.set(idx, el);
          } else {
            nowPlayingRowElsRef.current.delete(idx);
          }
        }}
        style={dragStyle}
        className={`flex items-center justify-between gap-1.5 py-2 ${
          isDraggedRow
            ? 'relative z-20 rounded-2xl bg-[var(--bg-elevated)] px-1.5 shadow-xl ring-1 ring-[var(--accent)]/40 transition-none'
            : queueDrag && isNowPlayingSection
              ? 'transition-transform duration-150 ease-out'
              : ''
        }`}
      >
        {dragHandle}

        <button
          type="button"
          onClick={() => jumpToQueueIndex(idx)}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left rounded-xl p-1 hover:bg-[var(--bg-elevated)]"
        >
          <ThumbnailArt
            src={track.thumbnail}
            alt={track.title}
            mode={track.mode}
            className="h-10 w-12 shrink-0 rounded-lg"
            iconSize={14}
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-semibold text-[var(--text-primary)]">
              {track.title}
            </p>
            <p className="truncate text-[11px] text-[var(--text-secondary)]">
              {track.uploader}
            </p>
          </div>
        </button>

        <button
          type="button"
          onClick={() => void openTrackMenu(track, { queueIndex: idx })}
          aria-label={`More options for ${track.title}`}
          className="flex min-h-[36px] min-w-[36px] shrink-0 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
        >
          <MoreVertical size={16} />
        </button>
      </li>
    );
  };

  const playerTransform =
    !playerEntered || isDismissing
      ? 'translate3d(0, 100%, 0)'
      : `translate3d(0, ${dragOffsetY}px, 0)`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Full screen player: ${currentTrack.title}`}
      style={{
        transform: playerTransform,
      }}
      className={`fixed inset-0 z-50 flex flex-col bg-[var(--bg-app)]/98 text-[var(--text-primary)] backdrop-blur-2xl ${
        isDraggingPlayer
          ? 'transition-none'
          : 'transition-transform duration-[320ms] ease-[cubic-bezier(0.22,1,0.36,1)]'
      }`}
    >
      {/* Top Bar: Minimize + Status + "..." Action Menu (respects Dynamic Island / Notch) */}
      <header
        onTouchStart={handlePlayerTouchStart}
        onTouchMove={handlePlayerTouchMove}
        onTouchEnd={handlePlayerTouchEnd}
        onTouchCancel={handlePlayerTouchCancel}
        className="mx-auto flex w-full max-w-2xl shrink-0 items-center justify-between px-4 pt-safe-header pb-1"
      >
        <button
          type="button"
          onClick={triggerSmoothMinimize}
          aria-label="Minimize player"
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
        >
          <ChevronDown size={24} />
        </button>

        <div className="min-w-0 text-center">
          <p className="text-xs font-semibold text-[var(--text-primary)]">Now Playing</p>
          <p className="text-[11px] text-[var(--text-secondary)]">
            {currentTrack.isOffline
              ? 'Offline'
              : currentTrack.isLiveRadio
                ? 'Live Radio'
                : isUsingYouTubeFallback
                  ? 'Fallback Stream'
                  : 'Stream'}{' '}
            · {audioOnlyMode ? 'Audio' : 'Video'}
          </p>
        </div>

        <button
          type="button"
          onClick={() => void openCurrentTrackMenu()}
          aria-label="Track actions and sleep timer"
          className="relative flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
        >
          <MoreVertical size={20} />
          {hasSleepTimerActive && (
            <span
              aria-label="Sleep timer active"
              className="absolute right-2.5 top-2.5 h-2 w-2 rounded-full bg-[var(--accent)] ring-2 ring-[var(--bg-app)]"
            />
          )}
        </button>
      </header>

      {/* Main Stage */}
      <div className="mx-auto flex w-full max-w-2xl flex-1 min-h-0 flex-col justify-between overflow-y-auto px-5 pb-safe-controls">
        {/* Media / Artwork / Time-Synced Lyrics Stage (Swipe down to minimize) */}
        <div
          onTouchStart={handlePlayerTouchStart}
          onTouchMove={handlePlayerTouchMove}
          onTouchEnd={handlePlayerTouchEnd}
          onTouchCancel={handlePlayerTouchCancel}
          className="relative mt-1 flex h-[min(74vw,34dvh,290px)] w-full shrink-0 items-center justify-center"
        >
          {isLyricsViewOpen && lyrics.hasLyrics ? (
            <div
              aria-label="Lyrics view"
              className="h-full w-full space-y-3 overflow-y-auto rounded-3xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]/85 px-5 py-6 text-center backdrop-blur-md animate-tubidy-fade"
            >
              {lyrics.synced.length > 0 ? (
                <div className="space-y-2.5 py-6">
                  {lyrics.synced.map((line, idx) => {
                    const isActive = idx === activeLyricIndex;
                    return (
                      <button
                        key={`${line.time}-${idx}`}
                        ref={isActive ? activeLyricRef : undefined}
                        type="button"
                        onClick={() => seekTo(line.time)}
                        className={`block w-full rounded-xl px-2 py-1 text-center transition-all duration-300 ${
                          isActive
                            ? 'scale-[1.02] text-base font-bold text-[var(--text-primary)]'
                            : 'text-sm font-medium text-[var(--text-secondary)] opacity-70 hover:opacity-100'
                        }`}
                      >
                        {line.text}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="space-y-2 py-2">
                  {lyrics.plain.map((line, idx) => (
                    <p
                      key={idx}
                      className="text-sm font-medium leading-relaxed text-[var(--text-primary)]"
                    >
                      {line}
                    </p>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <>
              {audioOnlyMode && (
                <ThumbnailArt
                  src={currentTrack.thumbnail}
                  alt={currentTrack.title}
                  mode="audio"
                  iconSize={48}
                  className="w-[min(74vw,290px)] max-h-[34dvh] aspect-square rounded-3xl shadow-2xl animate-tubidy-fade"
                />
              )}
            </>
          )}
        </div>

        {/* Inline Error, PiP Message, or Download/Share Notice */}
        {(playerError || pipMessage || actionNotice) && (
          <div
            role="alert"
            className="mt-3 flex items-center justify-between gap-2 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
          >
            <div className="flex items-center gap-2 min-w-0">
              <AlertCircle size={15} className="shrink-0 text-amber-500 dark:text-amber-400" />
              <span className="truncate">{playerError || pipMessage || actionNotice}</span>
            </div>
            {(playerError || actionNotice) && (
              <button
                type="button"
                onClick={() => {
                  clearPlayerError();
                  setActionNotice(null);
                }}
                aria-label="Dismiss playback notice"
                className="shrink-0 text-amber-600 hover:text-amber-900 dark:text-amber-300 dark:hover:text-white"
              >
                <X size={15} />
              </button>
            )}
          </div>
        )}

        {/* Primary Playback Controls (Swipe up from bottom opens Up Next) */}
        <div
          onTouchStart={(e) => {
            const target = e.target as HTMLElement | null;
            if (target?.closest('input[type="range"]')) {
              bottomSwipeRef.current = null;
              return;
            }
            const t = e.touches[0];
            if (t) {
              bottomSwipeRef.current = { x: t.clientX, y: t.clientY };
            }
          }}
          onTouchEnd={(e) => {
            const start = bottomSwipeRef.current;
            bottomSwipeRef.current = null;
            const t = e.changedTouches[0];
            if (!start || !t) {
              return;
            }
            const deltaY = t.clientY - start.y;
            const deltaX = t.clientX - start.x;
            if (deltaY < -55 && Math.abs(deltaY) > Math.abs(deltaX)) {
              setIsQueueOpen(true);
            }
          }}
          className="mt-3 space-y-4 sm:mt-4 sm:space-y-5"
        >
          <div className="space-y-1 text-center">
            <h2 className="line-clamp-2 text-lg font-bold tracking-tight text-[var(--text-primary)] text-balance">
              {currentTrack.title}
            </h2>
            <p className="truncate text-sm text-[var(--text-secondary)]">
              {currentTrack.uploader}
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="player-seek-slider" className="sr-only">
              Playback position
            </label>
            <div className="relative flex items-center">
              <input
                id="player-seek-slider"
                type="range"
                min={0}
                max={effectiveDuration}
                step={0.5}
                value={Math.min(currentTime, effectiveDuration)}
                onChange={(e) => seekTo(Number(e.target.value))}
                style={{
                  background: `linear-gradient(to right, var(--accent) ${progressPercent}%, var(--bg-elevated) ${progressPercent}%)`,
                }}
                className="tubidy-scrubber h-2 w-full rounded-full"
              />
              {isBuffering && (
                <div
                  aria-hidden="true"
                  className="tubidy-scrubber-shimmer top-1/2 h-[5px] -translate-y-1/2"
                />
              )}
            </div>
            <div className="flex items-center justify-between font-mono text-xs tabular-nums text-[var(--text-secondary)]">
              <span>{formatDuration(currentTime)}</span>
              <span>
                {currentTrack.isLiveRadio && duration === 0
                  ? 'LIVE'
                  : formatDuration(duration > 0 ? duration : currentTrack.duration)}
              </span>
            </div>
          </div>

          {/* Transport Row */}
          <div className="flex items-center justify-between gap-2 px-1">
            <button
              type="button"
              onClick={playPrevious}
              aria-label="Previous track"
              className="flex min-h-[48px] min-w-[48px] items-center justify-center rounded-full text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-elevated)]"
            >
              <SkipBack size={22} />
            </button>

            <button
              type="button"
              onClick={() => skipBy(-10)}
              aria-label="Skip back 10 seconds"
              className="flex min-h-[48px] min-w-[52px] flex-col items-center justify-center rounded-2xl text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-elevated)]"
            >
              <RotateCcw size={18} />
              <span className="font-mono text-[10px] font-semibold tabular-nums">-10s</span>
            </button>

            <div className="relative flex items-center justify-center">
              {isBuffering && (
                <span
                  aria-hidden="true"
                  className="tubidy-play-buffer-ring"
                />
              )}
              <button
                type="button"
                onClick={() => void togglePlayPause()}
                aria-label={isPlaying ? 'Pause' : 'Play'}
                aria-busy={isBuffering}
                className="relative z-10 flex h-16 w-16 items-center justify-center rounded-full bg-[var(--text-primary)] text-[var(--bg-app)] shadow-lg transition-transform active:scale-95"
              >
                {isPlaying ? (
                  <Pause size={26} fill="currentColor" />
                ) : (
                  <Play size={26} fill="currentColor" className="ml-0.5" />
                )}
              </button>
            </div>

            <button
              type="button"
              onClick={() => skipBy(10)}
              aria-label="Skip forward 10 seconds"
              className="flex min-h-[48px] min-w-[52px] flex-col items-center justify-center rounded-2xl text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-elevated)]"
            >
              <RotateCw size={18} />
              <span className="font-mono text-[10px] font-semibold tabular-nums">+10s</span>
            </button>

            <button
              type="button"
              onClick={playNext}
              aria-label="Next track"
              className="flex min-h-[48px] min-w-[48px] items-center justify-center rounded-full text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-elevated)]"
            >
              <SkipForward size={22} />
            </button>
          </div>

          {/* Expandable 5-Option Balanced Speed Selector Bar */}
          {showSpeedBar && (
            <div
              aria-label="Playback speed options"
              className="grid grid-cols-5 gap-1.5 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-1 animate-tubidy-fade"
            >
              {PLAYBACK_RATES.map((rate) => (
                <button
                  key={rate}
                  type="button"
                  onClick={() => {
                    setPlaybackRate(rate);
                    setShowSpeedBar(false);
                  }}
                  className={`min-h-[38px] rounded-xl font-mono text-xs font-semibold tabular-nums transition-colors ${
                    playbackRate === rate
                      ? 'bg-accent-soft text-accent shadow-sm'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  {rate}x
                </button>
              ))}
            </div>
          )}

          {/* Minimal Icon-Only Bottom Bar */}
          <div className="flex items-center justify-around pt-1">
            {/* 1. 3-State Loop Icon Button */}
            <button
              type="button"
              onClick={cycleLoopMode}
              aria-label={loopAriaLabel}
              aria-pressed={loopMode !== 'off'}
              title={loopAriaLabel}
              className={`flex h-10 w-10 items-center justify-center rounded-full border transition-all duration-200 ${
                loopMode === 'off'
                  ? 'border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  : 'border-accent-soft bg-accent-soft text-accent'
              }`}
            >
              {loopMode === 'one' ? <Repeat1 size={18} /> : <Repeat size={18} />}
            </button>

            {/* 2. Video / Audio Mode Toggle Icon Button */}
            <button
              type="button"
              onClick={toggleAudioOnlyMode}
              aria-label={audioOnlyMode ? 'Switch to video mode' : 'Switch to audio mode'}
              aria-pressed={audioOnlyMode}
              className={`flex h-10 w-10 items-center justify-center rounded-full border transition-all duration-200 ${
                audioOnlyMode
                  ? 'border-accent-soft bg-accent-soft text-accent'
                  : 'border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]'
              }`}
            >
              {audioOnlyMode ? <Headphones size={18} /> : <Video size={18} />}
            </button>

            {/* 3. Expandable Playback Speed Icon Button */}
            <button
              type="button"
              onClick={() => setShowSpeedBar((prev) => !prev)}
              aria-label={`Playback speed ${playbackRate}x`}
              aria-expanded={showSpeedBar}
              className={`flex h-10 w-10 items-center justify-center rounded-full border transition-all duration-200 ${
                showSpeedBar || playbackRate !== 1
                  ? 'border-accent-soft bg-accent-soft text-accent'
                  : 'border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              {playbackRate === 1 ? (
                <Gauge size={18} />
              ) : (
                <span className="font-mono text-[11px] font-bold tabular-nums">
                  {playbackRate}x
                </span>
              )}
            </button>

            {/* 4. Time-Synced Lyrics Toggle Icon Button */}
            <button
              type="button"
              disabled={!lyrics.hasLyrics}
              onClick={() => setLyricsViewOpen(!isLyricsViewOpen)}
              aria-label={lyrics.hasLyrics ? 'Toggle lyrics' : 'Lyrics unavailable'}
              aria-pressed={isLyricsViewOpen}
              className={`flex h-10 w-10 items-center justify-center rounded-full border transition-all duration-200 ${
                !lyrics.hasLyrics
                  ? 'cursor-not-allowed border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] opacity-35'
                  : isLyricsViewOpen
                    ? 'border-accent-soft bg-accent-soft text-accent'
                    : 'border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]'
              }`}
            >
              <MicVocal size={18} />
            </button>

            {/* 5. Up Next Queue Drawer Icon Button */}
            <button
              type="button"
              onClick={() => setIsQueueOpen(true)}
              aria-label="Up Next queue"
              aria-expanded={isQueueOpen}
              className={`flex h-10 w-10 items-center justify-center rounded-full border transition-all duration-200 ${
                isQueueOpen
                  ? 'border-accent-soft bg-accent-soft text-accent'
                  : 'border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]'
              }`}
            >
              <ListMusic size={18} />
            </button>
          </div>
        </div>
      </div>

      {/* YouTube Music-Style Expandable "Up Next" Overlay */}
      {queueMounted && (
        <div
          aria-label="Up Next Drawer"
          className={`fixed inset-0 z-[65] flex flex-col justify-between bg-[var(--bg-app)]/98 backdrop-blur-2xl pt-safe transition-opacity duration-200 ${
            queueEntered ? 'opacity-100' : 'opacity-0'
          }`}
        >
          {/* Compact Pinned Now Playing Bar (~18% top area) */}
          <div className="mx-auto flex w-full max-w-2xl shrink-0 items-center justify-between gap-2.5 px-4 py-3">
            <button
              type="button"
              onClick={() => setIsQueueOpen(false)}
              className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl p-1 text-left transition-colors hover:bg-[var(--bg-elevated)]"
            >
              <ThumbnailArt
                src={currentTrack.thumbnail}
                alt={currentTrack.title}
                mode={currentTrack.mode}
                className="h-11 w-11 shrink-0 rounded-xl"
                iconSize={16}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-[var(--text-primary)]">
                  {currentTrack.title}
                </p>
                <p className="truncate text-xs text-[var(--text-secondary)]">
                  {currentTrack.uploader}
                </p>
              </div>
            </button>

            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => void togglePlayPause()}
                aria-label={isPlaying ? 'Pause' : 'Play'}
                className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--bg-surface)] text-[var(--text-primary)] ring-1 ring-[var(--border-subtle)] hover:bg-[var(--bg-elevated)]"
              >
                {isPlaying ? (
                  <Pause size={18} fill="currentColor" />
                ) : (
                  <Play size={18} fill="currentColor" className="ml-0.5" />
                )}
              </button>
              <button
                type="button"
                onClick={() => void openCurrentTrackMenu()}
                aria-label="Track actions and sleep timer"
                className="relative flex h-11 w-11 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
              >
                <MoreVertical size={18} />
                {hasSleepTimerActive && (
                  <span className="absolute right-2.5 top-2.5 h-2 w-2 rounded-full bg-[var(--accent)]" />
                )}
              </button>
            </div>
          </div>

          {/* Up Next Sheet (~82% height, slides smoothly up from bottom) */}
          <div
            style={{
              transform: queueEntered
                ? `translate3d(0, ${drawerDragY}px, 0)`
                : 'translate3d(0, 100%, 0)',
            }}
            className={`mx-auto flex h-[82%] w-full max-w-2xl flex-col rounded-t-3xl border-t border-x border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-2xl ${
              isDraggingDrawer
                ? 'transition-none'
                : 'transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]'
            }`}
          >
            {/* Top Drag Handle + Header */}
            <div
              onTouchStart={(e) => {
                const t = e.touches[0];
                if (t) {
                  drawerSwipeRef.current = { x: t.clientX, y: t.clientY };
                  setIsDraggingDrawer(true);
                }
              }}
              onTouchMove={(e) => {
                const start = drawerSwipeRef.current;
                const t = e.touches[0];
                if (!start || !t) {
                  return;
                }
                const deltaY = t.clientY - start.y;
                if (deltaY > 0) {
                  setDrawerDragY(deltaY);
                } else {
                  setDrawerDragY(0);
                }
              }}
              onTouchEnd={(e) => {
                const start = drawerSwipeRef.current;
                drawerSwipeRef.current = null;
                setIsDraggingDrawer(false);
                const t = e.changedTouches[0];
                const deltaY = start && t ? t.clientY - start.y : drawerDragY;
                if (drawerDragY > 56 || deltaY > 56) {
                  setIsQueueOpen(false);
                } else {
                  setDrawerDragY(0);
                }
              }}
              onTouchCancel={() => {
                drawerSwipeRef.current = null;
                setIsDraggingDrawer(false);
                setDrawerDragY(0);
              }}
              className="shrink-0 cursor-grab touch-none border-b border-[var(--border-subtle)] px-5 pb-3 pt-2.5 active:cursor-grabbing"
            >
              <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-[var(--text-secondary)]/30" />

              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-bold tracking-tight text-[var(--text-primary)]">
                  Up Next
                </h2>

                <div className="flex items-center gap-2.5">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={autoplayRelated}
                    aria-label="Autoplay"
                    onClick={toggleAutoplayRelated}
                    className="inline-flex items-center gap-2 rounded-full py-1 pl-1 pr-0.5 text-xs font-semibold text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                  >
                    <span className="text-xs font-semibold text-[var(--text-secondary)]">
                      Autoplay
                    </span>
                    <span
                      aria-hidden="true"
                      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors duration-200 ease-out ${
                        autoplayRelated
                          ? 'bg-[var(--accent)]'
                          : 'bg-[var(--bg-elevated)] ring-1 ring-inset ring-[var(--border-subtle)]'
                      }`}
                    >
                      <span
                        className={`block h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                          autoplayRelated ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setIsQueueOpen(false)}
                    aria-label="Close Up Next"
                    className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
                  >
                    <ChevronDown size={18} />
                  </button>
                </div>
              </div>
            </div>

            {/* Scrollable Queue Body: 2 Clean Sections ONLY (Now Playing + Autoplay) */}
            <div
              ref={queueScrollContainerRef}
              className="relative flex-1 overflow-y-auto px-4 py-3 pb-safe-controls space-y-4"
            >
              {/* Section 1: Now Playing (all non-autoplay tracks with press-hold-and-drag GripVertical handles) */}
              {queueSections.nowPlaying.length > 0 && (
                <div>
                  <p className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-secondary)]">
                    Now Playing
                  </p>
                  <ul className="divide-y divide-[var(--border-subtle)]">
                    {queueSections.nowPlaying.map(({ track, queueIdx }) =>
                      renderQueueRow(track, queueIdx, true)
                    )}
                  </ul>
                </div>
              )}

              {/* Section 2: Autoplay (rendered ONLY when autoplayRelated is ON; clean rows with only "..." menu) */}
              {autoplayRelated && queueSections.autoplay.length > 0 && (
                <div>
                  <p className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-secondary)]">
                    Autoplay
                  </p>
                  <ul className="divide-y divide-[var(--border-subtle)]">
                    {queueSections.autoplay.map(({ track, queueIdx }) =>
                      renderQueueRow(track, queueIdx, false)
                    )}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Track Actions, Remove from Queue & Integrated Sleep Timer Sheet */}
      <MediaActionSheet
        target={trackMenuTarget}
        playlists={playlists}
        isSharingMp3={isSharingMp3}
        sleepTimerOption={sleepTimerOption}
        sleepTimerRemainingSec={sleepTimerRemainingSec}
        onSelectSleepTimer={setSleepTimer}
        onClose={() => setTrackMenuTarget(null)}
        onPlayNext={(target) => {
          const track = targetToPlayable(target);
          if (track) {
            playNextInQueue(track);
            setActionNotice('Added to Play Next');
          }
        }}
        onAddToQueue={(target) => {
          const track = targetToPlayable(target);
          if (track) {
            addToQueue(track);
            setActionNotice('Added to Queue');
          }
        }}
        onDownloadAudioMp3={(item) => {
          void handleDownloadFromPlayer(item, 'audio', 'highest');
        }}
        onDownloadVideo={(item, quality: VideoQuality) => {
          void handleDownloadFromPlayer(item, 'video', quality);
        }}
        onShareMp3={(target) => {
          void handleShareMp3FromPlayer(target);
        }}
        onToggleFileInPlaylist={handleToggleFileInPlaylist}
        onCreatePlaylistWithFile={handleCreatePlaylistWithFile}
        onRemoveFromQueue={(queueIdx) => {
          removeFromQueue(queueIdx);
          setActionNotice('Removed from queue');
        }}
      />
    </div>
  );
}
