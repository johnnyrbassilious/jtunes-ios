import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
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
  RESOLVE_STREAM_TIMEOUT_MS,
  fetchRelatedMedia,
  normalizeSearchResults,
  resolveStream,
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

interface ResolvedStreamCacheEntry {
  url: string;
  mime: string;
  expiresAt: number;
}

interface NetworkInformationLike {
  effectiveType?: string;
  saveData?: boolean;
}

interface NativeInnertubeProfile {
  name: 'VISIONOS' | 'ANDROID_VR' | 'IOS';
  userAgent: string;
  clientNameHeader: string;
  clientVersion: string;
  clientPayload: Record<string, unknown>;
}

const NATIVE_IOS_INNERTUBE_PROFILES: readonly NativeInnertubeProfile[] = [
  {
    name: 'VISIONOS',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
    clientNameHeader: '101',
    clientVersion: '1.02',
    clientPayload: {
      clientName: 'VISIONOS',
      clientVersion: '1.02',
      deviceMake: 'Apple',
      deviceModel: 'RealityDevice17,1',
      osName: 'visionOS',
      osVersion: '26.5.23O471',
      hl: 'en',
      gl: 'US',
    },
  },
  {
    name: 'ANDROID_VR',
    userAgent:
      'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    clientNameHeader: '28',
    clientVersion: '1.65.10',
    clientPayload: {
      clientName: 'ANDROID_VR',
      clientVersion: '1.65.10',
      deviceMake: 'Oculus',
      deviceModel: 'Quest 3',
      androidSdkVersion: 32,
      osName: 'Android',
      osVersion: '12L',
      hl: 'en',
      gl: 'US',
    },
  },
  {
    name: 'IOS',
    userAgent:
      'com.google.ios.youtube/20.11.6 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    clientNameHeader: '5',
    clientVersion: '20.11.6',
    clientPayload: {
      clientName: 'IOS',
      clientVersion: '20.11.6',
      deviceMake: 'Apple',
      deviceModel: 'iPhone16,2',
      osName: 'iPhone',
      osVersion: '18.3.2.22D82',
      hl: 'en',
      gl: 'US',
    },
  },
];

const DEFAULT_STREAM_CACHE_TTL_MS = 15 * 60 * 1000;
const STALL_RECOVERY_DELAY_MS = 5000;
const ROLLING_AUTOPLAY_MIN_UPCOMING = 4;

function buildSilentKeepAliveWavDataUri(): string {
  const sampleRate = 8000;
  const numSamples = 2000;
  const totalSize = 44 + numSamples;
  const bytes = new Uint8Array(totalSize);
  const view = new DataView(bytes.buffer);
  const writeStr = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) {
      bytes[offset + i] = value.charCodeAt(i);
    }
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  writeStr(36, 'data');
  view.setUint32(40, numSamples, true);
  bytes.fill(128, 44);
  if (typeof btoa !== 'function') {
    return 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `data:audio/wav;base64,${btoa(binary)}`;
}

const SILENT_KEEPALIVE_WAV_DATA_URI = buildSilentKeepAliveWavDataUri();

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

function isSlowNetworkConnection(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }
  const conn = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
  const effectiveType = conn?.effectiveType?.toLowerCase() ?? '';
  return effectiveType === '2g' || effectiveType === '3g' || effectiveType === 'slow-2g';
}

function computeStreamExpiry(streamUrl: string): number {
  const now = Date.now();
  try {
    const parsed = new URL(streamUrl);
    const expireParam = Number(parsed.searchParams.get('expire'));
    if (Number.isFinite(expireParam) && expireParam > 0) {
      const expireMs = expireParam * 1000 - 60_000;
      if (expireMs > now + 30_000) {
        return Math.min(expireMs, now + 4 * 60 * 60 * 1000);
      }
    }
  } catch {
    // Ignore non-standard URLs
  }
  return now + DEFAULT_STREAM_CACHE_TTL_MS;
}

function buildStreamCacheKey(
  trackKey: string,
  mode: MediaFormatMode,
  quality: string
): string {
  return `${trackKey}::${mode}::${mode === 'audio' ? 'audio' : quality}`;
}

function getEffectiveRequestMode(
  track: PlayableTrack,
  isAudioOnly: boolean,
  slowNetwork: boolean
): MediaFormatMode {
  return isAudioOnly || slowNetwork || track.mode === 'audio' ? 'audio' : 'video';
}

