import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Capacitor } from '@capacitor/core';
import { NativeAudio } from '@capgo/capacitor-native-audio';
import { Maximize2, Minimize2, PictureInPicture2 } from 'lucide-react';
import {
  YouTubePlayerBridge,
  type YouTubePlayerBridgeHandle,
} from '../components/YouTubePlayerBridge';
import type {
  LoopMode,
  MediaFormatMode,
  PlayableTrack,
  SleepTimerOption,
  VideoQuality,
} from '../types/media';
import {
  DEFAULT_BACKEND_URL,
  fetchRelatedMedia,
  normalizeSearchResults,
} from '../utils/api';
import { normalizeBackendUrl } from '../utils/formatters';
import {
  EQ_PRESETS,
  applyEqualizerGains,
  clampEqGain,
  detectActiveEqPreset,
  resumeEqualizerContext,
  type EqGains,
  type EqPresetName,
} from '../utils/equalizer';
import {
  buildMediaMetadataInit,
  clampSeekTime,
  getNextLoopMode,
  getNextTrackIndex,
  getPreviousTrackAction,
  insertPlayNextInQueue,
  type PlaybackRate,
} from '../utils/playerLogic';
import {
  filterDistinctRelatedItems,
  getSavedListenHistory,
  getTopListenedArtists,
  moveQueueItem,
  recordListenHistoryEntry,
} from '../utils/profileAndHistory';
import { extractYouTubeVideoId } from '../utils/youtube';

const NATIVE_AUDIO_ASSET_ID = 'jtunes-active-track';
const NATIVE_AUDIO_BUFFER_GRACE_MS = 2500;
const STALL_RECOVERY_DELAY_MS = 5000;
const ROLLING_AUTOPLAY_MIN_UPCOMING = 4;

function isAutoplayTrack(track: PlayableTrack): boolean {
  return track.queueOrigin === 'auto';
}

function enforceQueueOrderInvariant(
  items: readonly PlayableTrack[],
  activeIndex: number
): { queue: PlayableTrack[]; currentIndex: number } {
  const manual: Array<{ track: PlayableTrack; origIdx: number }> = [];
  const auto: Array<{ track: PlayableTrack; origIdx: number }> = [];

  items.forEach((track, idx) => {
    if (isAutoplayTrack(track)) {
      auto.push({ track, origIdx: idx });
    } else {
      manual.push({ track, origIdx: idx });
    }
  });

  const combined = [...manual, ...auto];
  const nextCurrentIndex =
    activeIndex >= 0 && activeIndex < items.length
      ? combined.findIndex((entry) => entry.origIdx === activeIndex)
      : activeIndex;

  return {
    queue: combined.map((entry) => entry.track),
    currentIndex: nextCurrentIndex,
  };
}

function promoteAutoplayTrackAtIndex(
  items: readonly PlayableTrack[],
  targetIndex: number
): { queue: PlayableTrack[]; newIndex: number; track: PlayableTrack | null } {
  if (targetIndex < 0 || targetIndex >= items.length) {
    return { queue: [...items], newIndex: targetIndex, track: null };
  }

  const target = items[targetIndex];
  if (!isAutoplayTrack(target)) {
    const normalized = enforceQueueOrderInvariant(items, targetIndex);
    return {
      queue: normalized.queue,
      newIndex: normalized.currentIndex,
      track: normalized.queue[normalized.currentIndex] ?? target,
    };
  }

  const promotedTrack: PlayableTrack = {
    ...target,
    queueOrigin: 'manual',
  };

  const manual: PlayableTrack[] = [];
  const auto: PlayableTrack[] = [];
  items.forEach((item, idx) => {
    if (idx === targetIndex) {
      return;
    }
    if (isAutoplayTrack(item)) {
      auto.push(item);
    } else {
      manual.push(item);
    }
  });

  const newIndex = manual.length;
  return {
    queue: [...manual, promotedTrack, ...auto],
    newIndex,
    track: promotedTrack,
  };
}

interface PlayerProviderProps {
  children: React.ReactNode;
  backendUrl: string;
  defaultPlayMode: MediaFormatMode;
  defaultQuality: VideoQuality;
  autoplayRelated: boolean;
  onToggleAutoplayRelated?: () => void;
  onListenHistoryUpdated?: (count: number) => void;
}

interface PlayerContextValue {
  queue: PlayableTrack[];
  currentIndex: number;
  currentTrack: PlayableTrack | null;
  isPlaying: boolean;
  isBuffering: boolean;
  currentTime: number;
  duration: number;
  playbackRate: PlaybackRate;
  loopMode: LoopMode;
  audioOnlyMode: boolean;
  autoplayRelated: boolean;
  isExpanded: boolean;
  isQueueOpen: boolean;
  isVideoFullscreen: boolean;
  isLyricsViewOpen: boolean;
  isPipActive: boolean;
  isPipSupported: boolean;
  playerError: string | null;
  pipMessage: string | null;
  eqGains: EqGains;
  activeEqPreset: EqPresetName | 'Custom';
  sleepTimerOption: SleepTimerOption;
  sleepTimerRemainingSec: number | null;
  isUsingYouTubeFallback: boolean;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  playTrack: (track: PlayableTrack) => void;
  playQueue: (tracks: PlayableTrack[], startIndex?: number) => void;
  jumpToQueueIndex: (index: number) => void;
  playNextInQueue: (track: PlayableTrack) => void;
  addToQueue: (track: PlayableTrack) => void;
  reorderQueueItem: (fromIndex: number, toIndex: number) => void;
  moveQueueTrack: (fromIndex: number, toIndex: number) => void;
  removeFromQueue: (index: number) => void;
  clearQueue: () => void;
  togglePlayPause: () => Promise<void>;
  seekTo: (seconds: number) => void;
  skipBy: (deltaSeconds: number) => void;
  playNext: () => void;
  playPrevious: () => void;
  setPlaybackRate: (rate: PlaybackRate) => void;
  cycleLoopMode: () => void;
  toggleAudioOnlyMode: () => void;
  toggleAutoplayRelated: () => void;
  togglePictureInPicture: () => Promise<void>;
  setExpanded: (expanded: boolean) => void;
  setQueueOpen: (open: boolean) => void;
  setVideoFullscreen: (fullscreen: boolean) => void;
  setLyricsViewOpen: (open: boolean) => void;
  stopAndClearCurrent: () => void;
  clearPlayerError: () => void;
  setEqBandGain: (bandIndex: number, gainDb: number) => void;
  applyEqPreset: (presetName: EqPresetName) => void;
  initEqualizer: () => void;
  setSleepTimer: (option: SleepTimerOption) => void;
}

const PlayerContext = createContext<PlayerContextValue | null>(null);

