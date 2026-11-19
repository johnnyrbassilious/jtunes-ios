import { useRef, useState } from 'react';
import { Loader2, Pause, Play, SkipForward, X } from 'lucide-react';
import { usePlayer } from '../context/PlayerContext';
import { ThumbnailArt } from './ThumbnailArt';

export function MiniPlayer() {
  const {
    currentTrack,
    isPlaying,
    isBuffering,
    currentTime,
    duration,
    isExpanded,
    setExpanded,
    togglePlayPause,
    playNext,
    stopAndClearCurrent,
  } = usePlayer();

  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const [dragOffsetY, setDragOffsetY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  if (!currentTrack || isExpanded) {
    return null;
  }

  const progressPercent =
    duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;

  return (
    <div
      aria-label="Mini player"
      onTouchStart={(e) => {
        const t = e.touches[0];
        if (t) {
          touchStartRef.current = { x: t.clientX, y: t.clientY };
          setIsDragging(true);
        }
      }}
      onTouchMove={(e) => {
        const start = touchStartRef.current;
        const t = e.touches[0];
        if (!start || !t) {
          return;
        }
        const deltaY = t.clientY - start.y;
        const deltaX = t.clientX - start.x;
        if (deltaY < 0 && Math.abs(deltaY) >= Math.abs(deltaX)) {
          setDragOffsetY(Math.max(-96, deltaY));
        } else {
          setDragOffsetY(0);
        }
      }}
      onTouchEnd={(e) => {
        const start = touchStartRef.current;
        touchStartRef.current = null;
        setIsDragging(false);
        const t = e.changedTouches[0];
        const deltaY = start && t ? t.clientY - start.y : dragOffsetY;
        const deltaX = start && t ? t.clientX - start.x : 0;
        const shouldExpand =
          dragOffsetY < -36 || (deltaY < -36 && Math.abs(deltaY) > Math.abs(deltaX));
        setDragOffsetY(0);
        if (shouldExpand) {
          setExpanded(true);
        }
      }}
      onTouchCancel={() => {
        touchStartRef.current = null;
        setIsDragging(false);
        setDragOffsetY(0);
      }}
      style={{
        transform: `translate3d(0, ${dragOffsetY}px, 0)`,
      }}
      className={`fixed bottom-[calc(4rem+env(safe-area-inset-bottom,0px)+8px)] left-3 right-3 z-30 mx-auto max-w-5xl overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]/95 shadow-2xl backdrop-blur-xl animate-tubidy-sheet ${
        isDragging ? '' : 'transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]'
      }`}
    >
      {/* Thin playback progress strip */}
      <div className="h-0.5 w-full bg-[var(--bg-elevated)]">
        <div
          className="h-full transition-[width] duration-150"
          style={{ width: `${progressPercent}%`, backgroundColor: 'var(--accent)' }}
        />
      </div>

      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setExpanded(true)}
          aria-label={`Expand full player for ${currentTrack.title}`}
          className="flex min-h-[44px] min-w-0 flex-1 items-center gap-3 rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          <ThumbnailArt
            src={currentTrack.thumbnail}
            alt={currentTrack.title}
            mode={currentTrack.mode}
            className="h-11 w-14 rounded-xl"
            iconSize={18}
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-[var(--text-primary)]">
              {currentTrack.title}
            </p>
            <p className="truncate text-xs text-[var(--text-secondary)]">
              {currentTrack.uploader} · {currentTrack.isOffline ? 'Offline' : 'Stream'}
            </p>
          </div>
        </button>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => void togglePlayPause()}
            aria-label={isPlaying ? 'Pause playback' : 'Resume playback'}
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-elevated)]"
          >
            {isBuffering ? (
              <Loader2 size={19} className="animate-spin text-accent" />
            ) : isPlaying ? (
              <Pause size={19} fill="currentColor" />
            ) : (
              <Play size={19} fill="currentColor" />
            )}
          </button>

          {!currentTrack.isLiveRadio && (
            <button
              type="button"
              onClick={playNext}
              aria-label="Next track"
              className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-elevated)]"
            >
              <SkipForward size={18} />
            </button>
          )}

          <button
            type="button"
            onClick={stopAndClearCurrent}
            aria-label="Stop and close mini player"
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
          >
            <X size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}