function pickNativeIosStreamingFormat(
  streamingData: Record<string, unknown>,
  mode: MediaFormatMode,
  quality: string,
  preferLowestOverhead: boolean
): { url: string; mime: string } | null {
  const formats = Array.isArray(streamingData.formats)
    ? (streamingData.formats as Array<Record<string, unknown>>)
    : [];
  const adaptiveFormats = Array.isArray(streamingData.adaptiveFormats)
    ? (streamingData.adaptiveFormats as Array<Record<string, unknown>>)
    : [];
  const hlsManifestUrl =
    typeof streamingData.hlsManifestUrl === 'string' && streamingData.hlsManifestUrl.length > 0
      ? streamingData.hlsManifestUrl
      : null;

  if (mode === 'audio') {
    const allAudio = [...adaptiveFormats, ...formats].filter((f) => {
      const mime = typeof f.mimeType === 'string' ? f.mimeType : '';
      return typeof f.url === 'string' && f.url.length > 0 && mime.startsWith('audio/');
    });
    const mp4Audio = allAudio.filter((f) =>
      String(f.mimeType ?? '').toLowerCase().includes('audio/mp4')
    );
    const pool = mp4Audio.length > 0 ? mp4Audio : allAudio;
    if (pool.length > 0) {
      const sorted = [...pool].sort((a, b) => {
        const rateA = Number(a.bitrate ?? a.averageBitrate ?? 0);
        const rateB = Number(b.bitrate ?? b.averageBitrate ?? 0);
        return preferLowestOverhead ? rateA - rateB : rateB - rateA;
      });
      const chosen =
        preferLowestOverhead
          ? sorted.find((f) => Number(f.bitrate ?? f.averageBitrate ?? 0) >= 48_000) ?? sorted[0]
          : sorted[0];
      const rawMime = typeof chosen.mimeType === 'string' ? chosen.mimeType : 'audio/mp4';
      return {
        url: String(chosen.url),
        mime: rawMime.split(';')[0].trim() || 'audio/mp4',
      };
    }
    if (hlsManifestUrl) {
      return { url: hlsManifestUrl, mime: 'application/x-mpegURL' };
    }
    return null;
  }

  const desiredHeight = Number.parseInt(quality, 10) || 720;
  const progressiveMp4 = formats.filter((f) => {
    const mime = typeof f.mimeType === 'string' ? f.mimeType : '';
    return typeof f.url === 'string' && f.url.length > 0 && mime.includes('video/mp4');
  });

  if (progressiveMp4.length > 0) {
    const sorted = [...progressiveMp4].sort(
      (a, b) => Number(b.height ?? 0) - Number(a.height ?? 0)
    );
    const chosen =
      sorted.find((f) => Number(f.height ?? 0) === desiredHeight) ??
      sorted.find((f) => {
        const h = Number(f.height ?? 0);
        return h > 0 && h <= desiredHeight;
      }) ??
      sorted[sorted.length - 1];
    const rawMime = typeof chosen.mimeType === 'string' ? chosen.mimeType : 'video/mp4';
    return {
      url: String(chosen.url),
      mime: rawMime.split(';')[0].trim() || 'video/mp4',
    };
  }

  if (hlsManifestUrl) {
    return { url: hlsManifestUrl, mime: 'application/x-mpegURL' };
  }

  return null;
}

