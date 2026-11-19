import React, { useMemo, useState } from 'react';
import {
  CheckSquare,
  Film,
  FolderHeart,
  ListMusic,
  MoreVertical,
  Music,
  Play,
  Plus,
  Search,
  Shuffle,
  Trash2,
  X,
} from 'lucide-react';
import type { OfflineMediaFile, PlaylistRecord } from '../types/media';
import { formatDuration, formatMegabytes } from '../utils/formatters';
import { filterOfflineMediaFiles, type MediaTypeFilter } from '../utils/libraryFilters';
import { usePlayer } from '../context/PlayerContext';
import type { ActionSheetTarget } from './MediaActionSheet';
import { ThumbnailArt } from './ThumbnailArt';

type LibrarySection = 'files' | 'playlists';

interface LibraryViewProps {
  libraryFiles: OfflineMediaFile[];
  playlists: PlaylistRecord[];
  onPlayOfflineFile: (file: OfflineMediaFile) => void;
  onPlayOfflineFilesList: (files: OfflineMediaFile[], startIndex?: number) => void;
  onOpenActionMenu: (target: ActionSheetTarget) => void;
  onCreatePlaylist: (name: string) => void;
  onDeletePlaylist: (id: string) => void;
  onToggleFileInPlaylist: (playlistId: string, fileId: string) => void;
  onPlayPlaylist: (playlist: PlaylistRecord) => void;
  onShufflePlaylist: (playlist: PlaylistRecord) => void;
}

