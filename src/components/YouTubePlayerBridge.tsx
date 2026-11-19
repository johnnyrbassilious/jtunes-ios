import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';

interface YTPlayerInstance {
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead?: boolean) => void;
  setPlaybackRate: (rate: number) => void;
  setPlaybackQuality?: (suggestedQuality: string) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  getPlayerState: () => number;
  destroy: () => void;
}

interface YTNamespace {
  Player: new (
    el: HTMLElement | string,
    opts: {
      videoId: string;
      playerVars?: Record<string, number | string>;
      events?: {
        onReady?: (event: { target: YTPlayerInstance }) => void;
        onStateChange?: (event: { data: number; target: YTPlayerInstance }) => void;
        onError?: (event: { data: number; target: YTPlayerInstance }) => void;
      };
    }
  ) => YTPlayerInstance;
  PlayerState?: {
    ENDED: number;
    PLAYING: number;
    PAUSED: number;
    BUFFERING: number;
  };
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let ytApiPromise: Promise<YTNamespace> | null = null;

function loadYouTubeIframeApi(): Promise<YTNamespace> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Window unavailable'));
  }
  if (window.YT && window.YT.Player) {
    return Promise.resolve(window.YT);
  }
  if (ytApiPromise) {
    return ytApiPromise;
  }

  ytApiPromise = new Promise<YTNamespace>((resolve, reject) => {
    const prevReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof prevReady === 'function') {
        prevReady();
      }
      if (window.YT) {
        resolve(window.YT);
      } else {
        reject(new Error('YouTube IFrame API failed to initialize'));
      }
    };

    const existing = document.querySelector('script[src*="youtube.com/iframe_api"]');
    if (!existing) {
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      script.onerror = () => reject(new Error('Failed to load YouTube IFrame API script'));
      document.head.appendChild(script);
    }
  });

  return ytApiPromise;
}

export interface YouTubePlayerBridgeHandle {
  play: () => void;
  pause: () => void;
  seekTo: (seconds: number) => void;
  setPlaybackRate: (rate: number) => void;
}

interface YouTubePlayerBridgeProps {
  videoId: string;
  playbackRate: number;
  loop: boolean;
  preferredQuality?: 'small' | 'default';
  onPlay: () => void;
  onPause: () => void;
  onBuffering: (buffering: boolean) => void;
  onTimeUpdate: (currentTime: number, duration: number) => void;
  onEnded: () => void;
  onError: () => void;
  onEmbedBlocked?: (errorCode: number) => void;
}

export const YouTubePlayerBridge = forwardRef<
  YouTubePlayerBridgeHandle,
  YouTubePlayerBridgeProps
>(function YouTubePlayerBridge(
  {
    videoId,
    playbackRate,
    loop,
    preferredQuality = 'default',
    onPlay,
    onPause,
    onBuffering,
    onTimeUpdate,
    onEnded,
    onError,
    onEmbedBlocked,
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YTPlayerInstance | null>(null);
  const loopRef = useRef(loop);
  const rateRef = useRef(playbackRate);
  const qualityRef = useRef(preferredQuality);

  loopRef.current = loop;
  rateRef.current = playbackRate;
  qualityRef.current = preferredQuality;

  const callbacksRef = useRef({
    onPlay,
    onPause,
    onBuffering,
    onTimeUpdate,
    onEnded,
    onError,
    onEmbedBlocked,
  });
  callbacksRef.current = {
    onPlay,
    onPause,
    onBuffering,
    onTimeUpdate,
    onEnded,
    onError,
    onEmbedBlocked,
  };

  useImperativeHandle(
    ref,
    () => ({
      play: () => {
        playerRef.current?.playVideo();
      },
      pause: () => {
        playerRef.current?.pauseVideo();
      },
      seekTo: (seconds: number) => {
        playerRef.current?.seekTo(seconds, true);
      },
      setPlaybackRate: (rate: number) => {
        try {
          playerRef.current?.setPlaybackRate(rate);
        } catch {
          // Ignore unsupported rate
        }
      },
    }),
    []
  );

  useEffect(() => {
    try {
      playerRef.current?.setPlaybackRate(playbackRate);
    } catch {
      // Ignore
    }
  }, [playbackRate]);

  useEffect(() => {
    try {
      if (preferredQuality === 'small') {
        playerRef.current?.setPlaybackQuality?.('small');
      }
    } catch {
      // Ignore
    }
  }, [preferredQuality]);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: number | null = null;

    void loadYouTubeIframeApi()
      .then((YT) => {
        if (cancelled || !containerRef.current) {
          return;
        }
        containerRef.current.innerHTML = '';
        const mountEl = document.createElement('div');
        mountEl.className = 'h-full w-full';
        containerRef.current.appendChild(mountEl);

        const player = new YT.Player(mountEl, {
          videoId,
          playerVars: {
            autoplay: 1,
            controls: 0,
            modestbranding: 1,
            rel: 0,
            playsinline: 1,
            enablejsapi: 1,
          },
          events: {
            onReady: (ev) => {
              if (cancelled) {
                return;
              }
              try {
                ev.target.setPlaybackRate(rateRef.current);
                if (qualityRef.current === 'small') {
                  ev.target.setPlaybackQuality?.('small');
                }
              } catch {
                // Ignore
              }
              ev.target.playVideo();
              const dur = ev.target.getDuration();
              if (Number.isFinite(dur) && dur > 0) {
                callbacksRef.current.onTimeUpdate(0, dur);
              }
              pollTimer = window.setInterval(() => {
                if (!playerRef.current) {
                  return;
                }
                try {
                  const t = playerRef.current.getCurrentTime();
                  const d = playerRef.current.getDuration();
                  if (Number.isFinite(t) && Number.isFinite(d)) {
                    callbacksRef.current.onTimeUpdate(t, d);
                  }
                } catch {
                  // Ignore transient getter errors
                }
              }, 500);
            },
            onStateChange: (ev) => {
              if (cancelled) {
                return;
              }
              // YT.PlayerState: 0=ENDED, 1=PLAYING, 2=PAUSED, 3=BUFFERING
              if (ev.data === 1) {
                callbacksRef.current.onBuffering(false);
                callbacksRef.current.onPlay();
              } else if (ev.data === 2) {
                callbacksRef.current.onBuffering(false);
                callbacksRef.current.onPause();
              } else if (ev.data === 3) {
                callbacksRef.current.onBuffering(true);
              } else if (ev.data === 0) {
                if (loopRef.current) {
                  ev.target.seekTo(0, true);
                  ev.target.playVideo();
                } else {
                  callbacksRef.current.onEnded();
                }
              }
            },
            onError: (ev) => {
              if (cancelled) {
                return;
              }
              const errorCode = typeof ev?.data === 'number' ? ev.data : 0;
              if ((errorCode === 101 || errorCode === 150) && callbacksRef.current.onEmbedBlocked) {
                callbacksRef.current.onEmbedBlocked(errorCode);
                return;
              }
              callbacksRef.current.onError();
            },
          },
        });

        playerRef.current = player;
      })
      .catch(() => {
        if (!cancelled) {
          callbacksRef.current.onError();
        }
      });

    return () => {
      cancelled = true;
      if (pollTimer !== null) {
        window.clearInterval(pollTimer);
      }
      if (playerRef.current) {
        try {
          playerRef.current.destroy();
        } catch {
          // Ignore destroy cleanup error
        }
        playerRef.current = null;
      }
    };
  }, [videoId]);

  return (
    <div
      ref={containerRef}
      aria-label="YouTube fallback player"
      className="h-full w-full overflow-hidden rounded-2xl bg-black"
    />
  );
});
