import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';

const EMBED_BASE_URL = 'https://tubidy-vercel-api.vercel.app/api/embed';

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
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
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

  const sendCommand = (cmd: string, payload?: Record<string, unknown>) => {
    try {
      iframeRef.current?.contentWindow?.postMessage(
        { source: 'jtunes-app', cmd, ...payload },
        '*'
      );
    } catch {
      // Ignore postMessage errors before iframe loads
    }
  };

  useImperativeHandle(
    ref,
    () => ({
      play: () => sendCommand('play'),
      pause: () => sendCommand('pause'),
      seekTo: (seconds: number) => sendCommand('seekTo', { seconds }),
      setPlaybackRate: (rate: number) => sendCommand('setPlaybackRate', { rate }),
    }),
    []
  );

  useEffect(() => {
    sendCommand('setPlaybackRate', { rate: playbackRate });
  }, [playbackRate]);

  useEffect(() => {
    if (preferredQuality === 'small') {
      sendCommand('setPlaybackQuality', { quality: 'small' });
    }
  }, [preferredQuality]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const msg = event.data;
      if (!msg || typeof msg !== 'object' || msg.source !== 'jtunes-yt') {
        return;
      }

      if (msg.type === 'ready') {
        sendCommand('setPlaybackRate', { rate: rateRef.current });
        if (qualityRef.current === 'small') {
          sendCommand('setPlaybackQuality', { quality: 'small' });
        }
        if (typeof msg.duration === 'number' && msg.duration > 0) {
          callbacksRef.current.onTimeUpdate(0, msg.duration);
        }
      } else if (msg.type === 'time') {
        if (typeof msg.currentTime === 'number' && typeof msg.duration === 'number') {
          callbacksRef.current.onTimeUpdate(msg.currentTime, msg.duration);
        }
      } else if (msg.type === 'state') {
        // YT.PlayerState: 0=ENDED, 1=PLAYING, 2=PAUSED, 3=BUFFERING
        if (msg.state === 1) {
          callbacksRef.current.onBuffering(false);
          callbacksRef.current.onPlay();
        } else if (msg.state === 2) {
          callbacksRef.current.onBuffering(false);
          callbacksRef.current.onPause();
        } else if (msg.state === 3) {
          callbacksRef.current.onBuffering(true);
        } else if (msg.state === 0) {
          if (loopRef.current) {
            sendCommand('seekTo', { seconds: 0 });
            sendCommand('play');
          } else {
            callbacksRef.current.onEnded();
          }
        }
      } else if (msg.type === 'error') {
        const errorCode = typeof msg.code === 'number' ? msg.code : 0;
        if ((errorCode === 101 || errorCode === 150) && callbacksRef.current.onEmbedBlocked) {
          callbacksRef.current.onEmbedBlocked(errorCode);
          return;
        }
        callbacksRef.current.onError();
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [videoId]);

  return (
    <div
      aria-label="YouTube fallback player"
      className="h-full w-full overflow-hidden rounded-2xl bg-black"
    >
      <iframe
        key={videoId}
        ref={iframeRef}
        src={`${EMBED_BASE_URL}?id=${encodeURIComponent(videoId)}`}
        title="YouTube Player"
        className="h-full w-full border-0"
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
        allowFullScreen
      />
    </div>
  );
});