export function LibraryView({
  libraryFiles,
  playlists,
  onPlayOfflineFile,
  onPlayOfflineFilesList,
  onOpenActionMenu,
  onCreatePlaylist,
  onDeletePlaylist,
  onToggleFileInPlaylist,
  onPlayPlaylist,
  onShufflePlaylist,
}: LibraryViewProps) {
  const { currentTrack } = usePlayer();
  const [section, setSection] = useState<LibrarySection>('files');
  const [mediaFilter, setMediaFilter] = useState<MediaTypeFilter>('all');
  const [localQuery, setLocalQuery] = useState('');
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [editingPlaylistId, setEditingPlaylistId] = useState<string | null>(null);

  const handleCreatePlaylist = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newPlaylistName.trim();
    if (!trimmed) {
      return;
    }
    onCreatePlaylist(trimmed);
    setNewPlaylistName('');
  };

  const fileById = useMemo(() => {
    const map = new Map<string, OfflineMediaFile>();
    for (const file of libraryFiles) {
      map.set(file.id, file);
    }
    return map;
  }, [libraryFiles]);

  const videoCount = useMemo(
    () => libraryFiles.filter((f) => f.mediaType === 'video').length,
    [libraryFiles]
  );
  const audioCount = useMemo(
    () => libraryFiles.filter((f) => f.mediaType === 'audio').length,
    [libraryFiles]
  );

  const filteredFiles = useMemo(
    () => filterOfflineMediaFiles(libraryFiles, mediaFilter, localQuery),
    [libraryFiles, mediaFilter, localQuery]
  );

  return (
    <section aria-label="Library" className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
          Library
        </h1>

        {section === 'files' && filteredFiles.length > 0 && (
          <button
            type="button"
            onClick={() => onPlayOfflineFilesList(filteredFiles, 0)}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-accent px-4 text-xs font-semibold whitespace-nowrap shrink-0"
          >
            <Play size={14} fill="currentColor" />
            <span>Play All</span>
          </button>
        )}
      </div>

      {/* Sub-Tabs: Saved & Playlists */}
      <div
        role="tablist"
        aria-label="Library sections"
        className="grid grid-cols-2 gap-1.5 rounded-2xl border border-zinc-200 bg-zinc-100 p-1 dark:border-zinc-800/80 dark:bg-zinc-900/70"
      >
        <button
          type="button"
          role="tab"
          aria-selected={section === 'files'}
          onClick={() => setSection('files')}
          className={`min-h-[44px] rounded-xl px-3 text-xs font-semibold transition-colors whitespace-nowrap ${
            section === 'files'
              ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-white'
              : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200'
          }`}
        >
          Saved ({libraryFiles.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={section === 'playlists'}
          onClick={() => setSection('playlists')}
          className={`min-h-[44px] rounded-xl px-3 text-xs font-semibold transition-colors whitespace-nowrap ${
            section === 'playlists'
              ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-white'
              : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200'
          }`}
        >
          Playlists ({playlists.length})
        </button>
      </div>

      {/* SAVED OFFLINE FILES */}
      {section === 'files' && (
        <div className="space-y-4">
          {libraryFiles.length > 0 && (
            <div className="space-y-3">
              <div
                role="tablist"
                aria-label="Filter saved media"
                className="grid grid-cols-3 gap-1.5 rounded-2xl border border-zinc-200 bg-zinc-100 p-1 dark:border-zinc-800/70 dark:bg-zinc-900/50"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={mediaFilter === 'all'}
                  onClick={() => setMediaFilter('all')}
                  className={`min-h-[40px] rounded-xl px-3 text-xs font-semibold transition-colors whitespace-nowrap ${
                    mediaFilter === 'all'
                      ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-white'
                      : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200'
                  }`}
                >
                  All ({libraryFiles.length})
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mediaFilter === 'video'}
                  onClick={() => setMediaFilter('video')}
                  className={`min-h-[40px] rounded-xl px-3 text-xs font-semibold transition-colors whitespace-nowrap ${
                    mediaFilter === 'video'
                      ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-white'
                      : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200'
                  }`}
                >
                  Video ({videoCount})
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mediaFilter === 'audio'}
                  onClick={() => setMediaFilter('audio')}
                  className={`min-h-[40px] rounded-xl px-3 text-xs font-semibold transition-colors whitespace-nowrap ${
                    mediaFilter === 'audio'
                      ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-white'
                      : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200'
                  }`}
                >
                  Audio ({audioCount})
                </button>
              </div>

              <div className="relative">
                <label htmlFor="library-filter-input" className="sr-only">
                  Filter saved files
                </label>
                <div className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-zinc-400 dark:text-zinc-500">
                  <Search size={16} />
                </div>
                <input
                  id="library-filter-input"
                  type="text"
                  value={localQuery}
                  onChange={(e) => setLocalQuery(e.target.value)}
                  placeholder="Filter by title..."
                  className="h-11 w-full rounded-2xl border border-zinc-200 bg-white pl-10 pr-10 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-soft)] dark:border-zinc-800 dark:bg-zinc-900/80 dark:text-zinc-100 dark:placeholder:text-zinc-500"
                />
                {localQuery.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setLocalQuery('')}
                    aria-label="Clear filter"
                    className="absolute inset-y-0 right-1 flex min-w-[40px] items-center justify-center text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100"
                  >
                    <X size={16} />
                  </button>
                )}
              </div>
            </div>
          )}

          {libraryFiles.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-3xl border border-zinc-200 bg-white px-6 py-16 text-center dark:border-zinc-800/80 dark:bg-zinc-900/40">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-zinc-100 text-zinc-500 dark:bg-zinc-800/80 dark:text-zinc-400">
                <FolderHeart size={22} />
              </div>
              <h2 className="mt-4 text-base font-semibold text-zinc-900 dark:text-zinc-100">
                No offline files
              </h2>
              <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                Downloaded tracks appear here.
              </p>
            </div>
          ) : filteredFiles.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-3xl border border-zinc-200 bg-white px-6 py-14 text-center dark:border-zinc-800/80 dark:bg-zinc-900/40">
              <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                No matches
              </h2>
              <button
                type="button"
                onClick={() => {
                  setMediaFilter('all');
                  setLocalQuery('');
                }}
                className="mt-4 min-h-[44px] rounded-xl border border-zinc-200 bg-zinc-100 px-4 text-xs font-semibold text-zinc-800 hover:bg-zinc-200 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
              >
                Reset
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
              {filteredFiles.map((file) => {
                const isActiveFile = currentTrack?.offlineFileId === file.id;
                return (
                  <article
                    key={file.id}
                    className={`flex items-center gap-2 rounded-2xl border p-2.5 transition-colors duration-200 ${
                      isActiveFile
                        ? 'border-accent-soft bg-accent-soft/40'
                        : 'border-zinc-200 bg-white hover:border-zinc-300 dark:border-zinc-800/80 dark:bg-zinc-900/60 dark:hover:border-zinc-700'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onPlayOfflineFile(file)}
                      aria-label={`Play ${file.title}`}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                    >
                      <ThumbnailArt
                        src={file.thumbnail}
                        alt={file.title}
                        mode={file.mediaType}
                        showMediaBadge
                        className="h-14 w-20 rounded-xl shrink-0"
                      />
                      <div className="min-w-0 flex-1 space-y-1">
                        <h2
                          className={`line-clamp-1 text-sm font-semibold ${
                            isActiveFile ? 'text-accent' : 'text-zinc-900 dark:text-zinc-100'
                          }`}
                        >
                          {file.title}
                        </h2>
                        <div className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400 min-w-0">
                          {file.mediaType === 'audio' ? (
                            <Music size={12} className="shrink-0" />
                          ) : (
                            <Film size={12} className="shrink-0" />
                          )}
                          <span className="truncate">{file.uploader}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums shrink-0">
                            {formatDuration(file.duration)}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums text-zinc-700 dark:text-zinc-300 shrink-0">
                            {formatMegabytes(file.sizeBytes)}
                          </span>
                        </div>
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        onOpenActionMenu({
                          id: file.id,
                          title: file.title,
                          uploader: file.uploader,
                          duration: file.duration,
                          thumbnail: file.thumbnail,
                          url: file.sourceUrl || '',
                          offlineFile: file,
                        })
                      }
                      aria-label={`More options for ${file.title}`}
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

      {/* PLAYLISTS TAB */}
      {section === 'playlists' && (
        <div className="space-y-5">
          <form onSubmit={handleCreatePlaylist} className="flex gap-2.5">
            <label htmlFor="new-playlist-name" className="sr-only">
              New playlist name
            </label>
            <input
              id="new-playlist-name"
              type="text"
              value={newPlaylistName}
              onChange={(e) => setNewPlaylistName(e.target.value)}
              placeholder="New playlist name..."
              className="h-12 min-w-0 flex-1 rounded-2xl border border-zinc-200 bg-white px-4 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-soft)] dark:border-zinc-800 dark:bg-zinc-900/90 dark:text-zinc-100 dark:placeholder:text-zinc-500"
            />
            <button
              type="submit"
              disabled={!newPlaylistName.trim()}
              className="inline-flex h-12 items-center gap-2 rounded-2xl bg-accent px-4 text-sm font-semibold disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <Plus size={16} />
              <span>Create</span>
            </button>
          </form>

          {playlists.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-3xl border border-zinc-200 bg-white px-6 py-14 text-center dark:border-zinc-800/80 dark:bg-zinc-900/40">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-zinc-100 text-zinc-500 dark:bg-zinc-800/80 dark:text-zinc-400">
                <ListMusic size={22} />
              </div>
              <h2 className="mt-4 text-base font-semibold text-zinc-900 dark:text-zinc-100">
                No playlists
              </h2>
              <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                Create a playlist above.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {playlists.map((playlist) => {
                const tracks = playlist.itemIds
                  .map((id) => fileById.get(id))
                  .filter((f): f is OfflineMediaFile => Boolean(f));
                const isManagingTracks = editingPlaylistId === playlist.id;

                return (
                  <article
                    key={playlist.id}
                    className="rounded-2xl border border-zinc-200 bg-white p-4 space-y-3 dark:border-zinc-800/80 dark:bg-zinc-900/60"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <h2 className="truncate text-base font-semibold text-zinc-900 dark:text-zinc-100">
                          {playlist.name}
                        </h2>
                        <p className="text-xs text-zinc-500 dark:text-zinc-400 font-mono tabular-nums">
                          {tracks.length} {tracks.length === 1 ? 'track' : 'tracks'}
                        </p>
                      </div>

                      <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                        <button
                          type="button"
                          disabled={tracks.length === 0}
                          onClick={() => onPlayPlaylist(playlist)}
                          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl bg-accent px-3.5 text-xs font-semibold disabled:opacity-40 whitespace-nowrap"
                        >
                          <Play size={14} fill="currentColor" />
                          <span>Play Playlist</span>
                        </button>

                        <button
                          type="button"
                          disabled={tracks.length === 0}
                          onClick={() => onShufflePlaylist(playlist)}
                          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-zinc-200 bg-zinc-100 px-3.5 text-xs font-semibold text-zinc-800 hover:bg-zinc-200 disabled:opacity-40 whitespace-nowrap dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700"
                        >
                          <Shuffle size={14} />
                          <span>Shuffle Playlist</span>
                        </button>

                        <button
                          type="button"
                          onClick={() =>
                            setEditingPlaylistId((prev) =>
                              prev === playlist.id ? null : playlist.id
                            )
                          }
                          aria-expanded={isManagingTracks}
                          className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border px-3 text-xs font-semibold transition-colors whitespace-nowrap ${
                            isManagingTracks
                              ? 'border-accent-soft bg-accent-soft text-accent'
                              : 'border-zinc-200 bg-zinc-50 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800'
                          }`}
                        >
                          <CheckSquare size={14} />
                          <span>Tracks</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => onDeletePlaylist(playlist.id)}
                          aria-label={`Delete playlist ${playlist.name}`}
                          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50 text-zinc-500 hover:bg-zinc-100 hover:text-red-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-red-400"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>

                    {isManagingTracks && (
                      <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 space-y-2 dark:border-zinc-800 dark:bg-zinc-950/80">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                            Select Tracks
                          </span>
                          <button
                            type="button"
                            onClick={() => setEditingPlaylistId(null)}
                            className="text-xs text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
                          >
                            Done
                          </button>
                        </div>
                        {libraryFiles.length === 0 ? (
                          <p className="text-xs text-zinc-500">No offline tracks yet.</p>
                        ) : (
                          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800/70">
                            {libraryFiles.map((file) => {
                              const checked = playlist.itemIds.includes(file.id);
                              const checkboxId = `pl-${playlist.id}-item-${file.id}`;
                              return (
                                <li key={file.id} className="py-1.5">
                                  <label
                                    htmlFor={checkboxId}
                                    className="flex min-h-[40px] cursor-pointer items-center gap-3 rounded-lg px-2 hover:bg-zinc-100 dark:hover:bg-zinc-900"
                                  >
                                    <input
                                      id={checkboxId}
                                      type="checkbox"
                                      checked={checked}
                                      onChange={() => onToggleFileInPlaylist(playlist.id, file.id)}
                                      style={{ accentColor: 'var(--accent)' }}
                                      className="h-4 w-4 rounded border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-900"
                                    />
                                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-900 dark:text-zinc-100">
                                      {file.title}
                                    </span>
                                    <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400 tabular-nums">
                                      {formatDuration(file.duration)}
                                    </span>
                                  </label>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </div>
                    )}

                    {tracks.length > 0 && (
                      <ul className="divide-y divide-zinc-200 dark:divide-zinc-800/70">
                        {tracks.map((track) => (
                          <li
                            key={track.id}
                            className="flex items-center justify-between gap-3 py-2"
                          >
                            <button
                              type="button"
                              onClick={() => onPlayOfflineFile(track)}
                              className="flex min-w-0 flex-1 items-center gap-3 text-left"
                            >
                              <ThumbnailArt
                                src={track.thumbnail}
                                alt={track.title}
                                mode={track.mediaType}
                                showMediaBadge
                                className="h-10 w-14 rounded-lg shrink-0"
                                iconSize={16}
                              />
                              <div className="min-w-0">
                                <p className="truncate text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                                  {track.title}
                                </p>
                                <p className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                                  {track.uploader} ·{' '}
                                  <span className="font-mono tabular-nums">
                                    {formatDuration(track.duration)}
                                  </span>
                                </p>
                              </div>
                            </button>
                            <button
                              type="button"
                              onClick={() => onToggleFileInPlaylist(playlist.id, track.id)}
                              aria-label={`Remove ${track.title} from ${playlist.name}`}
                              className="flex min-h-[40px] min-w-[40px] items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                            >
                              <X size={15} />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
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
