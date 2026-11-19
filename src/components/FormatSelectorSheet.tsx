import { useEffect } from 'react';
import { Download, Film, Music2, X } from 'lucide-react';
import type { MediaItem, VideoQuality } from '../types/media';
import { formatDuration } from '../utils/formatters';
import { ThumbnailArt } from './ThumbnailArt';

interface FormatSelectorSheetProps {
  item: MediaItem | null;
  onClose: () => void;
  onDownloadAudioMp3: (item: MediaItem) => void;
  onDownloadVideo: (item: MediaItem, quality: VideoQuality) => void;
}

const VIDEO_QUALITIES: VideoQuality[] = ['1080', '720', '480', '360'];

export function FormatSelectorSheet({
  item,
  onClose,
  onDownloadAudioMp3,
  onDownloadVideo,
}: FormatSelectorSheetProps) {
  useEffect(() => {
    if (!item) {
      return;
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [item, onClose]);

  if (!item) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="format-sheet-title"
        onClick={(e) => e.stopPropagation()}
        className="max-h-[88vh] w-full max-w-md overflow-y-auto rounded-t-3xl border border-zinc-800 bg-zinc-950 p-5 pb-safe shadow-2xl sm:rounded-3xl"
      >
        <div className="mx-auto mb-4 h-1.5 w-10 rounded-full bg-zinc-700 sm:hidden" />

        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <ThumbnailArt
              src={item.thumbnail}
              alt={item.title}
              className="h-12 w-16 rounded-xl"
            />
            <div className="min-w-0">
              <h2
                id="format-sheet-title"
                className="line-clamp-1 text-sm font-semibold text-zinc-100"
              >
                {item.title}
              </h2>
              <p className="line-clamp-1 text-xs text-zinc-400">
                {item.uploader} ·{' '}
                <span className="font-mono tabular-nums">{formatDuration(item.duration)}</span>
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
          >
            <X size={20} />
          </button>
        </div>

        <div className="mt-5 space-y-4">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-zinc-300">
              <Music2 size={15} className="text-accent" />
              <span>Audio</span>
            </div>
            <button
              type="button"
              onClick={() => {
                onDownloadAudioMp3(item);
                onClose();
              }}
              className="inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-2xl bg-accent px-4 text-sm font-semibold transition-colors active:scale-[0.98]"
            >
              <Download size={17} />
              <span>Download Audio (MP3)</span>
            </button>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-zinc-300">
              <Film size={15} className="text-accent" />
              <span>Video (MP4)</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {VIDEO_QUALITIES.map((quality) => (
                <button
                  key={quality}
                  type="button"
                  onClick={() => {
                    onDownloadVideo(item, quality);
                    onClose();
                  }}
                  className="min-h-[46px] rounded-xl border border-zinc-800 bg-zinc-900 px-3 font-mono text-xs font-semibold text-zinc-100 transition-colors hover:border-zinc-600 hover:bg-zinc-800"
                >
                  {quality}p
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