export function PlayerProvider({
  children,
  backendUrl,
  defaultPlayMode,
  autoplayRelated,
  onToggleAutoplayRelated,
  onListenHistoryUpdated,
}: PlayerProviderProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const youtubeBridgeRef = useRef<YouTubePlayerBridgeHandle | null>(null);
  const activeObjectUrlRef = useRef<string | null>(null);
  const playedTrackIdsRef = useRef(new Set() as any);
  const fetchingRelatedRef = useRef(false);
  const rollingAutoplayInFlightRef = useRef(false);
  const lastRollingSeedIdRef = useRef<string | null>(null);
  const rollingEpochRef = useRef(0);
  const lastRecordedTrackIdRef = useRef<string | null>(null);
  const loadNonceRef = useRef(0);
  const blockedYoutubeIdsRef = useRef(new Map() as any);
  const embedRecoveryInFlightRef = useRef(false);
  const stallRecoveryTimerRef = useRef<number | null>(null);
  const lastStallTimeRef = useRef(0);
  const isNativeAudioActiveRef = useRef(false);
  const nativeAudioStartedAtRef = useRef(0);
  const nativeAudioPollRef = useRef<number | null>(null);
  const handleEndedRef = useRef<() => Promise<void>>(async () => {});

  const [queue, setQueue] = useState<PlayableTrack[]>([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [playNonce, setPlayNonce] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRateState] = useState<PlaybackRate>(1);
  const [loopMode, setLoopMode] = useState<LoopMode>('off');
  const [audioOnlyMode, setAudioOnlyMode] = useState(() => defaultPlayMode === 'audio');
  const audioOnlyModeRef = useRef(audioOnlyMode);
  audioOnlyModeRef.current = audioOnlyMode;

  const [isExpanded, setExpanded] = useState(false);
  const [isQueueOpen, setQueueOpen] = useState(false);
  const [isVideoFullscreen, setVideoFullscreen] = useState(false);
  const [isLyricsViewOpen, setLyricsViewOpen] = useState(false);
  const [isPipActive, setIsPipActive] = useState(false);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [pipMessage, setPipMessage] = useState<string | null>(null);
  const [youtubeVideoId, setYoutubeVideoId] = useState<string | null>(null);
  const [eqEnabled, setEqEnabled] = useState(false);
  const [eqGains, setEqGains] = useState<EqGains>([...EQ_PRESETS.Flat]);

  const [sleepTimerOption, setSleepTimerOption] = useState<SleepTimerOption>('off');
  const [sleepTimerRemainingSec, setSleepTimerRemainingSec] = useState<number | null>(null);

  const currentTrack = useMemo(() => {
    if (currentIndex < 0 || currentIndex >= queue.length) {
      return null;
    }
    return queue[currentIndex];
  }, [queue, currentIndex]);

  const useAudioElementForTrack = useCallback((track: PlayableTrack | null): boolean => {
    if (!track) {
      return audioOnlyModeRef.current;
    }
    return audioOnlyModeRef.current || Boolean(track.isLiveRadio) || track.mode === 'audio';
  }, []);

  const getActiveMediaEl = useCallback(
    (trackOverride?: PlayableTrack | null): HTMLMediaElement | null => {
      const t = trackOverride !== undefined ? trackOverride : currentTrack;
      return useAudioElementForTrack(t) ? audioRef.current : videoRef.current;
    },
    [currentTrack, useAudioElementForTrack]
  );

  const stopInactiveMediaEl = useCallback((activeEl: HTMLMediaElement | null) => {
    const otherEl = activeEl === audioRef.current ? videoRef.current : audioRef.current;
    if (!otherEl) {
      return;
    }
    try {
      if (!otherEl.paused) {
        otherEl.pause();
      }
      if (otherEl.hasAttribute('src')) {
        otherEl.removeAttribute('src');
        otherEl.load();
      }
    } catch {
      // Ignore cleanup errors
    }
  }, []);

  const stopAllHtmlMediaEls = useCallback(() => {
    [audioRef.current, videoRef.current].forEach((el) => {
      if (!el) return;
      try {
        if (!el.paused) {
          el.pause();
        }
        if (el.hasAttribute('src')) {
          el.removeAttribute('src');
          el.load();
        }
      } catch {
        // Ignore cleanup errors
      }
    });
  }, []);

  const clearNativeAudioPoll = useCallback(() => {
    if (nativeAudioPollRef.current !== null) {
      window.clearInterval(nativeAudioPollRef.current);
      nativeAudioPollRef.current = null;
    }
  }, []);

  const stopNativeAudio = useCallback(async () => {
    clearNativeAudioPoll();
    // Clear synchronously so no other handler thinks NativeAudio is still active
    isNativeAudioActiveRef.current = false;
    if (!Capacitor.isNativePlatform()) {
      return;
    }
    try {
      await NativeAudio.stop({ assetId: NATIVE_AUDIO_ASSET_ID });
    } catch {
      // Ignore if already stopped
    }
    try {
      await NativeAudio.unload({ assetId: NATIVE_AUDIO_ASSET_ID });
    } catch {
      // Ignore if already unloaded
    }
  }, [clearNativeAudioPoll]);

  const startNativeAudioPoll = useCallback(() => {
    clearNativeAudioPoll();
    if (!Capacitor.isNativePlatform()) {
      return;
    }
    nativeAudioPollRef.current = window.setInterval(() => {
      if (!isNativeAudioActiveRef.current) {
        return;
      }
      void NativeAudio.getCurrentTime({ assetId: NATIVE_AUDIO_ASSET_ID })
        .then((res) => {
          if (isNativeAudioActiveRef.current && Number.isFinite(res.currentTime)) {
            setCurrentTime(res.currentTime);
          }
        })
        .catch(() => {});
      void NativeAudio.isPlaying({ assetId: NATIVE_AUDIO_ASSET_ID })
        .then((res) => {
          if (!isNativeAudioActiveRef.current || typeof res.isPlaying !== 'boolean') {
            return;
          }
          // Avoid flickering back to Pause during initial AVPlayer remote buffering
          if (
            !res.isPlaying &&
            Date.now() - nativeAudioStartedAtRef.current < NATIVE_AUDIO_BUFFER_GRACE_MS
          ) {
            return;
          }
          setIsPlaying(res.isPlaying);
          if (res.isPlaying) {
            setIsBuffering(false);
          }
        })
        .catch(() => {});
    }, 500);
  }, [clearNativeAudioPoll]);

  // Configure native iOS AVPlayer background audio & Lock Screen notification controls once on mount
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) {
      return;
    }
    void NativeAudio.configure({
      background: true,
      focus: true,
      ignoreSilent: true,
      showNotification: true,
    } as any).catch(() => {});

    let listenerHandle: { remove: () => Promise<void> } | null = null;
    void NativeAudio.addListener('complete', (event: { assetId?: string }) => {
      if (event?.assetId === NATIVE_AUDIO_ASSET_ID && isNativeAudioActiveRef.current) {
        void handleEndedRef.current();
      }
    })
      .then((handle) => {
        listenerHandle = handle;
      })
      .catch(() => {});

    return () => {
      clearNativeAudioPoll();
      if (listenerHandle) {
        void listenerHandle.remove().catch(() => {});
      }
      void stopNativeAudio();
    };
  }, [clearNativeAudioPoll, stopNativeAudio]);

  const activeEqPreset = useMemo(() => detectActiveEqPreset(eqGains), [eqGains]);

  const isPipSupported = useMemo(() => {
    if (typeof document === 'undefined') {
      return false;
    }
    return Boolean(document.pictureInPictureEnabled);
  }, []);

  const revokeActiveObjectUrl = useCallback(() => {
    if (activeObjectUrlRef.current) {
      URL.revokeObjectURL(activeObjectUrlRef.current);
      activeObjectUrlRef.current = null;
    }
  }, []);

  const clearStallRecoveryTimer = useCallback(() => {
    if (stallRecoveryTimerRef.current !== null) {
      window.clearTimeout(stallRecoveryTimerRef.current);
      stallRecoveryTimerRef.current = null;
    }
  }, []);

  const syncMediaSessionMetadataNow = useCallback(
    (
      track: PlayableTrack | null,
      playing: boolean,
      positionSec = 0,
      durationSec?: number,
      rate = 1
    ) => {
      if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) {
        return;
      }
      const mediaSession = navigator.mediaSession;
      if (!track) {
        mediaSession.metadata = null;
        mediaSession.playbackState = 'none';
        return;
      }
      try {
        const baseMeta = buildMediaMetadataInit(track);
        mediaSession.metadata = new MediaMetadata({
          ...baseMeta,
          title: track.title || 'Jtunes',
          album: 'Jtunes',
        });
      } catch {
        // Ignore environments where MediaMetadata constructor is restricted
      }
      mediaSession.playbackState = playing ? 'playing' : 'paused';
      const effectiveDur =
        typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec > 0
          ? durationSec
          : track.duration;
      if (
        typeof mediaSession.setPositionState === 'function' &&
        Number.isFinite(effectiveDur) &&
        effectiveDur > 0
      ) {
        try {
          mediaSession.setPositionState({
            duration: effectiveDur,
            playbackRate: rate,
            position: Math.min(effectiveDur, Math.max(0, positionSec)),
          });
        } catch {
          // Ignore transient invalid state
        }
      }
    },
    []
  );

  useEffect(() => {
    return () => {
      rollingEpochRef.current += 1;
      clearStallRecoveryTimer();
      revokeActiveObjectUrl();
    };
  }, [clearStallRecoveryTimer, revokeActiveObjectUrl]);

  useEffect(() => {
    if (!isExpanded || (!youtubeVideoId && audioOnlyMode) || !currentTrack) {
      setVideoFullscreen(false);
    }
    if (!isExpanded) {
      setQueueOpen(false);
    }
  }, [isExpanded, audioOnlyMode, currentTrack, youtubeVideoId]);

  useEffect(() => {
    if (!isVideoFullscreen) {
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setVideoFullscreen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isVideoFullscreen]);

  useEffect(() => {
    if (!currentTrack) {
      const nextAudio = defaultPlayMode === 'audio';
      setAudioOnlyMode(nextAudio);
      audioOnlyModeRef.current = nextAudio;
    }
  }, [defaultPlayMode, currentTrack]);

  const startHtmlMediaPlayback = useCallback(
    (mediaEl: HTMLMediaElement, src: string, rate: number) => {
      isNativeAudioActiveRef.current = false;
      void stopNativeAudio();
      stopInactiveMediaEl(mediaEl);
      if (mediaEl.src !== src) {
        mediaEl.src = src;
      }
      mediaEl.playbackRate = rate;
      mediaEl.loop = false;

      const playPromise = mediaEl.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch((err: unknown) => {
          if (err instanceof Error && err.name === 'AbortError') {
            return;
          }
          setIsBuffering(false);
        });
      }
    },
    [stopInactiveMediaEl, stopNativeAudio]
  );

  // Route direct remote audio streams (Live Radio, Audius, Podcasts, direct MP3/M4A URLs)
  // through native iOS AVPlayer for background & Lock Screen playback.
  const startDirectMediaPlayback = useCallback(
    (
      mediaEl: HTMLMediaElement,
      src: string,
      rate: number,
      track: PlayableTrack,
      activeToken: number
    ) => {
      const shouldUseNativeAvPlayer =
        Capacitor.isNativePlatform() &&
        useAudioElementForTrack(track) &&
        /^https?:\/\//i.test(src);

      if (!shouldUseNativeAvPlayer) {
        startHtmlMediaPlayback(mediaEl, src, rate);
        return;
      }

      stopAllHtmlMediaEls();
      setIsBuffering(true);

      void (async () => {
        try {
          await stopNativeAudio();
          if (loadNonceRef.current !== activeToken) {
            return;
          }

          await NativeAudio.preload({
            assetId: NATIVE_AUDIO_ASSET_ID,
            assetPath: src,
            isUrl: true,
            notificationMetadata: {
              title: track.title || 'Jtunes',
              artist: track.uploader || 'Jtunes',
              album: 'Jtunes',
              artworkUrl: track.thumbnail || undefined,
            },
          } as any);

          if (loadNonceRef.current !== activeToken) {
            await NativeAudio.unload({ assetId: NATIVE_AUDIO_ASSET_ID }).catch(() => {});
            return;
          }

          isNativeAudioActiveRef.current = true;
          nativeAudioStartedAtRef.current = Date.now();
          await NativeAudio.play({ assetId: NATIVE_AUDIO_ASSET_ID });
          setIsPlaying(true);
          setIsBuffering(false);
          setPlayerError(null);
          startNativeAudioPoll();

          void NativeAudio.getDuration({ assetId: NATIVE_AUDIO_ASSET_ID })
            .then((res) => {
              if (
                isNativeAudioActiveRef.current &&
                Number.isFinite(res.duration) &&
                res.duration > 0
              ) {
                setDuration(res.duration);
              }
            })
            .catch(() => {});
        } catch {
          if (loadNonceRef.current !== activeToken) {
            return;
          }
          isNativeAudioActiveRef.current = false;
          startHtmlMediaPlayback(mediaEl, src, rate);
        }
      })();
    },
    [
      startHtmlMediaPlayback,
      startNativeAudioPoll,
      stopAllHtmlMediaEls,
      stopNativeAudio,
      useAudioElementForTrack,
    ]
  );

  // Clean playback router:
  // 1. Offline local blobs -> HTML <audio>/<video>
  // 2. Live Radio & Direct open audio URLs -> Native iOS AVPlayer (background audio!)
  // 3. YouTube items -> Official visible YouTubePlayerBridge (instant load, zero 403 flicker)
  useEffect(() => {
    loadNonceRef.current += 1;
    const activeToken = loadNonceRef.current;

    if (!currentTrack) {
      isNativeAudioActiveRef.current = false;
      void stopNativeAudio();
      stopAllHtmlMediaEls();
      revokeActiveObjectUrl();
      setYoutubeVideoId(null);
      setIsPlaying(false);
      setIsBuffering(false);
      setCurrentTime(0);
      setDuration(0);
      return;
    }

    playedTrackIdsRef.current.add(currentTrack.id);

    if (lastRecordedTrackIdRef.current !== currentTrack.id) {
      lastRecordedTrackIdRef.current = currentTrack.id;
      const updatedHistory = recordListenHistoryEntry({
        id: currentTrack.id,
        title: currentTrack.title,
        uploader: currentTrack.uploader,
        mediaType: currentTrack.mode,
      });
      onListenHistoryUpdated?.(updatedHistory.length);
    }

    setPlayerError(null);
    setPipMessage(null);
    setCurrentTime(0);
    setDuration(currentTrack.duration > 0 ? currentTrack.duration : 0);
    setIsBuffering(true);

    const mediaEl = getActiveMediaEl(currentTrack);

    // 1. Offline Blob playback
    const offlineBlob = currentTrack.offlineBlob ?? currentTrack.blob;
    if ((currentTrack.isOffline || offlineBlob) && offlineBlob && mediaEl) {
      setYoutubeVideoId(null);
      revokeActiveObjectUrl();
      const freshUrl = URL.createObjectURL(offlineBlob);
      activeObjectUrlRef.current = freshUrl;
      startHtmlMediaPlayback(mediaEl, freshUrl, playbackRate);
      return;
    }

    if (!currentTrack.isOffline) {
      revokeActiveObjectUrl();
    }

    // 2. Live Radio or Direct open audio/video stream URL (non-YouTube)
    const targetUrl = currentTrack.sourceUrl || currentTrack.url || '';
    const ytId = extractYouTubeVideoId(targetUrl, currentTrack.id);

    if (
      (currentTrack.directStreamUrl || currentTrack.isLiveRadio || (!ytId && (currentTrack.streamUrl || targetUrl))) &&
      mediaEl
    ) {
      const directSrc =
        currentTrack.directStreamUrl || currentTrack.streamUrl || targetUrl;
      if (directSrc) {
        setYoutubeVideoId(null);
        startDirectMediaPlayback(mediaEl, directSrc, playbackRate, currentTrack, activeToken);
        return;
      }
    }

    // 3. Official YouTube IFrame Player (instant, compliant, no IP-locked 403 delays)
    if (ytId) {
      isNativeAudioActiveRef.current = false;
      void stopNativeAudio();
      stopAllHtmlMediaEls();
      setYoutubeVideoId(ytId);
      return;
    }

    setIsBuffering(false);
    setPlayerError('No playable stream URL found for this item.');
  }, [
    currentTrack?.id,
    playNonce,
    getActiveMediaEl,
    playbackRate,
    revokeActiveObjectUrl,
    startDirectMediaPlayback,
    startHtmlMediaPlayback,
    stopAllHtmlMediaEls,
    stopNativeAudio,
    onListenHistoryUpdated,
  ]);

  const autoplayRelatedRef = useRef(autoplayRelated);
  autoplayRelatedRef.current = autoplayRelated;

  const currentIndexRef = useRef(currentIndex);
  currentIndexRef.current = currentIndex;

  const queueRef = useRef(queue);
  queueRef.current = queue;

  useEffect(() => {
    if (!autoplayRelated) {
      rollingEpochRef.current += 1;
      rollingAutoplayInFlightRef.current = false;
      lastRollingSeedIdRef.current = null;

      const prevQueue = queueRef.current;
      if (!prevQueue.some((t) => t.queueOrigin === 'auto')) {
        return;
      }

      const activeIdx = currentIndexRef.current;
      const activeId =
        activeIdx >= 0 && activeIdx < prevQueue.length ? prevQueue[activeIdx].id : null;
      const kept: PlayableTrack[] = [];
      let computedIdx = -1;

      prevQueue.forEach((item, idx) => {
        if (item.queueOrigin !== 'auto') {
          if (idx === activeIdx) {
            computedIdx = kept.length;
          }
          kept.push(item);
        } else if (idx === activeIdx && activeId && item.id === activeId) {
          computedIdx = kept.length;
          kept.push({ ...item, queueOrigin: 'manual' });
        }
      });

      setQueue(kept);
      if (computedIdx !== activeIdx) {
        setCurrentIndex(computedIdx);
      }
      return;
    }

    lastRollingSeedIdRef.current = null;
  }, [autoplayRelated]);

  useEffect(() => {
    if (
      !autoplayRelated ||
      !currentTrack ||
      currentTrack.isLiveRadio ||
      currentIndex < 0
    ) {
      return;
    }

    const remainingUpcoming = queue.length - 1 - currentIndex;
    if (remainingUpcoming > ROLLING_AUTOPLAY_MIN_UPCOMING) {
      return;
    }

    const seedTrack = queue[queue.length - 1] ?? currentTrack;
    if (!seedTrack || seedTrack.isLiveRadio) {
      return;
    }

    if (
      rollingAutoplayInFlightRef.current ||
      lastRollingSeedIdRef.current === seedTrack.id
    ) {
      return;
    }

    rollingAutoplayInFlightRef.current = true;
    lastRollingSeedIdRef.current = seedTrack.id;
    const activeEpoch = rollingEpochRef.current;

    const historyArtists = getTopListenedArtists(getSavedListenHistory());

    void fetchRelatedMedia(backendUrl, {
      id: seedTrack.id,
      title: seedTrack.title,
      uploader: seedTrack.uploader,
      historyArtists,
    })
      .then((related) => {
        if (
          !autoplayRelatedRef.current ||
          rollingEpochRef.current !== activeEpoch ||
          related.length === 0
        ) {
          return;
        }
        const targetMode: MediaFormatMode = audioOnlyModeRef.current
          ? 'audio'
          : defaultPlayMode;
        setQueue((prev) => {
          const existingIds = new Set(prev.map((t) => t.id));
          const distinct = filterDistinctRelatedItems(related, seedTrack, existingIds);
          const unplayed = distinct.filter(
            (item) => !playedTrackIdsRef.current.has(item.id)
          );
          const chosen = unplayed.length > 0 ? unplayed : distinct;
          const toAppend = chosen.slice(0, 6).map<PlayableTrack>((item) => ({
            id: item.id,
            title: item.title,
            uploader: item.uploader,
            duration: item.duration,
            thumbnail: item.thumbnail,
            url: item.url,
            sourceUrl: item.url,
            streamUrl: item.directStreamUrl ?? '',
            directStreamUrl: item.directStreamUrl,
            isLiveRadio: item.isLiveRadio,
            mode: item.mediaType ?? targetMode,
            isOffline: false,
            queueOrigin: 'auto',
          }));
          if (toAppend.length === 0) {
            return prev;
          }
          return [...prev, ...toAppend];
        });
      })
      .finally(() => {
        if (rollingEpochRef.current === activeEpoch) {
          rollingAutoplayInFlightRef.current = false;
        }
      });
  }, [
    autoplayRelated,
    currentTrack,
    currentIndex,
    queue,
    backendUrl,
    defaultPlayMode,
  ]);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = playbackRate;
    }
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackRate;
    }
    youtubeBridgeRef.current?.setPlaybackRate(playbackRate);
  }, [playbackRate]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    const onEnterPip = () => setIsPipActive(true);
    const onLeavePip = () => setIsPipActive(false);

    video.addEventListener('enterpictureinpicture', onEnterPip);
    video.addEventListener('leavepictureinpicture', onLeavePip);
    return () => {
      video.removeEventListener('enterpictureinpicture', onEnterPip);
      video.removeEventListener('leavepictureinpicture', onLeavePip);
    };
  }, []);

  const pauseActivePlayback = useCallback(() => {
    if (isNativeAudioActiveRef.current) {
      void NativeAudio.pause({ assetId: NATIVE_AUDIO_ASSET_ID }).catch(() => {});
    } else if (youtubeVideoId) {
      youtubeBridgeRef.current?.pause();
    } else {
      getActiveMediaEl()?.pause();
    }
    setIsPlaying(false);
  }, [getActiveMediaEl, youtubeVideoId]);

  useEffect(() => {
    if (sleepTimerRemainingSec === null) {
      return;
    }
    if (sleepTimerRemainingSec <= 0) {
      pauseActivePlayback();
      setSleepTimerOption('off');
      setSleepTimerRemainingSec(null);
      return;
    }

    const timer = window.setInterval(() => {
      setSleepTimerRemainingSec((prev) => {
        if (prev === null) {
          return null;
        }
        if (prev <= 1) {
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [sleepTimerRemainingSec, pauseActivePlayback]);

  const setSleepTimer = useCallback((option: SleepTimerOption) => {
    setSleepTimerOption(option);
    if (option === 'off' || option === 'end') {
      setSleepTimerRemainingSec(null);
    } else {
      const minutes = Number(option);
      setSleepTimerRemainingSec(Number.isFinite(minutes) && minutes > 0 ? minutes * 60 : null);
    }
  }, []);

  const resetTrackLoadState = useCallback(() => {
    clearStallRecoveryTimer();
    embedRecoveryInFlightRef.current = false;
    setPlayerError(null);
  }, [clearStallRecoveryTimer]);

  const playTrack = useCallback(
    (track: PlayableTrack) => {
      resetTrackLoadState();
      rollingEpochRef.current += 1;
      rollingAutoplayInFlightRef.current = false;
      lastRollingSeedIdRef.current = null;
      const nextAudioOnly = track.mode === 'audio';
      audioOnlyModeRef.current = nextAudioOnly;
      setAudioOnlyMode(nextAudioOnly);
      const freshTrack: PlayableTrack = {
        ...track,
        queueOrigin: 'manual',
      };
      setQueue([freshTrack]);
      setCurrentIndex(0);
      setPlayNonce((n) => n + 1);
      syncMediaSessionMetadataNow(freshTrack, true, 0, freshTrack.duration, playbackRate);
    },
    [playbackRate, resetTrackLoadState, syncMediaSessionMetadataNow]
  );

  const playQueue = useCallback(
    (tracks: PlayableTrack[], startIndex = 0) => {
      if (tracks.length === 0) {
        return;
      }
      const safeIndex = Math.max(0, Math.min(startIndex, tracks.length - 1));
      resetTrackLoadState();
      rollingEpochRef.current += 1;
      rollingAutoplayInFlightRef.current = false;
      lastRollingSeedIdRef.current = null;
      const normalizedTracks = tracks.map((t) => ({
        ...t,
        queueOrigin: t.queueOrigin ?? 'manual',
      }));
      const promoted = promoteAutoplayTrackAtIndex(normalizedTracks, safeIndex);
      const activeTrack = promoted.track ?? normalizedTracks[safeIndex];
      const nextAudioOnly = activeTrack.mode === 'audio';
      audioOnlyModeRef.current = nextAudioOnly;
      setAudioOnlyMode(nextAudioOnly);
      setQueue(promoted.queue);
      setCurrentIndex(promoted.newIndex);
      setPlayNonce((n) => n + 1);
      syncMediaSessionMetadataNow(activeTrack, true, 0, activeTrack.duration, playbackRate);
    },
    [playbackRate, resetTrackLoadState, syncMediaSessionMetadataNow]
  );

  const jumpToQueueIndex = useCallback(
    (index: number) => {
      const prevQueue = queueRef.current;
      if (index < 0 || index >= prevQueue.length) {
        return;
      }
      resetTrackLoadState();
      const target = prevQueue[index];
      if (isAutoplayTrack(target)) {
        const promoted = promoteAutoplayTrackAtIndex(prevQueue, index);
        const promotedTrack = promoted.track ?? { ...target, queueOrigin: 'manual' };
        const nextAudioOnly = promotedTrack.mode === 'audio';
        audioOnlyModeRef.current = nextAudioOnly;
        setAudioOnlyMode(nextAudioOnly);
        setQueue(promoted.queue);
        setCurrentIndex(promoted.newIndex);
        setPlayNonce((n) => n + 1);
        syncMediaSessionMetadataNow(promotedTrack, true, 0, promotedTrack.duration, playbackRate);
        return;
      }
      const nextAudioOnly = target.mode === 'audio';
      audioOnlyModeRef.current = nextAudioOnly;
      setAudioOnlyMode(nextAudioOnly);
      setCurrentIndex(index);
      setPlayNonce((n) => n + 1);
      syncMediaSessionMetadataNow(target, true, 0, target.duration, playbackRate);
    },
    [playbackRate, resetTrackLoadState, syncMediaSessionMetadataNow]
  );

  const playNextInQueue = useCallback(
    (track: PlayableTrack) => {
      const manualTrack: PlayableTrack = { ...track, queueOrigin: 'manual' };
      const prev = queueRef.current;
      const activeIdx = currentIndexRef.current;

      if (prev.length === 0 || activeIdx < 0) {
        resetTrackLoadState();
        const nextAudioOnly = manualTrack.mode === 'audio';
        audioOnlyModeRef.current = nextAudioOnly;
        setAudioOnlyMode(nextAudioOnly);
        setQueue([manualTrack]);
        setCurrentIndex(0);
        setPlayNonce((n) => n + 1);
        syncMediaSessionMetadataNow(manualTrack, true, 0, manualTrack.duration, playbackRate);
        return;
      }

      const inserted = insertPlayNextInQueue(prev, activeIdx, manualTrack);
      const normalized = enforceQueueOrderInvariant(inserted.queue, inserted.currentIndex);
      setQueue(normalized.queue);
      if (normalized.currentIndex !== activeIdx) {
        setCurrentIndex(normalized.currentIndex);
      }
    },
    [playbackRate, resetTrackLoadState, syncMediaSessionMetadataNow]
  );

  const addToQueue = useCallback(
    (track: PlayableTrack) => {
      const manualTrack: PlayableTrack = { ...track, queueOrigin: 'manual' };
      const prev = queueRef.current;
      const activeIdx = currentIndexRef.current;

      if (prev.length === 0 || activeIdx < 0) {
        resetTrackLoadState();
        const nextAudioOnly = manualTrack.mode === 'audio';
        audioOnlyModeRef.current = nextAudioOnly;
        setAudioOnlyMode(nextAudioOnly);
        setQueue([manualTrack]);
        setCurrentIndex(0);
        setPlayNonce((n) => n + 1);
        syncMediaSessionMetadataNow(manualTrack, true, 0, manualTrack.duration, playbackRate);
        return;
      }

      const existingIdx = prev.findIndex((t) => t.id === manualTrack.id);
      if (existingIdx !== -1) {
        if (!isAutoplayTrack(prev[existingIdx])) {
          const normalized = enforceQueueOrderInvariant(prev, activeIdx);
          setQueue(normalized.queue);
          if (normalized.currentIndex !== activeIdx) {
            setCurrentIndex(normalized.currentIndex);
          }
          return;
        }
        const withoutExisting = prev.filter((_, idx) => idx !== existingIdx);
        const adjustedActiveIdx =
          existingIdx < activeIdx ? Math.max(0, activeIdx - 1) : activeIdx;
        const firstAutoIdx = withoutExisting.findIndex((t) => isAutoplayTrack(t));
        const promotedItem: PlayableTrack = {
          ...prev[existingIdx],
          ...manualTrack,
          queueOrigin: 'manual',
        };
        const inserted =
          firstAutoIdx === -1
            ? [...withoutExisting, promotedItem]
            : [
                ...withoutExisting.slice(0, firstAutoIdx),
                promotedItem,
                ...withoutExisting.slice(firstAutoIdx),
              ];
        const normalized = enforceQueueOrderInvariant(inserted, adjustedActiveIdx);
        setQueue(normalized.queue);
        if (normalized.currentIndex !== activeIdx) {
          setCurrentIndex(normalized.currentIndex);
        }
        return;
      }

      const firstAutoIdx = prev.findIndex((t) => isAutoplayTrack(t));
      const inserted =
        firstAutoIdx === -1
          ? [...prev, manualTrack]
          : [...prev.slice(0, firstAutoIdx), manualTrack, ...prev.slice(firstAutoIdx)];
      const normalized = enforceQueueOrderInvariant(inserted, activeIdx);
      setQueue(normalized.queue);
      if (normalized.currentIndex !== activeIdx) {
        setCurrentIndex(normalized.currentIndex);
      }
    },
    [playbackRate, resetTrackLoadState, syncMediaSessionMetadataNow]
  );

  const reorderQueueItem = useCallback((fromIndex: number, toIndex: number) => {
    const prev = queueRef.current;
    const activeIdx = currentIndexRef.current;
    if (prev.length === 0) {
      return;
    }

    const firstAutoIdx = prev.findIndex((t) => isAutoplayTrack(t));
    const manualCount = firstAutoIdx === -1 ? prev.length : firstAutoIdx;

    if (fromIndex < 0 || fromIndex >= manualCount) {
      return;
    }
    const clampedTo = Math.max(0, Math.min(toIndex, manualCount - 1));
    if (clampedTo === fromIndex) {
      return;
    }

    const res = moveQueueItem(prev, fromIndex, clampedTo, activeIdx);
    const normalized = enforceQueueOrderInvariant(res.queue, res.currentIndex);
    setQueue(normalized.queue);
    if (normalized.currentIndex !== activeIdx) {
      setCurrentIndex(normalized.currentIndex);
    }
  }, []);

  const moveQueueTrack = reorderQueueItem;

  const removeFromQueue = useCallback(
    (indexToRemove: number) => {
      const prev = queueRef.current;
      const activeIdx = currentIndexRef.current;
      if (indexToRemove < 0 || indexToRemove >= prev.length) {
        return;
      }
      const next = prev.filter((_, idx) => idx !== indexToRemove);
      if (next.length === 0) {
        void stopNativeAudio();
        setQueue([]);
        setCurrentIndex(-1);
        setExpanded(false);
        setQueueOpen(false);
        setVideoFullscreen(false);
        setYoutubeVideoId(null);
        syncMediaSessionMetadataNow(null, false);
        return;
      }

      if (indexToRemove < activeIdx) {
        setQueue(next);
        setCurrentIndex(Math.max(0, activeIdx - 1));
      } else if (indexToRemove === activeIdx) {
        const nextIdx = Math.min(activeIdx, next.length - 1);
        const promoted = promoteAutoplayTrackAtIndex(next, nextIdx);
        resetTrackLoadState();
        setQueue(promoted.queue);
        setCurrentIndex(promoted.newIndex);
        setPlayNonce((n) => n + 1);
        if (promoted.track) {
          syncMediaSessionMetadataNow(promoted.track, true, 0, promoted.track.duration, playbackRate);
        }
      } else {
        setQueue(next);
      }
    },
    [playbackRate, resetTrackLoadState, stopNativeAudio, syncMediaSessionMetadataNow]
  );

  const clearQueue = useCallback(() => {
    rollingEpochRef.current += 1;
    rollingAutoplayInFlightRef.current = false;
    lastRollingSeedIdRef.current = null;
    void stopNativeAudio();
    setQueue([]);
    setCurrentIndex(-1);
    resetTrackLoadState();
    setVideoFullscreen(false);
    setQueueOpen(false);
    setExpanded(false);
    setYoutubeVideoId(null);
    syncMediaSessionMetadataNow(null, false);
  }, [resetTrackLoadState, stopNativeAudio, syncMediaSessionMetadataNow]);

  const stopAndClearCurrent = useCallback(() => {
    void stopNativeAudio();
    stopAllHtmlMediaEls();
    youtubeBridgeRef.current?.pause();
    setCurrentIndex(-1);
    resetTrackLoadState();
    setVideoFullscreen(false);
    setQueueOpen(false);
    setExpanded(false);
    setYoutubeVideoId(null);
    syncMediaSessionMetadataNow(null, false);
  }, [resetTrackLoadState, stopAllHtmlMediaEls, stopNativeAudio, syncMediaSessionMetadataNow]);

  const togglePlayPause = useCallback(async () => {
    if (!currentTrack) {
      return;
    }

    if (isNativeAudioActiveRef.current) {
      try {
        if (isPlaying) {
          await NativeAudio.pause({ assetId: NATIVE_AUDIO_ASSET_ID });
          setIsPlaying(false);
        } else {
          nativeAudioStartedAtRef.current = Date.now();
          await NativeAudio.resume({ assetId: NATIVE_AUDIO_ASSET_ID });
          setIsPlaying(true);
        }
      } catch (err) {
        setPlayerError(err instanceof Error ? err.message : 'Unable to toggle playback.');
      }
      return;
    }

    if (youtubeVideoId) {
      if (isPlaying) {
        youtubeBridgeRef.current?.pause();
        setIsPlaying(false);
      } else {
        youtubeBridgeRef.current?.play();
        setIsPlaying(true);
      }
      return;
    }

    const mediaEl = getActiveMediaEl();
    if (!mediaEl) {
      return;
    }
    if (eqEnabled) {
      resumeEqualizerContext(mediaEl as HTMLVideoElement, eqGains);
    }
    if (mediaEl.paused || mediaEl.ended) {
      try {
        await mediaEl.play();
      } catch (err) {
        setPlayerError(
          err instanceof Error ? err.message : 'Unable to start playback.'
        );
      }
    } else {
      mediaEl.pause();
    }
  }, [currentTrack, eqEnabled, eqGains, getActiveMediaEl, isPlaying, youtubeVideoId]);

  const seekTo = useCallback(
    (seconds: number) => {
      if (isNativeAudioActiveRef.current) {
        const clamped = clampSeekTime(seconds, duration);
        void NativeAudio.setCurrentTime({
          assetId: NATIVE_AUDIO_ASSET_ID,
          time: clamped,
        }).catch(() => {});
        setCurrentTime(clamped);
        return;
      }
      if (youtubeVideoId) {
        const clamped = clampSeekTime(seconds, duration);
        youtubeBridgeRef.current?.seekTo(clamped);
        setCurrentTime(clamped);
        return;
      }
      const mediaEl = getActiveMediaEl();
      if (!mediaEl) {
        return;
      }
      const effectiveDuration =
        Number.isFinite(mediaEl.duration) && mediaEl.duration > 0 ? mediaEl.duration : duration;
      const clamped = clampSeekTime(seconds, effectiveDuration);
      mediaEl.currentTime = clamped;
      setCurrentTime(clamped);
    },
    [duration, getActiveMediaEl, youtubeVideoId]
  );

  const skipBy = useCallback(
    (deltaSeconds: number) => {
      if (isNativeAudioActiveRef.current || youtubeVideoId) {
        seekTo(currentTime + deltaSeconds);
        return;
      }
      const mediaEl = getActiveMediaEl();
      if (!mediaEl) {
        return;
      }
      const baseTime = Number.isFinite(mediaEl.currentTime) ? mediaEl.currentTime : currentTime;
      seekTo(baseTime + deltaSeconds);
    },
    [currentTime, getActiveMediaEl, seekTo, youtubeVideoId]
  );

  const fetchAndPlayRelatedNext = useCallback(async () => {
    if (!currentTrack || fetchingRelatedRef.current) {
      return false;
    }
    fetchingRelatedRef.current = true;
    setIsBuffering(true);
    try {
      const historyArtists = getTopListenedArtists(getSavedListenHistory());
      const related = await fetchRelatedMedia(backendUrl, {
        id: currentTrack.id,
        title: currentTrack.title,
        uploader: currentTrack.uploader,
        historyArtists,
      });
      const prevQueue = queueRef.current;
      const existingIds = new Set(prevQueue.map((t) => t.id));
      const distinct = filterDistinctRelatedItems(related, currentTrack, existingIds);
      const unplayed = distinct.filter((item) => !playedTrackIdsRef.current.has(item.id));
      const chosen = unplayed.length > 0 ? unplayed : distinct;

      if (chosen.length === 0) {
        return false;
      }

      const targetMode: MediaFormatMode = audioOnlyModeRef.current ? 'audio' : defaultPlayMode;
      const newTracks = chosen.slice(0, 6).map<PlayableTrack>((item, idx) => ({
        id: item.id,
        title: item.title,
        uploader: item.uploader,
        duration: item.duration,
        thumbnail: item.thumbnail,
        url: item.url,
        sourceUrl: item.url,
        streamUrl: item.directStreamUrl ?? '',
        directStreamUrl: item.directStreamUrl,
        isLiveRadio: item.isLiveRadio,
        mode: item.mediaType ?? targetMode,
        isOffline: false,
        queueOrigin: idx === 0 ? 'manual' : 'auto',
      }));

      const manualExisting = prevQueue.filter((t) => !isAutoplayTrack(t));
      const autoExisting = prevQueue.filter((t) => isAutoplayTrack(t));
      const [promotedFirst, ...remainingAuto] = newTracks;
      const nextQueue = [...manualExisting, promotedFirst, ...autoExisting, ...remainingAuto];
      const nextIdx = manualExisting.length;

      resetTrackLoadState();
      setQueue(nextQueue);
      setCurrentIndex(nextIdx);
      setPlayNonce((n) => n + 1);
      syncMediaSessionMetadataNow(promotedFirst, true, 0, promotedFirst.duration, playbackRate);
      return true;
    } catch {
      return false;
    } finally {
      fetchingRelatedRef.current = false;
      setIsBuffering(false);
    }
  }, [backendUrl, currentTrack, defaultPlayMode, playbackRate, resetTrackLoadState, syncMediaSessionMetadataNow]);

  const playNext = useCallback(() => {
    const prevQueue = queueRef.current;
    const activeIdx = currentIndexRef.current;
    const activeTrack = activeIdx >= 0 && activeIdx < prevQueue.length ? prevQueue[activeIdx] : null;

    if (loopMode === 'all' && activeTrack && !isAutoplayTrack(activeTrack)) {
      const firstManualIdx = prevQueue.findIndex((t) => !isAutoplayTrack(t));
      let lastManualIdx = -1;
      for (let i = prevQueue.length - 1; i >= 0; i -= 1) {
        if (!isAutoplayTrack(prevQueue[i])) {
          lastManualIdx = i;
          break;
        }
      }
      if (firstManualIdx !== -1 && activeIdx === lastManualIdx) {
        if (firstManualIdx === activeIdx) {
          seekTo(0);
          if (isNativeAudioActiveRef.current) {
            void NativeAudio.resume({ assetId: NATIVE_AUDIO_ASSET_ID }).catch(() => {});
          } else if (youtubeVideoId) {
            youtubeBridgeRef.current?.play();
          } else {
            void getActiveMediaEl()?.play().catch(() => {});
          }
          setIsPlaying(true);
          syncMediaSessionMetadataNow(activeTrack, true, 0, activeTrack.duration, playbackRate);
          return;
        }
        const wrappedTrack = prevQueue[firstManualIdx];
        resetTrackLoadState();
        setCurrentIndex(firstManualIdx);
        setPlayNonce((n) => n + 1);
        syncMediaSessionMetadataNow(wrappedTrack, true, 0, wrappedTrack.duration, playbackRate);
        return;
      }
    }

    const nextIdx = getNextTrackIndex(activeIdx, prevQueue.length, loopMode === 'all');
    if (nextIdx !== -1) {
      if (nextIdx === activeIdx) {
        seekTo(0);
        if (isNativeAudioActiveRef.current) {
          void NativeAudio.resume({ assetId: NATIVE_AUDIO_ASSET_ID }).catch(() => {});
        } else if (youtubeVideoId) {
          youtubeBridgeRef.current?.play();
        } else {
          void getActiveMediaEl()?.play().catch(() => {});
        }
        setIsPlaying(true);
        if (activeTrack) {
          syncMediaSessionMetadataNow(activeTrack, true, 0, activeTrack.duration, playbackRate);
        }
        return;
      }

      const candidate = prevQueue[nextIdx];
      resetTrackLoadState();
      if (isAutoplayTrack(candidate)) {
        const promoted = promoteAutoplayTrackAtIndex(prevQueue, nextIdx);
        const promotedTrack = promoted.track ?? { ...candidate, queueOrigin: 'manual' };
        setQueue(promoted.queue);
        setCurrentIndex(promoted.newIndex);
        setPlayNonce((n) => n + 1);
        syncMediaSessionMetadataNow(promotedTrack, true, 0, promotedTrack.duration, playbackRate);
        return;
      }

      setCurrentIndex(nextIdx);
      setPlayNonce((n) => n + 1);
      syncMediaSessionMetadataNow(candidate, true, 0, candidate.duration, playbackRate);
      return;
    }

    if (autoplayRelated && activeTrack && !activeTrack.isLiveRadio) {
      void fetchAndPlayRelatedNext();
    }
  }, [
    autoplayRelated,
    fetchAndPlayRelatedNext,
    getActiveMediaEl,
    loopMode,
    playbackRate,
    resetTrackLoadState,
    seekTo,
    syncMediaSessionMetadataNow,
    youtubeVideoId,
  ]);

  const playPrevious = useCallback(() => {
    const prevQueue = queueRef.current;
    const activeIdx = currentIndexRef.current;
    const mediaEl = getActiveMediaEl();
    const activeTime =
      !isNativeAudioActiveRef.current &&
      !youtubeVideoId &&
      mediaEl &&
      Number.isFinite(mediaEl.currentTime)
        ? mediaEl.currentTime
        : currentTime;
    const action = getPreviousTrackAction(activeIdx, activeTime, prevQueue.length);
    if (action.action === 'restart') {
      seekTo(0);
      if (isNativeAudioActiveRef.current) {
        void NativeAudio.resume({ assetId: NATIVE_AUDIO_ASSET_ID }).catch(() => {});
      } else if (youtubeVideoId) {
        youtubeBridgeRef.current?.play();
      } else if (mediaEl && mediaEl.paused) {
        void mediaEl.play().catch(() => {});
      }
      const activeTrack = activeIdx >= 0 ? prevQueue[activeIdx] : null;
      if (activeTrack) {
        syncMediaSessionMetadataNow(activeTrack, true, 0, activeTrack.duration, playbackRate);
      }
    } else if (action.action === 'switch') {
      const target = prevQueue[action.targetIndex];
      resetTrackLoadState();
      setCurrentIndex(action.targetIndex);
      setPlayNonce((n) => n + 1);
      if (target) {
        syncMediaSessionMetadataNow(target, true, 0, target.duration, playbackRate);
      }
    }
  }, [
    currentTime,
    getActiveMediaEl,
    playbackRate,
    resetTrackLoadState,
    seekTo,
    syncMediaSessionMetadataNow,
    youtubeVideoId,
  ]);

  const setPlaybackRate = useCallback((rate: PlaybackRate) => {
    setPlaybackRateState(rate);
    if (videoRef.current) {
      videoRef.current.playbackRate = rate;
    }
    if (audioRef.current) {
      audioRef.current.playbackRate = rate;
    }
    youtubeBridgeRef.current?.setPlaybackRate(rate);
  }, []);

  const cycleLoopMode = useCallback(() => {
    setLoopMode((prev) => getNextLoopMode(prev));
  }, []);

  const toggleAudioOnlyMode = useCallback(() => {
    const nextAudioOnly = !audioOnlyModeRef.current;
    audioOnlyModeRef.current = nextAudioOnly;
    setAudioOnlyMode(nextAudioOnly);
  }, []);

  const toggleAutoplayRelated = useCallback(() => {
    onToggleAutoplayRelated?.();
  }, [onToggleAutoplayRelated]);

  const togglePictureInPicture = useCallback(async () => {
    if (youtubeVideoId) {
      setPipMessage('Picture-in-Picture requires a direct video stream.');
      return;
    }
    const video = videoRef.current;
    if (!video || !currentTrack) {
      return;
    }
    setPipMessage(null);
    if (!document.pictureInPictureEnabled || typeof video.requestPictureInPicture !== 'function') {
      setPipMessage('Picture-in-Picture is not supported in this browser.');
      return;
    }
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        if (video.readyState === 0) {
          setPipMessage('Load video first.');
          return;
        }
        await video.requestPictureInPicture();
      }
    } catch (err) {
      setPipMessage(err instanceof Error ? err.message : 'Unable to start Picture-in-Picture.');
    }
  }, [currentTrack, youtubeVideoId]);

  const clearPlayerError = useCallback(() => setPlayerError(null), []);

  const initEqualizer = useCallback(() => {
    setEqEnabled(true);
    resumeEqualizerContext(getActiveMediaEl() as HTMLVideoElement | null, eqGains);
  }, [eqGains, getActiveMediaEl]);

  const setEqBandGain = useCallback(
    (bandIndex: number, gainDb: number) => {
      setEqEnabled(true);
      const clamped = clampEqGain(gainDb);
      setEqGains((prev) => {
        const next: EqGains = [...prev] as EqGains;
        next[bandIndex] = clamped;
        applyEqualizerGains(getActiveMediaEl() as HTMLVideoElement | null, next);
        return next;
      });
    },
    [getActiveMediaEl]
  );

  const applyEqPreset = useCallback(
    (presetName: EqPresetName) => {
      setEqEnabled(true);
      const preset: EqGains = [...EQ_PRESETS[presetName]] as EqGains;
      setEqGains(preset);
      applyEqualizerGains(getActiveMediaEl() as HTMLVideoElement | null, preset);
    },
    [getActiveMediaEl]
  );

  const playNextRef = useRef(playNext);
  playNextRef.current = playNext;
  const playPreviousRef = useRef(playPrevious);
  playPreviousRef.current = playPrevious;

  // MediaSession integration for Lock Screen & Dynamic Island
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) {
      return;
    }

    const mediaSession = navigator.mediaSession;
    if (!currentTrack) {
      mediaSession.metadata = null;
      mediaSession.playbackState = 'none';
      return;
    }

    syncMediaSessionMetadataNow(
      currentTrack,
      isPlaying,
      currentTime,
      duration > 0 ? duration : currentTrack.duration,
      playbackRate
    );

    const setSafeHandler = (
      action: MediaSessionAction,
      handler: MediaSessionActionHandler | null
    ) => {
      try {
        mediaSession.setActionHandler(action, handler);
      } catch {
        // Ignore unsupported action names
      }
    };

    setSafeHandler('play', () => {
      if (isNativeAudioActiveRef.current) {
        nativeAudioStartedAtRef.current = Date.now();
        void NativeAudio.resume({ assetId: NATIVE_AUDIO_ASSET_ID }).catch(() => {});
        setIsPlaying(true);
      } else if (youtubeVideoId) {
        youtubeBridgeRef.current?.play();
      } else {
        void getActiveMediaEl()?.play().catch(() => {});
      }
    });
    setSafeHandler('pause', () => {
      if (isNativeAudioActiveRef.current) {
        void NativeAudio.pause({ assetId: NATIVE_AUDIO_ASSET_ID }).catch(() => {});
        setIsPlaying(false);
      } else if (youtubeVideoId) {
        youtubeBridgeRef.current?.pause();
      } else {
        getActiveMediaEl()?.pause();
      }
    });
    setSafeHandler('seekbackward', (details) => {
      skipBy(-(details.seekOffset ?? 10));
    });
    setSafeHandler('seekforward', (details) => {
      skipBy(details.seekOffset ?? 10);
    });
    setSafeHandler('previoustrack', () => {
      playPreviousRef.current();
    });
    setSafeHandler('nexttrack', () => {
      playNextRef.current();
    });
    setSafeHandler('seekto', (details) => {
      if (typeof details.seekTime === 'number') {
        seekTo(details.seekTime);
      }
    });

    return () => {
      setSafeHandler('play', null);
      setSafeHandler('pause', null);
      setSafeHandler('seekbackward', null);
      setSafeHandler('seekforward', null);
      setSafeHandler('previoustrack', null);
      setSafeHandler('nexttrack', null);
      setSafeHandler('seekto', null);
    };
  }, [
    currentTrack,
    getActiveMediaEl,
    isPlaying,
    skipBy,
    seekTo,
    youtubeVideoId,
    syncMediaSessionMetadataNow,
    duration,
    playbackRate,
  ]);

  useEffect(() => {
    if (
      typeof navigator === 'undefined' ||
      !('mediaSession' in navigator) ||
      typeof navigator.mediaSession.setPositionState !== 'function'
    ) {
      return;
    }
    if (!currentTrack || !Number.isFinite(duration) || duration <= 0) {
      return;
    }
    try {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate,
        position: Math.min(duration, Math.max(0, currentTime)),
      });
    } catch {
      // Ignore transient invalid state
    }
  }, [currentTrack, duration, currentTime, playbackRate]);

  const scheduleStallRecovery = useCallback(() => {
    if (stallRecoveryTimerRef.current !== null || youtubeVideoId || isNativeAudioActiveRef.current) {
      return;
    }
    stallRecoveryTimerRef.current = window.setTimeout(() => {
      stallRecoveryTimerRef.current = null;
      const mediaEl = getActiveMediaEl();
      if (!mediaEl || mediaEl.paused || mediaEl.ended || youtubeVideoId || isNativeAudioActiveRef.current) {
        return;
      }
      try {
        if (Number.isFinite(mediaEl.currentTime)) {
          mediaEl.currentTime = mediaEl.currentTime;
        }
        void mediaEl.play().catch(() => {});
      } catch {
        // Ignore transient seek/play errors
      }
    }, STALL_RECOVERY_DELAY_MS);
  }, [getActiveMediaEl, youtubeVideoId]);

  const handlePlay = () => {
    clearStallRecoveryTimer();
    setIsPlaying(true);
    setIsBuffering(false);
    setPlayerError(null);
  };

  const handlePause = () => {
    if (isNativeAudioActiveRef.current) {
      return;
    }
    clearStallRecoveryTimer();
    setIsPlaying(false);
  };

  const handleTimeUpdate = (e: React.SyntheticEvent<HTMLMediaElement>) => {
    if (isNativeAudioActiveRef.current) {
      return;
    }
    const mediaEl = e.currentTarget;
    if (mediaEl !== getActiveMediaEl()) {
      return;
    }
    if (Number.isFinite(mediaEl.currentTime)) {
      if (Math.abs(mediaEl.currentTime - lastStallTimeRef.current) > 0.15) {
        clearStallRecoveryTimer();
        lastStallTimeRef.current = mediaEl.currentTime;
      }
      setCurrentTime(mediaEl.currentTime);
    }
  };

  const handleLoadedMetadata = (e: React.SyntheticEvent<HTMLMediaElement>) => {
    if (isNativeAudioActiveRef.current) {
      return;
    }
    const mediaEl = e.currentTarget;
    if (mediaEl !== getActiveMediaEl()) {
      return;
    }
    mediaEl.playbackRate = playbackRate;
    mediaEl.loop = false;
    if (Number.isFinite(mediaEl.duration) && mediaEl.duration > 0) {
      setDuration(mediaEl.duration);
    }
    setIsBuffering(false);
  };

  const handleEnded = useCallback(async () => {
    if (sleepTimerOption === 'end') {
      void stopNativeAudio();
      setSleepTimerOption('off');
      setSleepTimerRemainingSec(null);
      setIsPlaying(false);
      return;
    }

    const prevQueue = queueRef.current;
    const activeIdx = currentIndexRef.current;
    const activeTrack =
      activeIdx >= 0 && activeIdx < prevQueue.length ? prevQueue[activeIdx] : currentTrack;

    if (loopMode === 'one') {
      if (isNativeAudioActiveRef.current) {
        nativeAudioStartedAtRef.current = Date.now();
        void NativeAudio.play({ assetId: NATIVE_AUDIO_ASSET_ID, time: 0 }).catch(() => {});
      } else if (youtubeVideoId) {
        youtubeBridgeRef.current?.seekTo(0);
        youtubeBridgeRef.current?.play();
      } else {
        const mediaEl = getActiveMediaEl();
        if (mediaEl) {
          mediaEl.currentTime = 0;
          void mediaEl.play().catch(() => {});
        }
      }
      setCurrentTime(0);
      setIsPlaying(true);
      if (activeTrack) {
        syncMediaSessionMetadataNow(activeTrack, true, 0, activeTrack.duration, playbackRate);
      }
      return;
    }

    if (loopMode === 'all' && activeTrack && !isAutoplayTrack(activeTrack)) {
      const firstManualIdx = prevQueue.findIndex((t) => !isAutoplayTrack(t));
      let lastManualIdx = -1;
      for (let i = prevQueue.length - 1; i >= 0; i -= 1) {
        if (!isAutoplayTrack(prevQueue[i])) {
          lastManualIdx = i;
          break;
        }
      }
      if (firstManualIdx !== -1 && activeIdx === lastManualIdx) {
        if (firstManualIdx === activeIdx) {
          if (isNativeAudioActiveRef.current) {
            nativeAudioStartedAtRef.current = Date.now();
            void NativeAudio.play({ assetId: NATIVE_AUDIO_ASSET_ID, time: 0 }).catch(() => {});
          } else if (youtubeVideoId) {
            youtubeBridgeRef.current?.seekTo(0);
            youtubeBridgeRef.current?.play();
          } else {
            const mediaEl = getActiveMediaEl();
            if (mediaEl) {
              mediaEl.currentTime = 0;
              void mediaEl.play().catch(() => {});
            }
          }
          setCurrentTime(0);
          setIsPlaying(true);
          syncMediaSessionMetadataNow(activeTrack, true, 0, activeTrack.duration, playbackRate);
          return;
        }

        const wrappedTrack = prevQueue[firstManualIdx];
        resetTrackLoadState();
        setCurrentIndex(firstManualIdx);
        setPlayNonce((n) => n + 1);
        syncMediaSessionMetadataNow(wrappedTrack, true, 0, wrappedTrack.duration, playbackRate);
        return;
      }
    }

    const nextIdx = getNextTrackIndex(activeIdx, prevQueue.length, loopMode === 'all');
    if (nextIdx !== -1) {
      if (nextIdx === activeIdx) {
        if (isNativeAudioActiveRef.current) {
          nativeAudioStartedAtRef.current = Date.now();
          void NativeAudio.play({ assetId: NATIVE_AUDIO_ASSET_ID, time: 0 }).catch(() => {});
        } else if (youtubeVideoId) {
          youtubeBridgeRef.current?.seekTo(0);
          youtubeBridgeRef.current?.play();
        } else {
          const mediaEl = getActiveMediaEl();
          if (mediaEl) {
            mediaEl.currentTime = 0;
            void mediaEl.play().catch(() => {});
          }
        }
        setCurrentTime(0);
        setIsPlaying(true);
        if (activeTrack) {
          syncMediaSessionMetadataNow(activeTrack, true, 0, activeTrack.duration, playbackRate);
        }
        return;
      }

      const candidate = prevQueue[nextIdx];
      let targetTrack = candidate;
      let targetIndex = nextIdx;
      let nextQueueToSet: PlayableTrack[] | null = null;

      if (isAutoplayTrack(candidate)) {
        const promoted = promoteAutoplayTrackAtIndex(prevQueue, nextIdx);
        nextQueueToSet = promoted.queue;
        targetIndex = promoted.newIndex;
        targetTrack = promoted.track ?? { ...candidate, queueOrigin: 'manual' };
      }

      resetTrackLoadState();
      if (nextQueueToSet) {
        setQueue(nextQueueToSet);
      }
      setCurrentIndex(targetIndex);
      setPlayNonce((n) => n + 1);
      syncMediaSessionMetadataNow(targetTrack, true, 0, targetTrack.duration, playbackRate);
      return;
    }

    if (autoplayRelated && activeTrack && !activeTrack.isLiveRadio) {
      const started = await fetchAndPlayRelatedNext();
      if (started) {
        return;
      }
    }

    setIsPlaying(false);
  }, [
    loopMode,
    sleepTimerOption,
    autoplayRelated,
    currentTrack,
    getActiveMediaEl,
    playbackRate,
    youtubeVideoId,
    resetTrackLoadState,
    fetchAndPlayRelatedNext,
    stopNativeAudio,
    syncMediaSessionMetadataNow,
  ]);

  handleEndedRef.current = handleEnded;

  const handleMediaError = useCallback(() => {
    if (isNativeAudioActiveRef.current || youtubeVideoId) {
      return;
    }
    clearStallRecoveryTimer();
    setIsPlaying(false);
    setIsBuffering(false);
    setPlayerError('Could not load this stream.');
  }, [clearStallRecoveryTimer, youtubeVideoId]);

  const handleYouTubeEmbedBlocked = useCallback(async () => {
    if (!currentTrack || !youtubeVideoId || embedRecoveryInFlightRef.current) {
      return;
    }

    const trackId = currentTrack.id;
    const blockedMap = blockedYoutubeIdsRef.current;
    let blockedSet = blockedMap.get(trackId);
    if (!blockedSet) {
      blockedSet = new Set<string>();
      blockedMap.set(trackId, blockedSet);
    }
    blockedSet.add(youtubeVideoId);

    if (blockedSet.size >= 2) {
      setIsPlaying(false);
      setIsBuffering(false);
      setPlayerError('Embedding is disabled by the uploader for this video.');
      return;
    }

    embedRecoveryInFlightRef.current = true;
    const tokenSnapshot = loadNonceRef.current;
    setPlayerError(null);
    setIsBuffering(true);

    try {
      const base = normalizeBackendUrl(backendUrl) || DEFAULT_BACKEND_URL;
      const altQuery = `${currentTrack.title} ${currentTrack.uploader} audio`.trim();
      const searchUrl = `${base}/api/search?q=${encodeURIComponent(altQuery)}&filter=all`;
      const resp = await fetch(searchUrl);
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const payload = (await resp.json()) as unknown;
      if (loadNonceRef.current !== tokenSnapshot) {
        return;
      }

      const items = normalizeSearchResults(payload, 'all');
      let alternateVideoId: string | null = null;
      for (const item of items) {
        const candidateId = extractYouTubeVideoId(item.url, item.id);
        if (candidateId && !blockedSet.has(candidateId)) {
          alternateVideoId = candidateId;
          break;
        }
      }

      if (alternateVideoId) {
        setYoutubeVideoId(alternateVideoId);
        return;
      }

      setIsPlaying(false);
      setIsBuffering(false);
      setPlayerError('Embedding is disabled by the uploader for this video.');
    } catch {
      if (loadNonceRef.current === tokenSnapshot) {
        setIsPlaying(false);
        setIsBuffering(false);
        setPlayerError('Stream unavailable on this source.');
      }
    } finally {
      embedRecoveryInFlightRef.current = false;
    }
  }, [backendUrl, currentTrack, youtubeVideoId]);

  const value: PlayerContextValue = {
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
    isVideoFullscreen,
    isLyricsViewOpen,
    isPipActive,
    isPipSupported,
    playerError,
    pipMessage,
    eqGains,
    activeEqPreset,
    sleepTimerOption,
    sleepTimerRemainingSec,
    isUsingYouTubeFallback: Boolean(youtubeVideoId),
    videoRef,
    playTrack,
    playQueue,
    jumpToQueueIndex,
    playNextInQueue,
    addToQueue,
    reorderQueueItem,
    moveQueueTrack,
    removeFromQueue,
    clearQueue,
    togglePlayPause,
    seekTo,
    skipBy,
    playNext,
    playPrevious,
    setPlaybackRate,
    cycleLoopMode,
    toggleAudioOnlyMode,
    toggleAutoplayRelated,
    togglePictureInPicture,
    setExpanded,
    setQueueOpen,
    setVideoFullscreen,
    setLyricsViewOpen,
    stopAndClearCurrent,
    clearPlayerError,
    setEqBandGain,
    applyEqPreset,
    initEqualizer,
    setSleepTimer,
  };

  // Show the 16:9 stage for Video Mode AND whenever the official YouTube player is active
  const showVideoStage =
    isExpanded &&
    currentTrack &&
    (!audioOnlyMode || Boolean(youtubeVideoId)) &&
    !isQueueOpen &&
    (!isLyricsViewOpen || isVideoFullscreen);

  return (
    <PlayerContext.Provider value={value}>
      {children}
      <div
        id="tubidy-persistent-video-anchor"
        style={
          showVideoStage && !isVideoFullscreen
            ? { top: 'calc(env(safe-area-inset-top, 0px) + 74px)' }
            : undefined
        }
        className={
          isVideoFullscreen && showVideoStage
            ? 'fixed inset-0 z-[80] flex items-center justify-center bg-black p-2 sm:p-6 pointer-events-auto transition-opacity duration-200'
            : showVideoStage
              ? 'fixed inset-x-0 z-[60] mx-auto flex h-[min(74vw,34dvh,290px)] w-full max-w-2xl items-center justify-center px-5 pointer-events-auto transition-opacity duration-200'
              : 'fixed bottom-0 left-0 h-px w-px overflow-hidden opacity-0 pointer-events-none'
        }
      >
        <div
          className={
            isVideoFullscreen && showVideoStage
              ? 'relative flex h-full w-full items-center justify-center'
              : showVideoStage
                ? 'relative aspect-video w-full max-h-full overflow-hidden rounded-2xl bg-black shadow-2xl ring-1 ring-zinc-800'
                : 'h-px w-px overflow-hidden'
          }
        >
          {showVideoStage && !isVideoFullscreen && (
            <button
              type="button"
              onClick={() => setVideoFullscreen(true)}
              aria-label="Fullscreen video"
              className="absolute bottom-2.5 right-2.5 z-[75] flex h-9 w-9 items-center justify-center rounded-full bg-zinc-950/80 text-zinc-100 ring-1 ring-white/20 backdrop-blur-md transition-transform hover:scale-105 hover:bg-zinc-900"
            >
              <Maximize2 size={16} />
            </button>
          )}

          {isVideoFullscreen && showVideoStage && (
            <div className="absolute right-4 top-4 z-[85] flex items-center gap-2 pt-safe">
              {!youtubeVideoId && (
                <button
                  type="button"
                  onClick={() => void togglePictureInPicture()}
                  aria-label="Picture-in-Picture"
                  aria-pressed={isPipActive}
                  className={`flex h-10 w-10 items-center justify-center rounded-full backdrop-blur-md transition-colors ${
                    isPipActive
                      ? 'bg-accent text-white'
                      : 'bg-zinc-900/80 text-zinc-100 ring-1 ring-white/15 hover:bg-zinc-800'
                  }`}
                >
                  <PictureInPicture2 size={18} />
                </button>
              )}
              <button
                type="button"
                onClick={() => setVideoFullscreen(false)}
                aria-label="Exit fullscreen video"
                className="flex h-10 w-10 items-center justify-center rounded-full bg-zinc-900/80 text-zinc-100 ring-1 ring-white/15 backdrop-blur-md hover:bg-zinc-800"
              >
                <Minimize2 size={18} />
              </button>
            </div>
          )}

          {youtubeVideoId ? (
            <YouTubePlayerBridge
              ref={youtubeBridgeRef}
              videoId={youtubeVideoId}
              playbackRate={playbackRate}
              loop={loopMode === 'one' && sleepTimerOption !== 'end'}
              preferredQuality="default"
              onPlay={() => {
                setIsPlaying(true);
                setIsBuffering(false);
                setPlayerError(null);
              }}
              onPause={() => setIsPlaying(false)}
              onBuffering={(buf) => setIsBuffering(buf)}
              onTimeUpdate={(t, d) => {
                setCurrentTime(t);
                if (d > 0) {
                  setDuration(d);
                }
              }}
              onEnded={() => {
                void handleEnded();
              }}
              onEmbedBlocked={() => {
                void handleYouTubeEmbedBlocked();
              }}
              onError={() => {
                setIsPlaying(false);
                setIsBuffering(false);
                setPlayerError('Stream unavailable on this source.');
              }}
            />
          ) : (
            <video
              ref={videoRef}
              playsInline
              crossOrigin={eqEnabled ? 'anonymous' : undefined}
              preload="auto"
              aria-label={currentTrack ? `Media player: ${currentTrack.title}` : 'Media player'}
              className={
                showVideoStage
                  ? isVideoFullscreen
                    ? 'h-full w-full rounded-xl bg-black object-contain'
                    : 'h-full w-full bg-black object-contain'
                  : 'h-px w-px'
              }
              onPlay={handlePlay}
              onPause={handlePause}
              onTimeUpdate={handleTimeUpdate}
              onLoadedMetadata={handleLoadedMetadata}
              onDurationChange={handleLoadedMetadata}
              onWaiting={() => {
                setIsBuffering(true);
                scheduleStallRecovery();
              }}
              onStalled={() => {
                setIsBuffering(true);
                scheduleStallRecovery();
              }}
              onCanPlay={() => {
                clearStallRecoveryTimer();
                setIsBuffering(false);
              }}
              onPlaying={() => {
                clearStallRecoveryTimer();
                setIsBuffering(false);
                setIsPlaying(true);
              }}
              onEnded={() => {
                clearStallRecoveryTimer();
                void handleEnded();
              }}
              onError={handleMediaError}
            />
          )}
        </div>
      </div>

      {/* Dedicated HTML <audio> element for web browser and offline IndexedDB blobs */}
      <audio
        ref={audioRef}
        playsInline
        crossOrigin={eqEnabled ? 'anonymous' : undefined}
        preload="auto"
        aria-hidden="true"
        className="hidden"
        onPlay={handlePlay}
        onPause={handlePause}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onDurationChange={handleLoadedMetadata}
        onWaiting={() => {
          setIsBuffering(true);
          scheduleStallRecovery();
        }}
        onStalled={() => {
          setIsBuffering(true);
          scheduleStallRecovery();
        }}
        onCanPlay={() => {
          clearStallRecoveryTimer();
          setIsBuffering(false);
        }}
        onPlaying={() => {
          clearStallRecoveryTimer();
          setIsBuffering(false);
          setIsPlaying(true);
        }}
        onEnded={() => {
          clearStallRecoveryTimer();
          void handleEnded();
        }}
        onError={handleMediaError}
      />
    </PlayerContext.Provider>
  );
}

export function usePlayer(): PlayerContextValue {
  const ctx = useContext(PlayerContext);
  if (!ctx) {
    throw new Error('usePlayer must be used inside a PlayerProvider');
  }
  return ctx;
}