async function resolveNativeIosInnertubeStream(
  videoId: string,
  mode: MediaFormatMode,
  quality: string,
  preferLowestOverhead: boolean,
  signal?: AbortSignal
): Promise<ResolvedStreamCacheEntry | null> {
  if (!Capacitor.isNativePlatform()) {
    return null;
  }

  for (const profile of NATIVE_IOS_INNERTUBE_PROFILES) {
    if (signal?.aborted) {
      return null;
    }
    try {
      const resp = await CapacitorHttp.post({
        url: 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': profile.userAgent,
          'X-YouTube-Client-Name': profile.clientNameHeader,
          'X-YouTube-Client-Version': profile.clientVersion,
          Origin: 'https://www.youtube.com',
        },
        data: {
          videoId,
          context: {
            client: profile.clientPayload,
          },
          contentCheckOk: true,
          racyCheckOk: true,
        },
      });
      if (resp.status < 200 || resp.status >= 300 || !resp.data) {
        continue;
      }
      const parsed =
        typeof resp.data === 'string'
          ? (JSON.parse(resp.data) as Record<string, unknown>)
          : (resp.data as Record<string, unknown>);
      const playability = parsed.playabilityStatus as Record<string, unknown> | undefined;
      if (playability?.status && playability.status !== 'OK') {
        continue;
      }
      const streamingData = parsed.streamingData as Record<string, unknown> | undefined;
      if (!streamingData || typeof streamingData !== 'object') {
        continue;
      }
      const picked = pickNativeIosStreamingFormat(
        streamingData,
        mode,
        quality,
        preferLowestOverhead
      );
      if (picked) {
        return {
          url: picked.url,
          mime: picked.mime,
          expiresAt: computeStreamExpiry(picked.url),
        };
      }
    } catch {
      // Try next InnerTube client profile
    }
  }

  return null;
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
  defaultQuality,
  autoplayRelated,
  onToggleAutoplayRelated,
  onListenHistoryUpdated,
}: PlayerProviderProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const keepAliveAudioRef = useRef<HTMLAudioElement | null>(null);
  const youtubeBridgeRef = useRef<YouTubePlayerBridgeHandle | null>(null);
  const triedFallbackStageRef = useRef(0);
  const activeObjectUrlRef = useRef<string | null>(null);
  const synchronousPreloadedRef = useRef<{ trackId: string; src: string } | null>(null);
  const playedTrackIdsRef = useRef(new Set() as any);
  const fetchingRelatedRef = useRef(false);
  const rollingAutoplayInFlightRef = useRef(false);
  const lastRollingSeedIdRef = useRef<string | null>(null);
  const rollingEpochRef = useRef(0);
  const lastRecordedTrackIdRef = useRef<string | null>(null);
  const loadNonceRef = useRef(0);
  const resolvedStreamCacheRef = useRef(new Map() as any);
  const activeStreamCacheKeyRef = useRef<string | null>(null);
  const blockedYoutubeIdsRef = useRef(new Map() as any);
  const embedRecoveryInFlightRef = useRef(false);
  const stallRecoveryTimerRef = useRef<number | null>(null);
  const lastStallTimeRef = useRef(0);
  const backgroundHiddenAtRef = useRef(0);
  const shouldKeepPlayingInBackgroundRef = useRef(false);

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
  const [overrideStreamUrl, setOverrideStreamUrl] = useState<string | null>(null);
  const [youtubeFallbackId, setYoutubeFallbackId] = useState<string | null>(null);
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

  // Use native <audio> for Audio Mode & Live Radio (iOS keeps <audio> playing in background!), <video> for Video Mode
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

  const startBackgroundKeepAlive = useCallback(() => {
    const audio = keepAliveAudioRef.current;
    if (!audio) {
      return;
    }
    try {
      if (audio.src !== SILENT_KEEPALIVE_WAV_DATA_URI) {
        audio.src = SILENT_KEEPALIVE_WAV_DATA_URI;
      }
      audio.loop = true;
      audio.volume = 0.01;
      void audio.play().catch(() => {});
    } catch {
      // Ignore autoplay restriction errors
    }
  }, []);

  const stopBackgroundKeepAlive = useCallback(() => {
    const audio = keepAliveAudioRef.current;
    if (!audio) {
      return;
    }
    try {
      if (!audio.paused) {
        audio.pause();
      }
      audio.currentTime = 0;
    } catch {
      // Ignore cleanup errors
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
      stopBackgroundKeepAlive();
      revokeActiveObjectUrl();
    };
  }, [clearStallRecoveryTimer, stopBackgroundKeepAlive, revokeActiveObjectUrl]);

  useEffect(() => {
    if (!isExpanded || audioOnlyMode || !currentTrack) {
      setVideoFullscreen(false);
    }
    if (!isExpanded) {
      setQueueOpen(false);
    }
  }, [isExpanded, audioOnlyMode, currentTrack]);

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

  const resolveTrackStreamForPlayback = useCallback(
    async (
      targetUrl: string,
      trackId: string,
      requestMode: MediaFormatMode,
      quality: VideoQuality,
      signal?: AbortSignal,
      timeoutMs = RESOLVE_STREAM_TIMEOUT_MS
    ): Promise<{
      entry: ResolvedStreamCacheEntry | null;
      cacheKey: string;
      fallbackUrl?: string;
    }> => {
      const ytId = extractYouTubeVideoId(targetUrl, trackId);
      const trackKey = ytId || targetUrl;
      const cacheKey = buildStreamCacheKey(trackKey, requestMode, quality);

      const cacheMap = resolvedStreamCacheRef.current;
      const cached = cacheMap.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return { entry: cached, cacheKey };
      }
      if (cached) {
        cacheMap.delete(cacheKey);
      }

      const slowNetwork = isSlowNetworkConnection();

      // 1. Native iOS CapacitorHttp direct VISIONOS InnerTube resolution
      if (ytId && Capacitor.isNativePlatform()) {
        const nativeEntry = await resolveNativeIosInnertubeStream(
          ytId,
          requestMode,
          quality,
          slowNetwork,
          signal
        );
        if (nativeEntry && !signal?.aborted) {
          cacheMap.set(cacheKey, nativeEntry);
          return { entry: nativeEntry, cacheKey };
        }
      }

      if (signal?.aborted) {
        return { entry: null, cacheKey };
      }

      // 2. Backend /api/resolve-stream fallback
      const result = await resolveStream(backendUrl, targetUrl, requestMode, quality, {
        timeoutMs,
        signal,
      });

      if (result.resolved && result.directUrl) {
        const entry: ResolvedStreamCacheEntry = {
          url: result.directUrl,
          mime: requestMode === 'audio' ? 'audio/mp4' : 'video/mp4',
          expiresAt: computeStreamExpiry(result.directUrl),
        };
        cacheMap.set(cacheKey, entry);
        return { entry, cacheKey };
      }

      return { entry: null, cacheKey, fallbackUrl: result.fallbackUrl };
    },
    [backendUrl]
  );

  const getCachedStreamForTrack = useCallback(
    (track: PlayableTrack): { entry: ResolvedStreamCacheEntry; cacheKey: string } | null => {
      const targetUrl = track.sourceUrl || track.url || '';
      const ytId = extractYouTubeVideoId(targetUrl, track.id);
      if (!targetUrl && !ytId) {
        return null;
      }
      const trackKey = ytId || targetUrl;
      const slowNetwork = isSlowNetworkConnection();
      const preferredMode = getEffectiveRequestMode(
        track,
        audioOnlyModeRef.current,
        slowNetwork
      );
      const candidateKeys = [
        buildStreamCacheKey(trackKey, preferredMode, defaultQuality),
        ...(preferredMode === 'video'
          ? [buildStreamCacheKey(trackKey, 'audio', defaultQuality)]
          : []),
      ];

      const cacheMap = resolvedStreamCacheRef.current;
      const now = Date.now();
      for (const key of candidateKeys) {
        const cached = cacheMap.get(key);
        if (cached && cached.expiresAt > now) {
          return { entry: cached, cacheKey: key };
        }
        if (cached) {
          cacheMap.delete(key);
        }
      }
      return null;
    },
    [defaultQuality]
  );

  const startNativeMediaPlayback = useCallback(
    (mediaEl: HTMLMediaElement, src: string, rate: number) => {
      stopInactiveMediaEl(mediaEl);
      stopBackgroundKeepAlive();
      if (mediaEl.src !== src) {
        mediaEl.src = src;
      }
      mediaEl.playbackRate = rate;
      mediaEl.loop = false;
      shouldKeepPlayingInBackgroundRef.current = true;

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
    [stopBackgroundKeepAlive, stopInactiveMediaEl]
  );

  // Instant playback loader + Audio (<audio>) vs Video (<video>) routing
  useEffect(() => {
    const mediaEl = getActiveMediaEl(currentTrack);
    if (!mediaEl) {
      return;
    }

    loadNonceRef.current += 1;
    const activeToken = loadNonceRef.current;

    if (!currentTrack) {
      synchronousPreloadedRef.current = null;
      shouldKeepPlayingInBackgroundRef.current = false;
      stopBackgroundKeepAlive();
      [audioRef.current, videoRef.current].forEach((el) => {
        if (!el) return;
        el.pause();
        el.removeAttribute('src');
        el.load();
      });
      revokeActiveObjectUrl();
      setYoutubeFallbackId(null);
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

    if (youtubeFallbackId) {
      synchronousPreloadedRef.current = null;
      stopBackgroundKeepAlive();
      [audioRef.current, videoRef.current].forEach((el) => {
        if (!el) return;
        el.pause();
        el.removeAttribute('src');
        el.load();
      });
      return;
    }

    const preloaded = synchronousPreloadedRef.current;
    if (preloaded && preloaded.trackId === currentTrack.id && !overrideStreamUrl) {
      synchronousPreloadedRef.current = null;
      setPlayerError(null);
      setPipMessage(null);
      setCurrentTime(0);
      setDuration(currentTrack.duration > 0 ? currentTrack.duration : 0);
      syncMediaSessionMetadataNow(currentTrack, true, 0, currentTrack.duration, playbackRate);
      if (mediaEl.paused) {
        startNativeMediaPlayback(mediaEl, preloaded.src, playbackRate);
      }
      return;
    }
    synchronousPreloadedRef.current = null;

    setPlayerError(null);
    setPipMessage(null);
    setCurrentTime(0);
    setDuration(currentTrack.duration > 0 ? currentTrack.duration : 0);
    setIsBuffering(true);

    // 1. Offline Blob playback
    const offlineBlob = currentTrack.offlineBlob ?? currentTrack.blob;
    if (!overrideStreamUrl && (currentTrack.isOffline || offlineBlob) && offlineBlob) {
      revokeActiveObjectUrl();
      const freshUrl = URL.createObjectURL(offlineBlob);
      activeObjectUrlRef.current = freshUrl;
      startNativeMediaPlayback(mediaEl, freshUrl, playbackRate);
      return;
    }

    if (!currentTrack.isOffline) {
      revokeActiveObjectUrl();
    }

    // 2. Live radio or explicit directStreamUrl
    if (!overrideStreamUrl && (currentTrack.directStreamUrl || currentTrack.isLiveRadio)) {
      const radioUrl =
        currentTrack.directStreamUrl || currentTrack.streamUrl || currentTrack.sourceUrl || currentTrack.url || '';
      if (radioUrl) {
        startNativeMediaPlayback(mediaEl, radioUrl, playbackRate);
        return;
      }
    }

    // 3. Explicit override or already-resolved stream URL
    const preResolvedSrc = overrideStreamUrl || currentTrack.streamUrl;
    if (preResolvedSrc) {
      startNativeMediaPlayback(mediaEl, preResolvedSrc, playbackRate);
      return;
    }

    // 4. Unresolved stream URL: check cache first, then native iOS VISIONOS / backend
    const targetUrl = currentTrack.sourceUrl || currentTrack.url || '';
    const ytId = extractYouTubeVideoId(targetUrl, currentTrack.id);
    if (!targetUrl && !ytId) {
      stopBackgroundKeepAlive();
      setIsBuffering(false);
      setPlayerError('No playable stream URL found for this item.');
      return;
    }

    const slowNetwork = isSlowNetworkConnection();
    const requestMode = getEffectiveRequestMode(
      currentTrack,
      audioOnlyModeRef.current,
      slowNetwork
    );
    const cachedHit = getCachedStreamForTrack(currentTrack);
    if (cachedHit) {
      activeStreamCacheKeyRef.current = cachedHit.cacheKey;
      setYoutubeFallbackId(null);
      startNativeMediaPlayback(mediaEl, cachedHit.entry.url, playbackRate);
      return;
    }

    const trackKey = ytId || targetUrl;
    const cacheKey = buildStreamCacheKey(trackKey, requestMode, defaultQuality);
    activeStreamCacheKeyRef.current = cacheKey;
    const controller = new AbortController();
    void resolveTrackStreamForPlayback(
      targetUrl,
      currentTrack.id,
      requestMode,
      defaultQuality,
      controller.signal,
      RESOLVE_STREAM_TIMEOUT_MS
    ).then((resolved) => {
      if (loadNonceRef.current !== activeToken || controller.signal.aborted) {
        return;
      }
      if (resolved.entry) {
        activeStreamCacheKeyRef.current = resolved.cacheKey;
        setYoutubeFallbackId(null);
        setOverrideStreamUrl(resolved.entry.url);
        return;
      }
      if (ytId) {
        stopBackgroundKeepAlive();
        triedFallbackStageRef.current = 2;
        setYoutubeFallbackId(ytId);
        return;
      }
      if (resolved.fallbackUrl) {
        setOverrideStreamUrl(resolved.fallbackUrl);
      } else {
        stopBackgroundKeepAlive();
        setIsBuffering(false);
        setPlayerError('Could not load this stream.');
      }
    });

    return () => {
      controller.abort();
    };
  }, [
    currentTrack?.id,
    overrideStreamUrl,
    playNonce,
    youtubeFallbackId,
    backendUrl,
    defaultQuality,
    getActiveMediaEl,
    revokeActiveObjectUrl,
    startNativeMediaPlayback,
    stopBackgroundKeepAlive,
    getCachedStreamForTrack,
    syncMediaSessionMetadataNow,
    resolveTrackStreamForPlayback,
    onListenHistoryUpdated,
  ]);

  // Silent background pre-resolution for the NEXT track
  useEffect(() => {
    if (currentIndex < 0 || queue.length === 0) {
      return;
    }

    let nextTrack: PlayableTrack | null = null;
    if (loopMode === 'all' && currentTrack && !isAutoplayTrack(currentTrack)) {
      const lastManualIdx = queue.reduce(
        (last, item, idx) => (!isAutoplayTrack(item) ? idx : last),
        -1
      );
      if (currentIndex === lastManualIdx && lastManualIdx > 0) {
        nextTrack = queue[0] ?? null;
      }
    }
    if (!nextTrack && currentIndex + 1 < queue.length) {
      nextTrack = queue[currentIndex + 1] ?? null;
    }

    if (
      !nextTrack ||
      nextTrack.isOffline ||
      nextTrack.offlineBlob ||
      nextTrack.blob ||
      nextTrack.isLiveRadio ||
      nextTrack.directStreamUrl ||
      nextTrack.streamUrl
    ) {
      return;
    }

    const targetUrl = nextTrack.sourceUrl || nextTrack.url || '';
    const ytId = extractYouTubeVideoId(targetUrl, nextTrack.id);
    if (!targetUrl && !ytId) {
      return;
    }

    const slowNetwork = isSlowNetworkConnection();
    const nextMode = getEffectiveRequestMode(nextTrack, audioOnlyMode, slowNetwork);
    const trackKey = ytId || targetUrl;
    const cacheKey = buildStreamCacheKey(trackKey, nextMode, defaultQuality);
    const existing = resolvedStreamCacheRef.current.get(cacheKey);
    if (existing && existing.expiresAt > Date.now()) {
      return;
    }

    const controller = new AbortController();
    void resolveTrackStreamForPlayback(
      targetUrl,
      nextTrack.id,
      nextMode,
      defaultQuality,
      controller.signal,
      4500
    ).catch(() => {});

    return () => {
      controller.abort();
    };
  }, [
    currentIndex,
    currentTrack,
    loopMode,
    queue,
    audioOnlyMode,
    defaultQuality,
    resolveTrackStreamForPlayback,
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
    shouldKeepPlayingInBackgroundRef.current = false;
    if (youtubeFallbackId) {
      youtubeBridgeRef.current?.pause();
    } else {
      getActiveMediaEl()?.pause();
    }
    setIsPlaying(false);
  }, [getActiveMediaEl, youtubeFallbackId]);

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
    triedFallbackStageRef.current = 0;
    embedRecoveryInFlightRef.current = false;
    activeStreamCacheKeyRef.current = null;
    setOverrideStreamUrl(null);
    setYoutubeFallbackId(null);
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
        shouldKeepPlayingInBackgroundRef.current = false;
        stopBackgroundKeepAlive();
        setQueue([]);
        setCurrentIndex(-1);
        setExpanded(false);
        setQueueOpen(false);
        setVideoFullscreen(false);
        setYoutubeFallbackId(null);
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
    [playbackRate, resetTrackLoadState, stopBackgroundKeepAlive, syncMediaSessionMetadataNow]
  );

  const clearQueue = useCallback(() => {
    rollingEpochRef.current += 1;
    rollingAutoplayInFlightRef.current = false;
    lastRollingSeedIdRef.current = null;
    shouldKeepPlayingInBackgroundRef.current = false;
    stopBackgroundKeepAlive();
    setQueue([]);
    setCurrentIndex(-1);
    resetTrackLoadState();
    setVideoFullscreen(false);
    setQueueOpen(false);
    setExpanded(false);
    syncMediaSessionMetadataNow(null, false);
  }, [resetTrackLoadState, stopBackgroundKeepAlive, syncMediaSessionMetadataNow]);

  const stopAndClearCurrent = useCallback(() => {
    shouldKeepPlayingInBackgroundRef.current = false;
    audioRef.current?.pause();
    videoRef.current?.pause();
    stopBackgroundKeepAlive();
    youtubeBridgeRef.current?.pause();
    setCurrentIndex(-1);
    resetTrackLoadState();
    setVideoFullscreen(false);
    setQueueOpen(false);
    setExpanded(false);
    syncMediaSessionMetadataNow(null, false);
  }, [resetTrackLoadState, stopBackgroundKeepAlive, syncMediaSessionMetadataNow]);

  const togglePlayPause = useCallback(async () => {
    if (!currentTrack) {
      return;
    }
    if (youtubeFallbackId) {
      if (isPlaying) {
        shouldKeepPlayingInBackgroundRef.current = false;
        youtubeBridgeRef.current?.pause();
        setIsPlaying(false);
      } else {
        shouldKeepPlayingInBackgroundRef.current = true;
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
      shouldKeepPlayingInBackgroundRef.current = true;
      try {
        await mediaEl.play();
      } catch (err) {
        setPlayerError(
          err instanceof Error ? err.message : 'Unable to start playback.'
        );
      }
    } else {
      shouldKeepPlayingInBackgroundRef.current = false;
      mediaEl.pause();
    }
  }, [currentTrack, eqEnabled, eqGains, getActiveMediaEl, isPlaying, youtubeFallbackId]);

  const seekTo = useCallback(
    (seconds: number) => {
      if (youtubeFallbackId) {
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
    [duration, getActiveMediaEl, youtubeFallbackId]
  );

  const skipBy = useCallback(
    (deltaSeconds: number) => {
      if (youtubeFallbackId) {
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
    [currentTime, getActiveMediaEl, seekTo, youtubeFallbackId]
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
          if (youtubeFallbackId) {
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
        if (youtubeFallbackId) {
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
    youtubeFallbackId,
  ]);

  const playPrevious = useCallback(() => {
    const prevQueue = queueRef.current;
    const activeIdx = currentIndexRef.current;
    const mediaEl = getActiveMediaEl();
    const activeTime =
      !youtubeFallbackId && mediaEl && Number.isFinite(mediaEl.currentTime)
        ? mediaEl.currentTime
        : currentTime;
    const action = getPreviousTrackAction(activeIdx, activeTime, prevQueue.length);
    if (action.action === 'restart') {
      seekTo(0);
      if (youtubeFallbackId) {
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
    youtubeFallbackId,
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

    if (currentTrack && !currentTrack.isOffline && !currentTrack.isLiveRadio) {
      resetTrackLoadState();
      setQueue((prev) =>
        prev.map((item, idx) =>
          idx === currentIndex
            ? {
                ...item,
                mode: nextAudioOnly ? 'audio' : 'video',
                streamUrl: '',
              }
            : item
        )
      );
      setPlayNonce((n) => n + 1);
    }
  }, [currentIndex, currentTrack, resetTrackLoadState]);

  const toggleAutoplayRelated = useCallback(() => {
    onToggleAutoplayRelated?.();
  }, [onToggleAutoplayRelated]);

  const togglePictureInPicture = useCallback(async () => {
    if (youtubeFallbackId) {
      setPipMessage('Picture-in-Picture requires a direct stream.');
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
  }, [currentTrack, youtubeFallbackId]);

  const clearPlayerError = useCallback(() => setPlayerError(null), []);

  const initEqualizer = useCallback(() => {
    setEqEnabled(true);
    resumeEqualizerContext(getActiveMediaEl() as HTMLVideoElement | null, eqGains);
  }, [eqGains, getActiveMediaEl]);

  const setEqBandGain = useCallback((bandIndex: number, gainDb: number) => {
    setEqEnabled(true);
    const clamped = clampEqGain(gainDb);
    setEqGains((prev) => {
      const next: EqGains = [...prev] as EqGains;
      next[bandIndex] = clamped;
      applyEqualizerGains(getActiveMediaEl() as HTMLVideoElement | null, next);
      return next;
    });
  }, [getActiveMediaEl]);

  const applyEqPreset = useCallback((presetName: EqPresetName) => {
    setEqEnabled(true);
    const preset: EqGains = [...EQ_PRESETS[presetName]] as EqGains;
    setEqGains(preset);
    applyEqualizerGains(getActiveMediaEl() as HTMLVideoElement | null, preset);
  }, [getActiveMediaEl]);

  const playNextRef = useRef(playNext);
  playNextRef.current = playNext;
  const playPreviousRef = useRef(playPrevious);
  playPreviousRef.current = playPrevious;

  // MediaSession integration for iOS Lock Screen & Dynamic Island
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
      shouldKeepPlayingInBackgroundRef.current = true;
      if (youtubeFallbackId) {
        youtubeBridgeRef.current?.play();
      } else {
        void getActiveMediaEl()?.play().catch(() => {});
      }
    });
    setSafeHandler('pause', () => {
      shouldKeepPlayingInBackgroundRef.current = false;
      if (youtubeFallbackId) {
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
    youtubeFallbackId,
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

  // Keep background playback alive on iOS when screen locks or app enters background
  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        backgroundHiddenAtRef.current = Date.now();
        // If playing video mode on iOS, WebKit may auto-pause <video>; nudge it back to playing
        const mediaEl = getActiveMediaEl();
        if (
          shouldKeepPlayingInBackgroundRef.current &&
          !youtubeFallbackId &&
          mediaEl &&
          mediaEl.paused &&
          !mediaEl.ended
        ) {
          window.setTimeout(() => {
            if (shouldKeepPlayingInBackgroundRef.current && mediaEl.paused && !mediaEl.ended) {
              void mediaEl.play().catch(() => {});
            }
          }, 200);
        }
      }

      if (
        typeof navigator === 'undefined' ||
        !('mediaSession' in navigator) ||
        !currentTrack
      ) {
        return;
      }
      navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
      if (
        typeof navigator.mediaSession.setPositionState === 'function' &&
        Number.isFinite(duration) &&
        duration > 0
      ) {
        const mediaEl = getActiveMediaEl();
        const livePos =
          !youtubeFallbackId && mediaEl && Number.isFinite(mediaEl.currentTime)
            ? mediaEl.currentTime
            : currentTime;
        try {
          navigator.mediaSession.setPositionState({
            duration,
            playbackRate,
            position: Math.min(duration, Math.max(0, livePos)),
          });
        } catch {
          // Ignore transient invalid state
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [currentTrack, getActiveMediaEl, isPlaying, duration, currentTime, playbackRate, youtubeFallbackId]);

  const scheduleStallRecovery = useCallback(() => {
    if (stallRecoveryTimerRef.current !== null || youtubeFallbackId) {
      return;
    }
    stallRecoveryTimerRef.current = window.setTimeout(() => {
      stallRecoveryTimerRef.current = null;
      const mediaEl = getActiveMediaEl();
      if (!mediaEl || mediaEl.paused || mediaEl.ended || youtubeFallbackId) {
        return;
      }

      if (
        isSlowNetworkConnection() &&
        !audioOnlyModeRef.current &&
        currentTrack &&
        !currentTrack.isOffline &&
        !currentTrack.isLiveRadio
      ) {
        audioOnlyModeRef.current = true;
        setAudioOnlyMode(true);
        setOverrideStreamUrl(null);
        setPlayNonce((n) => n + 1);
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
  }, [currentTrack, getActiveMediaEl, youtubeFallbackId]);

  const handlePlay = () => {
    clearStallRecoveryTimer();
    stopBackgroundKeepAlive();
    shouldKeepPlayingInBackgroundRef.current = true;
    setIsPlaying(true);
    setIsBuffering(false);
    setPlayerError(null);
  };

  const handlePause = (e: React.SyntheticEvent<HTMLMediaElement>) => {
    const el = e.currentTarget;
    // If iOS WebKit auto-paused a <video> right as the app backgrounded, resume it once
    if (
      el === videoRef.current &&
      document.visibilityState === 'hidden' &&
      shouldKeepPlayingInBackgroundRef.current &&
      Date.now() - backgroundHiddenAtRef.current < 1500
    ) {
      window.setTimeout(() => {
        if (shouldKeepPlayingInBackgroundRef.current && el.paused && !el.ended) {
          void el.play().catch(() => {});
        }
      }, 200);
      return;
    }
    clearStallRecoveryTimer();
    setIsPlaying(false);
  };

  const handleTimeUpdate = (e: React.SyntheticEvent<HTMLMediaElement>) => {
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

  const tryStartTrackSynchronouslyOnMedia = useCallback(
    (nextTrack: PlayableTrack): boolean => {
      const mediaEl = getActiveMediaEl(nextTrack);
      if (!mediaEl || youtubeFallbackId) {
        return false;
      }

      const offlineBlob = nextTrack.offlineBlob ?? nextTrack.blob;
      if ((nextTrack.isOffline || offlineBlob) && offlineBlob) {
        revokeActiveObjectUrl();
        const freshUrl = URL.createObjectURL(offlineBlob);
        activeObjectUrlRef.current = freshUrl;
        synchronousPreloadedRef.current = { trackId: nextTrack.id, src: freshUrl };
        activeStreamCacheKeyRef.current = null;
        stopInactiveMediaEl(mediaEl);
        stopBackgroundKeepAlive();
        mediaEl.src = freshUrl;
        mediaEl.playbackRate = playbackRate;
        mediaEl.loop = false;
        void mediaEl.play().catch(() => {});
        syncMediaSessionMetadataNow(nextTrack, true, 0, nextTrack.duration, playbackRate);
        return true;
      }

      let syncUrl: string | null = null;
      let syncCacheKey: string | null = null;
      if (nextTrack.directStreamUrl || nextTrack.isLiveRadio) {
        syncUrl =
          nextTrack.directStreamUrl ||
          nextTrack.streamUrl ||
          nextTrack.sourceUrl ||
          nextTrack.url ||
          null;
      } else if (nextTrack.streamUrl) {
        syncUrl = nextTrack.streamUrl;
      } else {
        const cachedHit = getCachedStreamForTrack(nextTrack);
        if (cachedHit) {
          syncUrl = cachedHit.entry.url;
          syncCacheKey = cachedHit.cacheKey;
        }
      }

      if (!syncUrl) {
        return false;
      }

      if (!nextTrack.isOffline) {
        revokeActiveObjectUrl();
      }
      synchronousPreloadedRef.current = { trackId: nextTrack.id, src: syncUrl };
      activeStreamCacheKeyRef.current = syncCacheKey;
      stopInactiveMediaEl(mediaEl);
      stopBackgroundKeepAlive();
      mediaEl.src = syncUrl;
      mediaEl.playbackRate = playbackRate;
      mediaEl.loop = false;
      void mediaEl.play().catch(() => {});
      syncMediaSessionMetadataNow(nextTrack, true, 0, nextTrack.duration, playbackRate);
      return true;
    },
    [
      getActiveMediaEl,
      getCachedStreamForTrack,
      playbackRate,
      revokeActiveObjectUrl,
      stopBackgroundKeepAlive,
      stopInactiveMediaEl,
      syncMediaSessionMetadataNow,
      youtubeFallbackId,
    ]
  );

  const handleEnded = useCallback(async () => {
    if (sleepTimerOption === 'end') {
      shouldKeepPlayingInBackgroundRef.current = false;
      stopBackgroundKeepAlive();
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
      if (youtubeFallbackId) {
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
          if (youtubeFallbackId) {
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
        const startedSync = tryStartTrackSynchronouslyOnMedia(wrappedTrack);
        if (!startedSync && !youtubeFallbackId) {
          startBackgroundKeepAlive();
        }
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
        if (youtubeFallbackId) {
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

      const startedSync = tryStartTrackSynchronouslyOnMedia(targetTrack);
      if (!startedSync && !youtubeFallbackId) {
        startBackgroundKeepAlive();
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
      if (!youtubeFallbackId) {
        startBackgroundKeepAlive();
      }
      const started = await fetchAndPlayRelatedNext();
      if (started) {
        return;
      }
      stopBackgroundKeepAlive();
    }

    shouldKeepPlayingInBackgroundRef.current = false;
    setIsPlaying(false);
  }, [
    loopMode,
    sleepTimerOption,
    autoplayRelated,
    currentTrack,
    getActiveMediaEl,
    playbackRate,
    youtubeFallbackId,
    resetTrackLoadState,
    fetchAndPlayRelatedNext,
    tryStartTrackSynchronouslyOnMedia,
    startBackgroundKeepAlive,
    stopBackgroundKeepAlive,
    syncMediaSessionMetadataNow,
  ]);

  const handleMediaError = useCallback(() => {
    clearStallRecoveryTimer();
    stopBackgroundKeepAlive();
    if (activeStreamCacheKeyRef.current) {
      resolvedStreamCacheRef.current.delete(activeStreamCacheKeyRef.current);
      activeStreamCacheKeyRef.current = null;
    }
    if (!currentTrack) {
      return;
    }
    const targetUrl = currentTrack.sourceUrl || currentTrack.url || '';
    const ytId = extractYouTubeVideoId(targetUrl, currentTrack.id);
    if (triedFallbackStageRef.current < 2 && ytId) {
      triedFallbackStageRef.current = 2;
      setPlayerError(null);
      setIsBuffering(true);
      setYoutubeFallbackId(ytId);
      return;
    }

    const currentSrc = overrideStreamUrl || currentTrack.streamUrl;
    if (
      triedFallbackStageRef.current < 1 &&
      currentTrack.fallbackStreamUrl &&
      currentTrack.fallbackStreamUrl !== currentSrc
    ) {
      triedFallbackStageRef.current = 1;
      setOverrideStreamUrl(currentTrack.fallbackStreamUrl);
      return;
    }

    setIsPlaying(false);
    setIsBuffering(false);
    setPlayerError('Could not load this stream. Check server URL in Settings.');
  }, [clearStallRecoveryTimer, stopBackgroundKeepAlive, currentTrack, overrideStreamUrl]);

  const handleYouTubeEmbedBlocked = useCallback(async () => {
    if (!currentTrack || !youtubeFallbackId || embedRecoveryInFlightRef.current) {
      return;
    }

    const trackId = currentTrack.id;
    const blockedMap = blockedYoutubeIdsRef.current;
    let blockedSet = blockedMap.get(trackId);
    if (!blockedSet) {
      blockedSet = new Set<string>();
      blockedMap.set(trackId, blockedSet);
    }
    blockedSet.add(youtubeFallbackId);

    if (blockedSet.size >= 2) {
      setIsPlaying(false);
      setIsBuffering(false);
      setPlayerError('Stream unavailable on this source.');
      return;
    }

    embedRecoveryInFlightRef.current = true;
    const tokenSnapshot = loadNonceRef.current;
    setPlayerError(null);
    setIsBuffering(true);

    try {
      const base = normalizeBackendUrl(backendUrl) || DEFAULT_BACKEND_URL;
      const altQuery = `${currentTrack.title} ${currentTrack.uploader} lyrics audio`.trim();
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
        setYoutubeFallbackId(alternateVideoId);
        return;
      }

      setIsPlaying(false);
      setIsBuffering(false);
      setPlayerError('Stream unavailable on this source.');
    } catch {
      if (loadNonceRef.current === tokenSnapshot) {
        setIsPlaying(false);
        setIsBuffering(false);
        setPlayerError('Stream unavailable on this source.');
      }
    } finally {
      embedRecoveryInFlightRef.current = false;
    }
  }, [backendUrl, currentTrack, youtubeFallbackId]);

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
    isUsingYouTubeFallback: Boolean(youtubeFallbackId),
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

  const showVideoStage =
    isExpanded &&
    currentTrack &&
    !audioOnlyMode &&
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
              {!youtubeFallbackId && (
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

          {youtubeFallbackId ? (
            <YouTubePlayerBridge
              ref={youtubeBridgeRef}
              videoId={youtubeFallbackId}
              playbackRate={playbackRate}
              loop={loopMode === 'one' && sleepTimerOption !== 'end'}
              preferredQuality={audioOnlyMode ? 'small' : 'default'}
              onPlay={() => {
                stopBackgroundKeepAlive();
                shouldKeepPlayingInBackgroundRef.current = true;
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
                stopBackgroundKeepAlive();
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
                stopBackgroundKeepAlive();
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

      {/* Dedicated native <audio> element for Audio Mode & Radio (keeps iOS background audio active when locked) */}
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
          stopBackgroundKeepAlive();
          setIsBuffering(false);
          setIsPlaying(true);
        }}
        onEnded={() => {
          clearStallRecoveryTimer();
          void handleEnded();
        }}
        onError={handleMediaError}
      />

      {/* Hidden silent keep-alive audio element for async track transitions */}
      <audio
        ref={keepAliveAudioRef}
        loop
        playsInline
        preload="auto"
        aria-hidden="true"
        className="hidden"
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
