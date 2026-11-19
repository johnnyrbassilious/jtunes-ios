import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_BACKEND_URL } from '../utils/api';
import { normalizeBackendUrl } from '../utils/formatters';

interface SplashScreenProps {
  backendUrl?: string;
  onComplete: () => void;
}

const SPLASH_FALLBACK_TIMEOUT_MS = 2400;
const SPLASH_REMOTE_TIMEOUT_MS = 3800;
const SPLASH_FADE_DURATION_MS = 300;

export function SplashScreen({ backendUrl, onComplete }: SplashScreenProps) {
  const [videoSrc, setVideoSrc] = useState<string>('/splash.mp4');
  const [isFadingOut, setIsFadingOut] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const triedRemoteFallbackRef = useRef(false);
  const completedRef = useRef(false);
  const fadeTimerRef = useRef<number | null>(null);
  const fallbackTimerRef = useRef<number | null>(null);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const triggerFadeOut = useCallback(() => {
    if (completedRef.current) {
      return;
    }
    completedRef.current = true;
    if (fallbackTimerRef.current !== null) {
      window.clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
    setIsFadingOut(true);
    fadeTimerRef.current = window.setTimeout(() => {
      onCompleteRef.current();
    }, SPLASH_FADE_DURATION_MS);
  }, []);

  const scheduleFallbackTimeout = useCallback(
    (delayMs: number) => {
      if (completedRef.current) {
        return;
      }
      if (fallbackTimerRef.current !== null) {
        window.clearTimeout(fallbackTimerRef.current);
      }
      fallbackTimerRef.current = window.setTimeout(() => {
        triggerFadeOut();
      }, delayMs);
    },
    [triggerFadeOut]
  );

  useEffect(() => {
    scheduleFallbackTimeout(SPLASH_FALLBACK_TIMEOUT_MS);

    return () => {
      if (fallbackTimerRef.current !== null) {
        window.clearTimeout(fallbackTimerRef.current);
      }
      if (fadeTimerRef.current !== null) {
        window.clearTimeout(fadeTimerRef.current);
      }
    };
  }, [scheduleFallbackTimeout]);

  const handleVideoError = useCallback(() => {
    if (triedRemoteFallbackRef.current) {
      return;
    }
    triedRemoteFallbackRef.current = true;
    const base = normalizeBackendUrl(backendUrl ?? '') || DEFAULT_BACKEND_URL;
    const remoteSrc = `${base}/splash.mp4`;
    setVideoSrc(remoteSrc);
    scheduleFallbackTimeout(SPLASH_REMOTE_TIMEOUT_MS);
  }, [backendUrl, scheduleFallbackTimeout]);

  useEffect(() => {
    if (videoSrc === '/splash.mp4') {
      return;
    }
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.load();
    void video.play().catch(() => {});
  }, [videoSrc]);

  return (
    <div
      aria-label="Jtunes launch screen"
      className={`fixed inset-0 z-[9999] flex items-center justify-center bg-[#ffffff] transition-opacity duration-300 ${
        isFadingOut ? 'opacity-0 pointer-events-none' : 'opacity-100'
      }`}
    >
      <video
        ref={videoRef}
        src={videoSrc}
        autoPlay
        muted
        playsInline
        preload="auto"
        onEnded={triggerFadeOut}
        onError={handleVideoError}
        className="pointer-events-none h-auto w-[72vw] max-w-[320px] object-contain mix-blend-multiply select-none"
      />
    </div>
  );
}
