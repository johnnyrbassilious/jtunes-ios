import {
  CheckCircle2,
  Download,
  Film,
  Loader2,
  MoreVertical,
  Music,
  RotateCcw,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import type { ActiveDownload, OfflineMediaFile } from '../types/media';
import { formatBytes, formatMegabytes } from '../utils/formatters';
import type { ActionSheetTarget } from './MediaActionSheet';
import { ThumbnailArt } from './ThumbnailArt';

interface DownloadsViewProps {
  activeDownloads: ActiveDownload[];
  completedDownloads: ActiveDownload[];
  libraryFiles: OfflineMediaFile[];
  onCancelDownload: (id: string) => void;
  onRetryDownload: (download: ActiveDownload) => void;
  onRemoveActiveDownload: (id: string) => void;
  onClearCompleted: () => void;
  onPlayOfflineFile: (offlineFileId: string) => void;
  onOpenActionMenu: (target: ActionSheetTarget) => void;
}

export function DownloadsView({
  activeDownloads,
  completedDownloads,
  libraryFiles,
  onCancelDownload,
  onRetryDownload,
  onRemoveActiveDownload,
  onClearCompleted,
  onPlayOfflineFile,
  onOpenActionMenu,
}: DownloadsViewProps) {
  const hasAny = activeDownloads.length > 0 || completedDownloads.length > 0;
  const hasClearable =
    completedDownloads.length > 0 ||
    activeDownloads.some((d) => d.status === 'error' || d.status === 'cancelled');

  return (
    <section aria-label="Downloads" className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
          Downloads
        </h1>

        {hasClearable && (
          <button
            type="button"
            onClick={onClearCompleted}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800 whitespace-nowrap shrink-0"
          >
            <Trash2 size={15} />
            <span>Clear</span>
          </button>
        )}
      </div>

      {!hasAny ? (
        <div className="flex flex-col items-center justify-center rounded-3xl border border-zinc-200 bg-white px-6 py-16 text-center dark:border-zinc-800/80 dark:bg-zinc-900/40">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-zinc-100 text-zinc-500 dark:bg-zinc-800/80 dark:text-zinc-400">
            <Download size={22} />
          </div>
          <h2 className="mt-4 text-base font-semibold text-zinc-900 dark:text-zinc-100">
            No downloads
          </h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Active and completed downloads appear here.
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {activeDownloads.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">
                Active ({activeDownloads.length})
              </h2>
              {activeDownloads.map((dl) => {
                const isInProgress =
                  dl.status === 'resolving' ||
                  dl.status === 'downloading' ||
                  dl.status === 'encoding' ||
                  dl.status === 'saving';

                return (
                  <article
                    key={dl.id}
                    className="rounded-2xl border border-zinc-200 bg-white p-3.5 space-y-3 dark:border-zinc-800/80 dark:bg-zinc-900/60"
                  >
                    <div className="flex items-center gap-3">
                      <ThumbnailArt
                        src={dl.item.thumbnail}
                        alt={dl.item.title}
                        mode={dl.mode}
                        showMediaBadge
                        className="h-14 w-20 rounded-xl shrink-0"
                      />
                      <div className="min-w-0 flex-1 space-y-1">
                        <h3 className="line-clamp-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                          {dl.item.title}
                        </h3>
                        <p className="line-clamp-1 text-xs text-zinc-500 dark:text-zinc-400">
                          {dl.item.uploader} · {dl.formatLabel}
                        </p>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="text-xs">
                        {dl.status === 'resolving' && (
                          <span className="inline-flex items-center gap-1.5 text-zinc-700 dark:text-zinc-300">
                            <Loader2 size={13} className="animate-spin text-accent" />
                            <span>Resolving...</span>
                          </span>
                        )}
                        {dl.status === 'downloading' && (
                          <span className="font-mono tabular-nums text-zinc-700 dark:text-zinc-300">
                            {formatMegabytes(dl.receivedBytes)}
                            {dl.totalBytes ? ` / ${formatMegabytes(dl.totalBytes)}` : ''}
                            {dl.progress >= 0 ? ` · ${dl.progress}%` : ''}
                          </span>
                        )}
                        {dl.status === 'encoding' && (
                          <span className="inline-flex items-center gap-1.5 text-accent">
                            <Loader2 size={13} className="animate-spin" />
                            <span>Encoding MP3...</span>
                          </span>
                        )}
                        {dl.status === 'saving' && (
                          <span className="inline-flex items-center gap-1.5 text-zinc-700 dark:text-zinc-300">
                            <Loader2 size={13} className="animate-spin text-accent" />
                            <span>Saving...</span>
                          </span>
                        )}
                        {dl.status === 'error' && (
                          <span className="inline-flex items-center gap-1.5 text-red-600 dark:text-red-400 break-words">
                            <XCircle size={14} className="shrink-0" />
                            <span>{dl.error || 'Download failed'}</span>
                          </span>
                        )}
                        {dl.status === 'cancelled' && (
                          <span className="text-zinc-500">Cancelled</span>
                        )}
                      </div>

                      {isInProgress && (
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                          {dl.progress >= 0 ? (
                            <div
                              className="h-full rounded-full bg-accent transition-[width] duration-200"
                              style={{ width: `${Math.min(100, Math.max(4, dl.progress))}%` }}
                            />
                          ) : (
                            <div className="h-full w-1/3 animate-pulse rounded-full bg-accent" />
                          )}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center justify-end gap-2">
                      {isInProgress && (
                        <button
                          type="button"
                          onClick={() => onCancelDownload(dl.id)}
                          aria-label={`Cancel download ${dl.item.title}`}
                          className="inline-flex min-h-[42px] items-center gap-1.5 rounded-xl border border-zinc-200 bg-zinc-100 px-3.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-200 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
                        >
                          <X size={14} />
                          <span>Cancel</span>
                        </button>
                      )}

                      {(dl.status === 'error' || dl.status === 'cancelled') && (
                        <>
                          <button
                            type="button"
                            onClick={() => onRetryDownload(dl)}
                            aria-label={`Retry download ${dl.item.title}`}
                            className="inline-flex min-h-[42px] items-center gap-1.5 rounded-xl border border-zinc-200 bg-zinc-100 px-3.5 text-xs font-semibold text-zinc-800 hover:bg-zinc-200 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700"
                          >
                            <RotateCcw size={14} />
                            <span>Retry</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => onRemoveActiveDownload(dl.id)}
                            aria-label={`Remove ${dl.item.title}`}
                            className="flex min-h-[42px] min-w-[42px] items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                          >
                            <Trash2 size={16} />
                          </button>
                        </>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}

          {completedDownloads.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">
                Completed ({completedDownloads.length})
              </h2>
              {completedDownloads.map((dl) => {
                const offlineMatch = dl.offlineFileId
                  ? libraryFiles.find((f) => f.id === dl.offlineFileId)
                  : undefined;

                return (
                  <article
                    key={dl.id}
                    className="flex items-center gap-2 rounded-2xl border border-zinc-200 bg-white p-2.5 transition-colors hover:border-zinc-300 dark:border-zinc-800/80 dark:bg-zinc-900/60 dark:hover:border-zinc-700"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        if (dl.offlineFileId) {
                          onPlayOfflineFile(dl.offlineFileId);
                        }
                      }}
                      aria-label={`Play ${dl.item.title}`}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                    >
                      <ThumbnailArt
                        src={dl.item.thumbnail}
                        alt={dl.item.title}
                        mode={dl.mode}
                        showMediaBadge
                        className="h-14 w-20 rounded-xl shrink-0"
                      />
                      <div className="min-w-0 flex-1 space-y-1">
                        <h3 className="line-clamp-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                          {dl.item.title}
                        </h3>
                        <p className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400 min-w-0">
                          {dl.mode === 'audio' ? (
                            <Music size={12} className="shrink-0" />
                          ) : (
                            <Film size={12} className="shrink-0" />
                          )}
                          <CheckCircle2
                            size={12}
                            className="shrink-0 text-emerald-600 dark:text-emerald-400"
                          />
                          <span className="truncate">{dl.formatLabel}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums text-emerald-700 dark:text-emerald-300 shrink-0">
                            {formatBytes(dl.receivedBytes)}
                          </span>
                        </p>
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        onOpenActionMenu({
                          id: dl.item.id,
                          title: dl.item.title,
                          uploader: dl.item.uploader,
                          duration: dl.item.duration,
                          thumbnail: dl.item.thumbnail,
                          url: dl.item.url,
                          mediaItem: dl.item,
                          offlineFile: offlineMatch,
                          downloadEntryId: dl.id,
                        })
                      }
                      aria-label={`More options for ${dl.item.title}`}
                      className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-white shrink-0"
                    >
                      <MoreVertical size={18} />
                    </button>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
