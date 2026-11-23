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
import { resolveYouTubeStream, downloadTrack as downloadTrackUtil } from '../utils/youtubeBypass';

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

const NATIVE_AUDIO_ASSET_ID = 'jtunes-active-track';
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

  // 1. TRY THE BYPASS API FIRST (Most reliable for external players)
  try {
    const bypassResult = await resolveYouTubeStream(videoId);
    if (bypassResult) {
      return {
        url: bypassResult.url,
        mime: bypassResult.mime,
        expiresAt: Date.now() + (24 * 60 * 60 * 1000) // Cache for 24 hours since it's a direct link
      };
    }
  } catch (e) {
    console.log("Bypass API failed, trying InnerTube profiles...");
  }

  // 2. FALLBACK TO INNER TUBE PROFILES (Your original logic)
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
  downloadTrack: (track: PlayableTrack) => Promise<void>;
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
  // Track which trackId the current overrideStreamUrl belongs to, so stale overrides
  // from a previous track are never applied to the newly-loaded track.
  const overrideStreamTrackIdRef = useRef<string | null>(null);
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
  const isNativeAudioActiveRef = useRef(false);
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

  const [isExpanded, setExpandedState] = useState(false);
  const [isQueueOpen, setQueueOpenState] = useState(false);
  const [isVideoFullscreen, setVideoFullscreenState] = useState(false);
  const [isLyricsViewOpen, setLyricsViewOpenState] = useState(false);
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
    const wasActive = isNativeAudioActiveRef.current;
    isNativeAudioActiveRef.current = false;
    if (!Capacitor.isNativePlatform() || !wasActive) {
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
          if (isNativeAudioActiveRef.current && typeof res.isPlaying === 'boolean') {
            setIsPlaying(res.isPlaying);
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
      setVideoFullscreenState(false);
    }
    if (!isExpanded) {
      setQueueOpenState(false);
    }
  }, [isExpanded, audioOnlyMode, currentTrack]);

  useEffect(() => {
    if (!isVideoFullscreen) {
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setVideoFullscreenState(false);
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

      // 1. Native iOS CapacitorHttp direct InnerTube resolution (now includes bypass)
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

  const startHtmlMediaPlayback = useCallback(
    (mediaEl: HTMLMediaElement, src: string, rate: number) => {
      void stopNativeAudio();
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
    [stopBackgroundKeepAlive, stopInactiveMediaEl, stopNativeAudio]
  );

  // Route remote Audio Mode / Live Radio streams through native iOS AVPlayer (@capgo/capacitor-native-audio)
  // so playback continues uninterrupted on Lock Screen and outside WKWebView.
  const startNativeMediaPlayback = useCallback(
    (
      mediaEl: HTMLMediaElement,
      src: string,
      rate: number,
      track?: PlayableTrack | null,
      activeToken?: number
    ) => {
      const targetTrack = track ?? currentTrack;
      const shouldUseNativeAvPlayer =
        Capacitor.isNativePlatform() &&
        Boolean(targetTrack) &&
        useAudioElementForTrack(targetTrack) &&
        /^https?:\/\//i.test(src);

      if (!shouldUseNativeAvPlayer || !targetTrack) {
        startHtmlMediaPlayback(mediaEl, src, rate);
        return;
      }

      stopAllHtmlMediaEls();
      stopBackgroundKeepAlive();
      shouldKeepPlayingInBackgroundRef.current = true;
      setIsBuffering(true);

      void (async () => {
        try {
          await stopNativeAudio();
          if (typeof activeToken === 'number' && loadNonceRef.current !== activeToken) {
            return;
          }

          await NativeAudio.preload({
            assetId: NATIVE_AUDIO_ASSET_ID,
            assetPath: src,
            isUrl: true,
            notificationMetadata: {
              title: targetTrack.title || 'Jtunes',
              artist: targetTrack.uploader || 'Jtunes',
              album: 'Jtunes',
              artworkUrl: targetTrack.thumbnail || undefined,
            },
          } as any);

          if (typeof activeToken === 'number' && loadNonceRef.current !== activeToken) {
            await NativeAudio.unload({ assetId: NATIVE_AUDIO_ASSET_ID }).catch(() => {});
            return;
          }

          isNativeAudioActiveRef.current = true;
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
          if (typeof activeToken === 'number' && loadNonceRef.current !== activeToken) {
            return;
          }
          // Graceful fallback to HTML <audio> if native AVPlayer rejects a specific stream URL
          isNativeAudioActiveRef.current = false;
          startHtmlMediaPlayback(mediaEl, src, rate);
        }
      })();
    },
    [
      currentTrack,
      startHtmlMediaPlayback,
      startNativeAudioPoll,
      stopAllHtmlMediaEls,
      stopBackgroundKeepAlive,
      stopNativeAudio,
      useAudioElementForTrack,
    ]
  );

  // Clear the override stream URL whenever the active track changes so a stale
  // URL from the previous track is never sent to the new track's playback effect.
  useEffect(() => {
    setOverrideStreamUrl(null);
    overrideStreamTrackIdRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrack?.id, playNonce]);

  // Instant playback loader + Native AVPlayer / HTML <audio> / <video> routing
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
      void stopNativeAudio();
      stopBackgroundKeepAlive();
      stopAllHtmlMediaEls();
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
      void stopNativeAudio();
      stopBackgroundKeepAlive();
      stopAllHtmlMediaEls();
      return;
    }

    // Guard: if overrideStreamUrl was set for a different track, ignore it and
    // let the resolution path below fetch a fresh URL for the current track.
    const isOverrideForCurrentTrack =
      overrideStreamUrl !== null &&
      overrideStreamTrackIdRef.current === currentTrack.id;
    const effectiveOverrideUrl = isOverrideForCurrentTrack ? overrideStreamUrl : null;

    const preloaded = synchronousPreloadedRef.current;
    if (preloaded && preloaded.trackId === currentTrack.id && !effectiveOverrideUrl) {
      synchronousPreloadedRef.current = null;
      setPlayerError(null);
      setPipMessage(null);
      setCurrentTime(0);
      setDuration(currentTrack.duration > 0 ? currentTrack.duration : 0);
      syncMediaSessionMetadataNow(currentTrack, true, 0, currentTrack.duration, playbackRate);
      if (mediaEl.paused) {
        startNativeMediaPlayback(mediaEl, preloaded.src, playbackRate, currentTrack, activeToken);
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
    if (!effectiveOverrideUrl && (currentTrack.isOffline || offlineBlob) && offlineBlob) {
      revokeActiveObjectUrl();
      const freshUrl = URL.createObjectURL(offlineBlob);
      activeObjectUrlRef.current = freshUrl;
      startNativeMediaPlayback(mediaEl, freshUrl, playbackRate, currentTrack, activeToken);
      return;
    }

    if (!currentTrack.isOffline) {
      revokeActiveObjectUrl();
    }

    // 2. Live radio or explicit directStreamUrl
    if (!effectiveOverrideUrl && (currentTrack.directStreamUrl || currentTrack.isLiveRadio)) {
      const radioUrl =
        currentTrack.directStreamUrl ||
        currentTrack.streamUrl ||
        currentTrack.sourceUrl ||
        currentTrack.url ||
        '';
      if (radioUrl) {
        startNativeMediaPlayback(mediaEl, radioUrl, playbackRate, currentTrack, activeToken);
        return;
      }
    }

    // 3. Explicit override or already-resolved stream URL
    const preResolvedSrc = effectiveOverrideUrl || currentTrack.streamUrl;
    if (preResolvedSrc) {
      startNativeMediaPlayback(mediaEl, preResolvedSrc, playbackRate, currentTrack, activeToken);
      return;
    }

    // 4. Unresolved stream URL: check cache first, then native iOS / backend
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
      startNativeMediaPlayback(mediaEl, cachedHit.entry.url, playbackRate, currentTrack, activeToken);
      return;
    }

    const trackKey = ytId || targetUrl;
    const cacheKey = buildStreamCacheKey(trackKey, requestMode, defaultQuality);
    activeStreamCacheKeyRef.current = cacheKey;
    // Capture the track ID so we can validate the override when the effect re-runs
    const resolveForTrackId = currentTrack.id;
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
        // Tag this override with the track it belongs to before committing
        overrideStreamTrackIdRef.current = resolveForTrackId;
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
        overrideStreamTrackIdRef.current = resolveForTrackId;
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
    stopAllHtmlMediaEls,
    stopBackgroundKeepAlive,
    stopNativeAudio,
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
    if (loopMode === 'all' && currentTrack && !isAutoplayTrack(queue[currentIndex])) {
      nextTrack = queue[currentIndex];
    } else {
      const nextIdx = getNextTrackIndex(queue, currentIndex, loopMode);
      if (nextIdx >= 0 && nextIdx < queue.length) {
        nextTrack = queue[nextIdx];
      }
    }

    if (!nextTrack) return;

    const targetUrl = nextTrack.sourceUrl || nextTrack.url || '';
    const ytId = extractYouTubeVideoId(targetUrl, nextTrack.id);
    if (!targetUrl && !ytId) return;

    const slowNetwork = isSlowNetworkConnection();
    const requestMode = getEffectiveRequestMode(nextTrack, audioOnlyModeRef.current, slowNetwork);
    const cacheKey = buildStreamCacheKey(ytId || targetUrl, requestMode, defaultQuality);
    const cacheMap = resolvedStreamCacheRef.current;
    const cached = cacheMap.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return;

    void resolveTrackStreamForPlayback(
      targetUrl,
      nextTrack.id,
      requestMode,
      defaultQuality
    ).then((resolved) => {
      if (resolved.entry) {
        cacheMap.set(cacheKey, resolved.entry);
      }
    });
  }, [currentIndex, loopMode, queue, defaultQuality]);

  const playTrack = useCallback(
    (track: PlayableTrack) => {
      const existingIndex = queue.findIndex((t) => t.id === track.id);
      if (existingIndex >= 0) {
        setCurrentIndex(existingIndex);
        setPlayNonce((n) => n + 1);
        return;
      }
      const newQueue = [...queue, track];
      setQueue(newQueue);
      setCurrentIndex(newQueue.length - 1);
      setPlayNonce((n) => n + 1);
    },
    [queue]
  );

  const playQueue = useCallback(
    (tracks: PlayableTrack[], startIndex = 0) => {
      const normalized = tracks.map((t) => ({
        ...t,
        queueOrigin: t.queueOrigin || 'manual',
      }));
      setQueue(normalized);
      setCurrentIndex(Math.max(0, Math.min(startIndex, normalized.length - 1)));
      setPlayNonce((n) => n + 1);
    },
    []
  );

  const jumpToQueueIndex = useCallback(
    (index: number) => {
      if (index >= 0 && index < queue.length) {
        setCurrentIndex(index);
        setPlayNonce((n) => n + 1);
      }
    },
    [queue.length]
  );

  const playNextInQueue = useCallback(
    (track: PlayableTrack) => {
      const newQueue = insertPlayNextInQueue(queue, track);
      setQueue(newQueue);
      const nextIndex = queue.length;
      if (nextIndex < newQueue.length) {
        setCurrentIndex(nextIndex);
        setPlayNonce((n) => n + 1);
      }
    },
    [queue]
  );

  const addToQueue = useCallback(
    (track: PlayableTrack) => {
      const newQueue = [...queue, track];
      setQueue(newQueue);
    },
    [queue]
  );

  const reorderQueueItem = useCallback(
    (fromIndex: number, toIndex: number) => {
      const newQueue = [...queue];
      const [moved] = newQueue.splice(fromIndex, 1);
      newQueue.splice(toIndex, 0, moved);
      setQueue(newQueue);
      if (currentIndex === fromIndex) {
        setCurrentIndex(toIndex);
      } else if (currentIndex < fromIndex && currentIndex >= toIndex) {
        setCurrentIndex(currentIndex + 1);
      } else if (currentIndex > fromIndex && currentIndex <= toIndex) {
        setCurrentIndex(currentIndex - 1);
      }
    },
    [queue, currentIndex]
  );

  const moveQueueTrack = useCallback(
    (fromIndex: number, toIndex: number) => {
      moveQueueItem(queue, fromIndex, toIndex).then((newQueue) => {
        setQueue(newQueue);
      });
    },
    [queue]
  );

  const removeFromQueue = useCallback(
    (index: number) => {
      if (index < 0 || index >= queue.length) return;
      const newQueue = queue.filter((_, i) => i !== index);
      setQueue(newQueue);
      if (index === currentIndex) {
        if (newQueue.length === 0) {
          setCurrentIndex(-1);
        } else {
          const newIndex = Math.min(index, newQueue.length - 1);
          setCurrentIndex(newIndex);
          setPlayNonce((n) => n + 1);
        }
      } else if (index < currentIndex) {
        setCurrentIndex(currentIndex - 1);
      }
    },
    [queue, currentIndex]
  );

  const clearQueue = useCallback(() => {
    setQueue([]);
    setCurrentIndex(-1);
    setPlayNonce((n) => n + 1);
  }, []);

  const togglePlayPause = useCallback(async () => {
    // 1. If the YouTube iframe bridge is active, delegate to it.
    if (youtubeBridgeRef.current && youtubeFallbackId) {
      if (isPlaying) {
        youtubeBridgeRef.current.pause();
        setIsPlaying(false);
      } else {
        youtubeBridgeRef.current.play();
        setIsPlaying(true);
      }
      return;
    }

    // 2. If the native AVPlayer is active, use NativeAudio APIs.
    if (isNativeAudioActiveRef.current && Capacitor.isNativePlatform()) {
      try {
        if (isPlaying) {
          await NativeAudio.pause({ assetId: NATIVE_AUDIO_ASSET_ID });
          setIsPlaying(false);
        } else {
          await NativeAudio.resume({ assetId: NATIVE_AUDIO_ASSET_ID });
          setIsPlaying(true);
        }
      } catch {
        // If native audio APIs fail, fall through to HTML element
        const mediaEl = getActiveMediaEl();
        if (!mediaEl) return;
        if (mediaEl.paused) {
          try { await mediaEl.play(); setIsPlaying(true); } catch { setIsBuffering(false); }
        } else {
          mediaEl.pause(); setIsPlaying(false);
        }
      }
      return;
    }

    // 3. Standard HTML <audio> / <video> element.
    const mediaEl = getActiveMediaEl();
    if (!mediaEl) return;
    if (mediaEl.paused) {
      try {
        await mediaEl.play();
        setIsPlaying(true);
      } catch {
        setIsBuffering(false);
      }
    } else {
      mediaEl.pause();
      setIsPlaying(false);
    }
  }, [getActiveMediaEl, isPlaying, youtubeFallbackId]);

  const seekTo = useCallback(
    (seconds: number) => {
      const mediaEl = getActiveMediaEl();
      if (!mediaEl) return;
      const clamped = clampSeekTime(seconds, duration);
      mediaEl.currentTime = clamped;
      setCurrentTime(clamped);
    },
    [duration, getActiveMediaEl]
  );

  const skipBy = useCallback(
    (deltaSeconds: number) => {
      const mediaEl = getActiveMediaEl();
      if (!mediaEl) return;
      seekTo(mediaEl.currentTime + deltaSeconds);
    },
    [seekTo, getActiveMediaEl]
  );

  const playNext = useCallback(() => {
    const nextIdx = getNextTrackIndex(queue, currentIndex, loopMode);
    if (nextIdx >= 0) {
      setCurrentIndex(nextIdx);
      setPlayNonce((n) => n + 1);
    }
  }, [queue, currentIndex, loopMode]);

  const playPrevious = useCallback(() => {
    const prevAction = getPreviousTrackAction(queue, currentIndex, loopMode);
    if (prevAction === 'restart') {
      const mediaEl = getActiveMediaEl();
      if (mediaEl) {
        mediaEl.currentTime = 0;
        setCurrentTime(0);
      }
    } else if (prevAction.index !== null) {
      setCurrentIndex(prevAction.index);
      setPlayNonce((n) => n + 1);
    }
  }, [queue, currentIndex, loopMode, getActiveMediaEl]);

  const setPlaybackRate = useCallback((rate: PlaybackRate) => {
    setPlaybackRateState(rate);
    const mediaEl = getActiveMediaEl();
    if (mediaEl) {
      mediaEl.playbackRate = rate;
    }
  }, []);

  const cycleLoopMode = useCallback(() => {
    setLoopMode(getNextLoopMode(loopMode));
  }, [loopMode]);

  const toggleAudioOnlyMode = useCallback(() => {
    setAudioOnlyMode((prev) => {
      const newVal = !prev;
      audioOnlyModeRef.current = newVal;
      return newVal;
    });
  }, []);

  const toggleAutoplayRelated = useCallback(() => {
    setExpandedState((prev) => {
      const newVal = !prev;
      onToggleAutoplayRelated?.();
      return newVal;
    });
  }, [onToggleAutoplayRelated]);

  const togglePictureInPicture = useCallback(async () => {
    const mediaEl = getActiveMediaEl();
    if (!mediaEl || !document.pictureInPictureEnabled) return;
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
      setIsPipActive(false);
    } else {
      try {
        await mediaEl.requestPictureInPicture();
        setIsPipActive(true);
      } catch (err) {
        setPipMessage(err instanceof Error ? err.message : 'PiP failed');
      }
    }
  }, [getActiveMediaEl]);

  const setExpanded = useCallback((expanded: boolean) => {
    setExpandedState(expanded);
    if (!expanded) {
      setLyricsViewOpenState(false);
    }
  }, []);

  const setQueueOpen = useCallback((open: boolean) => {
    setQueueOpenState(open);
  }, []);

  const setVideoFullscreen = useCallback((fullscreen: boolean) => {
    setVideoFullscreenState(fullscreen);
  }, []);

  const setLyricsViewOpen = useCallback((open: boolean) => {
    setLyricsViewOpenState(open);
  }, []);

  const stopAndClearCurrent = useCallback(() => {
    setCurrentIndex(-1);
    setPlayNonce((n) => n + 1);
    void stopNativeAudio();
    stopBackgroundKeepAlive();
    stopAllHtmlMediaEls();
    revokeActiveObjectUrl();
    setIsPlaying(false);
    setIsBuffering(false);
    setCurrentTime(0);
    setDuration(0);
  }, [stopNativeAudio, stopBackgroundKeepAlive, stopAllHtmlMediaEls, revokeActiveObjectUrl]);

  const clearPlayerError = useCallback(() => {
    setPlayerError(null);
  }, []);

  const setEqBandGain = useCallback((bandIndex: number, gainDb: number) => {
    setEqGains((prev) => {
      const next = [...prev];
      next[bandIndex] = clampEqGain(gainDb);
      return next;
    });
  }, []);

  const applyEqPreset = useCallback((presetName: EqPresetName) => {
    setEqGains(applyEqualizerGains(EQ_PRESETS[presetName]));
  }, []);

  const initEqualizer = useCallback(() => {
    resumeEqualizerContext();
  }, []);

  const setSleepTimer = useCallback((option: SleepTimerOption) => {
    setSleepTimerOption(option);
    if (option === 'off') {
      setSleepTimerRemainingSec(null);
    } else {
      const remaining = option === 'custom' ? 0 : (option as number);
      setSleepTimerRemainingSec(remaining);
    }
  }, []);

  const downloadTrack = useCallback(async (track: PlayableTrack) => {
    const streamUrl = track.streamUrl || track.sourceUrl;
    if (!streamUrl) {
      alert("No stream URL available for download.");
      return;
    }
    
    try {
      await downloadTrackUtil(track.id, streamUrl, track.title || "Unknown Track");
    } catch (e) {
      alert("Failed to download track");
    }
  }, []);

  const value: PlayerContextValue = useMemo(
    () => ({
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
      isUsingYouTubeFallback: !!youtubeFallbackId,
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
      downloadTrack,
    }),
    [
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
      youtubeFallbackId,
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
      downloadTrack,
    ]
  );

  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
}

export function usePlayerContext() {
  const ctx = useContext(PlayerContext);
  if (!ctx) {
    throw new Error('usePlayerContext must be used within a PlayerProvider');
  }
  return ctx;
}

// Alias for components that import `usePlayer` directly.
export const usePlayer = usePlayerContext;
