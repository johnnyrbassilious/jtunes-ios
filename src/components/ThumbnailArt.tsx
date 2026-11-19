import { useState } from 'react';
import { Film, Music, Music2 } from 'lucide-react';
import type { MediaFormatMode } from '../types/media';

interface ThumbnailArtProps {
  src?: string;
  alt: string;
  mode?: MediaFormatMode;
  className?: string;
  iconSize?: number;
  showMediaBadge?: boolean;
}

export function ThumbnailArt({
  src,
  alt,
  mode = 'video',
  className = '',
  iconSize = 24,
  showMediaBadge = false,
}: ThumbnailArtProps) {
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(src && src.trim().length > 0 && !failed);

  return (
    <div
      className={`relative overflow-hidden bg-zinc-100 ring-1 ring-inset ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800 flex items-center justify-center shrink-0 ${className}`}
    >
      {showImage ? (
        <img
          src={src}
          alt={alt}
          referrerPolicy="no-referrer"
          loading="lazy"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-zinc-100 via-zinc-200 to-zinc-300 text-zinc-500 dark:from-zinc-800 dark:via-zinc-900 dark:to-zinc-950 dark:text-zinc-500">
          {mode === 'audio' ? <Music2 size={iconSize} /> : <Film size={iconSize} />}
        </div>
      )}

      {showMediaBadge && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-1 right-1 flex h-5 w-5 items-center justify-center rounded-md bg-zinc-950/85 text-zinc-100 ring-1 ring-white/15 backdrop-blur-sm"
        >
          {mode === 'audio' ? <Music size={11} /> : <Film size={11} />}
        </span>
      )}
    </div>
  );
}
