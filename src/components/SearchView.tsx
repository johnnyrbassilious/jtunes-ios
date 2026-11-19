import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowUpLeft,
  Clock,
  Film,
  Link2,
  Loader2,
  MoreVertical,
  Music,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import type { MediaFormatMode, MediaItem, SearchFilterType } from '../types/media';
import {
  fetchMediaInfo,
  fetchSearchSuggestions,
  searchMediaSmart,
} from '../utils/api';
import { formatDuration, isHttpUrl } from '../utils/formatters';
import {
  addSearchHistoryEntry,
  clearSearchHistory,
  getFuzzyLocalSuggestions,
  getSavedSearchHistory,
  removeSearchHistoryEntry,
} from '../utils/profileAndHistory';
import { usePlayer } from '../context/PlayerContext';
import type { ActionSheetTarget } from './MediaActionSheet';
import { ThumbnailArt } from './ThumbnailArt';

const SEARCH_FILTERS: Array<{ id: SearchFilterType; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'videos', label: 'Videos' },
  { id: 'audio', label: 'Audio' },
  { id: 'podcasts', label: 'Podcasts' },
  { id: 'radio', label: 'Radio' },
];

interface SearchViewProps {
  backendUrl: string;
  defaultPlayMode: MediaFormatMode;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  activeFilter: SearchFilterType;
  onActiveFilterChange: (filter: SearchFilterType) => void;
  searchResults: MediaItem[];
  libraryTitles?: readonly string[];
  onSearchResultsChange: (items: MediaItem[]) => void;
  onOpenActionMenu: (target: ActionSheetTarget) => void;
}

export function SearchView({
  backendUrl,
  defaultPlayMode,
  searchQuery,
  onSearchQueryChange,
  activeFilter,
  onActiveFilterChange,
  searchResults,
  libraryTitles = [],
  onSearchResultsChange,
  onOpenActionMenu,
}: SearchViewProps) {
  const { playTrack, currentTrack } = usePlayer();
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [correctedFrom, setCorrectedFrom] = useState<{
    original: string;
    resolved: string;
  } | null>(null);

  const [searchHistory, setSearchHistory] = useState<string[]>(() => getSavedSearchHistory());
  const [remoteSuggestions, setRemoteSuggestions] = useState<string[]>([]);
  const [isInputFocused, setIsInputFocused] = useState(false);

  const searchContainerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const searchSeqRef = useRef<number>(0);

  // Close suggestions dropdown on outside pointer down
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (
        searchContainerRef.current &&
        !searchContainerRef.current.contains(e.target as Node)
      ) {
        setIsInputFocused(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  // Debounced 220ms live autocomplete suggestions from /api/suggestions
  useEffect(() => {
    const trimmed = searchQuery.trim();
    if (!trimmed || isHttpUrl(trimmed)) {
      setRemoteSuggestions([]);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void fetchSearchSuggestions(backendUrl, trimmed).then((list) => {
        if (!cancelled) {
          setRemoteSuggestions(list);
        }
      });
    }, 220);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [backendUrl, searchQuery]);

  const localFuzzyMatches = useMemo(
    () => getFuzzyLocalSuggestions(searchQuery, searchHistory, libraryTitles),
    [searchQuery, searchHistory, libraryTitles]
  );

  const combinedSuggestions = useMemo(() => {
    const seen = new Set<string>();
    const list: Array<{ text: string; source: 'history' | 'suggestion' }> = [];
    const historySet = new Set(searchHistory.map((h) => h.toLowerCase()));

    for (const s of [...localFuzzyMatches, ...remoteSuggestions]) {
      const lower = s.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        list.push({
          text: s,
          source: historySet.has(lower) ? 'history' : 'suggestion',
        });
      }
    }
    return list.slice(0, 8);
  }, [localFuzzyMatches, remoteSuggestions, searchHistory]);

  const runSearchOrResolve = async (
    rawInput: string,
    filterToUse: SearchFilterType = activeFilter
  ) => {
    const trimmed = rawInput.trim();
    if (!trimmed) {
      setErrorMessage('Enter keywords or paste a link.');
      return;
    }

    searchSeqRef.current += 1;
    const requestSeq = searchSeqRef.current;

    setIsInputFocused(false);
    setIsLoading(true);
    setErrorMessage(null);
    setCorrectedFrom(null);

    try {
      if (isHttpUrl(trimmed)) {
        const resolved = await fetchMediaInfo(backendUrl, trimmed);
        if (searchSeqRef.current !== requestSeq) {
          return;
        }
        onSearchResultsChange([resolved]);
      } else {
        const updatedHistory = addSearchHistoryEntry(trimmed);
        setSearchHistory(updatedHistory);

        const localCandidates = getFuzzyLocalSuggestions(
          trimmed,
          updatedHistory,
          libraryTitles
        );
        const { items, correctedQuery } = await searchMediaSmart(
          backendUrl,
          trimmed,
          filterToUse,
          { localCandidates }
        );
        if (searchSeqRef.current !== requestSeq) {
          return;
        }
        onSearchResultsChange(items);
        if (correctedQuery) {
          setCorrectedFrom({ original: trimmed, resolved: correctedQuery });
        } else if (items.length === 0) {
          setErrorMessage('No results found.');
        }
      }
    } catch (err) {
      if (searchSeqRef.current !== requestSeq) {
        return;
      }
      setErrorMessage(
        err instanceof Error ? err.message : 'Unable to reach server.'
      );
    } finally {
      if (searchSeqRef.current === requestSeq) {
        setIsLoading(false);
      }
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void runSearchOrResolve(searchQuery, activeFilter);
  };

  const handleSelectFilter = (filterId: SearchFilterType) => {
    onActiveFilterChange(filterId);
    const trimmed = searchQuery.trim();
    if (trimmed && !isHttpUrl(trimmed)) {
      void runSearchOrResolve(trimmed, filterId);
    }
  };

  const handleClear = () => {
    onSearchQueryChange('');
    setErrorMessage(null);
    setCorrectedFrom(null);
    setRemoteSuggestions([]);
    inputRef.current?.focus();
  };

  const handleSelectSuggestion = (text: string) => {
    onSearchQueryChange(text);
    void runSearchOrResolve(text, activeFilter);
  };

  const handleFillSuggestion = (text: string) => {
    onSearchQueryChange(text);
    inputRef.current?.focus();
  };

  const handleRemoveHistoryItem = (item: string) => {
    setSearchHistory(removeSearchHistoryEntry(item));
  };

  const handleClearHistory = () => {
    setSearchHistory(clearSearchHistory());
  };

  const handleCardPlay = (item: MediaItem) => {
    setErrorMessage(null);
    const resolvedMode: MediaFormatMode =
      item.isLiveRadio || item.mediaType === 'audio' ? 'audio' : defaultPlayMode;

    playTrack({
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
      mode: resolvedMode,
      isOffline: false,
      queueOrigin: 'manual',
    });
  };

  const inputIsUrl = isHttpUrl(searchQuery);
  const trimmedQuery = searchQuery.trim();
  const showHistoryDropdown =
    isInputFocused && !trimmedQuery && searchHistory.length > 0;
  const showSuggestionDropdown =
    isInputFocused && Boolean(trimmedQuery) && !inputIsUrl && combinedSuggestions.length > 0;

  return (
    <section aria-label="Search" className="space-y-4">
      <h1 className="text-2xl font-bold tracking-tight text-[var(--text-primary)]">
        Search
      </h1>

      <div ref={searchContainerRef} className="relative">
        <form onSubmit={handleSubmit} className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
          <div className="relative w-full sm:flex-1 min-w-0">
            <label htmlFor="tubidy-search-input" className="sr-only">
              Search or paste URL
            </label>
            <div className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-[var(--text-secondary)]">
              {inputIsUrl ? <Link2 size={18} /> : <Search size={18} />}
            </div>
            <input
              ref={inputRef}
              id="tubidy-search-input"
              type="text"
              value={searchQuery}
              onFocus={() => setIsInputFocused(true)}
              onChange={(e) => {
                onSearchQueryChange(e.target.value);
                setIsInputFocused(true);
              }}
              placeholder="Search or paste URL..."
              autoComplete="off"
              spellCheck={false}
              className="h-12 w-full rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] pl-10 pr-11 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-secondary)]/70 focus:border-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-soft)]"
            />
            {searchQuery.length > 0 && (
              <button
                type="button"
                onClick={handleClear}
                aria-label="Clear search input"
                className="absolute inset-y-0 right-1 flex min-w-[44px] items-center justify-center rounded-xl text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                <X size={18} />
              </button>
            )}
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="inline-flex h-12 min-w-[120px] items-center justify-center gap-2 rounded-2xl bg-accent px-5 text-sm font-semibold transition-colors active:scale-[0.98] disabled:opacity-60 whitespace-nowrap shrink-0"
          >
            {isLoading ? (
              <>
                <Loader2 size={17} className="animate-spin" />
                <span>{inputIsUrl ? 'Resolving...' : 'Searching...'}</span>
              </>
            ) : (
              <span>Search</span>
            )}
          </button>
        </form>

        {/* YouTube Music Style Dropdown: Search History OR Live Suggestions */}
        {(showHistoryDropdown || showSuggestionDropdown) && (
          <div
            role="listbox"
            aria-label={showHistoryDropdown ? 'Recent searches' : 'Search suggestions'}
            className="absolute left-0 right-0 top-[calc(100%+6px)] z-30 overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-2xl backdrop-blur-xl animate-tubidy-fade"
          >
            {showHistoryDropdown && (
              <div>
                <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-3.5 py-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-secondary)]">
                    Recent Searches
                  </span>
                  <button
                    type="button"
                    onClick={handleClearHistory}
                    className="text-[11px] font-semibold text-accent hover:underline"
                  >
                    Clear history
                  </button>
                </div>
                <ul className="divide-y divide-[var(--border-subtle)]">
                  {searchHistory.map((item) => (
                    <li key={item} className="flex items-center gap-1 px-2 py-1">
                      <button
                        type="button"
                        onClick={() => handleSelectSuggestion(item)}
                        className="flex min-h-[42px] min-w-0 flex-1 items-center gap-3 rounded-xl px-2 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
                      >
                        <Clock size={15} className="shrink-0 text-[var(--text-secondary)]" />
                        <span className="truncate">{item}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleFillSuggestion(item)}
                        aria-label={`Fill search with ${item}`}
                        className="flex min-h-[38px] min-w-[38px] items-center justify-center rounded-xl text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
                      >
                        <ArrowUpLeft size={16} />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRemoveHistoryItem(item)}
                        aria-label={`Remove ${item} from history`}
                        className="flex min-h-[38px] min-w-[38px] items-center justify-center rounded-xl text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-red-500"
                      >
                        <X size={15} />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {showSuggestionDropdown && (
              <ul className="divide-y divide-[var(--border-subtle)]">
                {combinedSuggestions.map((entry) => (
                  <li key={entry.text} className="flex items-center gap-1 px-2 py-1">
                    <button
                      type="button"
                      onClick={() => handleSelectSuggestion(entry.text)}
                      className="flex min-h-[42px] min-w-0 flex-1 items-center gap-3 rounded-xl px-2 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
                    >
                      {entry.source === 'history' ? (
                        <Clock size={15} className="shrink-0 text-[var(--text-secondary)]" />
                      ) : (
                        <Search size={15} className="shrink-0 text-[var(--text-secondary)]" />
                      )}
                      <span className="truncate">{entry.text}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleFillSuggestion(entry.text)}
                      aria-label={`Fill search with ${entry.text}`}
                      className="flex min-h-[38px] min-w-[38px] items-center justify-center rounded-xl text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
                    >
                      <ArrowUpLeft size={16} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Horizontal Filter Tabs */}
      <div
        role="tablist"
        aria-label="Search filters"
        className="flex items-center gap-2 overflow-x-auto pb-1 no-scrollbar"
      >
        {SEARCH_FILTERS.map((filter) => {
          const isActive = activeFilter === filter.id;
          return (
            <button
              key={filter.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => handleSelectFilter(filter.id)}
              className={`min-h-[36px] shrink-0 rounded-xl border px-3.5 text-xs font-semibold transition-all duration-200 whitespace-nowrap ${
                isActive
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              {filter.label}
            </button>
          );
        })}
      </div>

      {correctedFrom && (
        <div className="flex items-center justify-between gap-2 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3.5 py-2.5 text-xs text-[var(--text-secondary)]">
          <div className="flex items-center gap-2 min-w-0">
            <Sparkles size={14} className="shrink-0 text-accent" />
            <span className="truncate">
              Showing results for{' '}
              <strong className="font-semibold text-[var(--text-primary)]">
                {correctedFrom.resolved}
              </strong>
            </span>
          </div>
          <button
            type="button"
            onClick={() => setCorrectedFrom(null)}
            aria-label="Dismiss spelling notice"
            className="shrink-0 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {errorMessage && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-2xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-950/40 dark:text-red-200"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <AlertCircle size={18} className="shrink-0 text-red-500 dark:text-red-400" />
            <span className="truncate">{errorMessage}</span>
          </div>
          <button
            type="button"
            onClick={() => setErrorMessage(null)}
            aria-label="Dismiss error"
            className="flex min-h-[36px] min-w-[36px] items-center justify-center rounded-lg text-red-500 hover:bg-red-100 dark:text-red-300 dark:hover:bg-red-900/50 dark:hover:text-white shrink-0"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {isLoading ? (
        <div
          aria-live="polite"
          className="flex flex-col items-center justify-center rounded-3xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-6 py-16 text-center"
        >
          <Loader2 size={28} className="animate-spin text-accent" />
          <p className="mt-3 text-sm font-medium text-[var(--text-primary)]">
            {inputIsUrl ? 'Resolving link...' : 'Searching...'}
          </p>
        </div>
      ) : searchResults.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-3xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-6 py-16 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--bg-elevated)] text-[var(--text-secondary)]">
            <Search size={22} />
          </div>
          <h2 className="mt-4 text-base font-semibold text-[var(--text-primary)]">
            No results
          </h2>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            Search or paste a URL above.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
          {searchResults.map((item) => {
            const itemMediaMode: MediaFormatMode =
              item.isLiveRadio || item.mediaType === 'audio' ? 'audio' : 'video';
            const isActiveTrack = currentTrack?.id === item.id;

            return (
              <article
                key={item.id}
                className={`flex items-center gap-2 rounded-2xl border p-2.5 transition-colors duration-200 ${
                  isActiveTrack
                    ? 'border-accent-soft bg-accent-soft/40'
                    : 'border-[var(--border-subtle)] bg-[var(--bg-surface)] hover:border-[var(--accent-border)]'
                }`}
              >
                <button
                  type="button"
                  onClick={() => handleCardPlay(item)}
                  aria-label={`Play ${item.title}`}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                >
                  <ThumbnailArt
                    src={item.thumbnail}
                    alt={item.title}
                    mode={itemMediaMode}
                    showMediaBadge
                    className="h-14 w-20 rounded-xl shrink-0"
                  />
                  <div className="min-w-0 flex-1 space-y-1">
                    <h2
                      className={`line-clamp-1 text-sm font-semibold ${
                        isActiveTrack ? 'text-accent' : 'text-[var(--text-primary)]'
                      }`}
                    >
                      {item.title}
                    </h2>
                    <div className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] min-w-0">
                      {itemMediaMode === 'audio' ? (
                        <Music size={12} className="shrink-0" />
                      ) : (
                        <Film size={12} className="shrink-0" />
                      )}
                      <span className="truncate">{item.uploader}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums text-[var(--text-primary)]/80 shrink-0">
                        {item.isLiveRadio && item.duration === 0
                          ? 'LIVE'
                          : formatDuration(item.duration)}
                      </span>
                    </div>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() =>
                    onOpenActionMenu({
                      id: item.id,
                      title: item.title,
                      uploader: item.uploader,
                      duration: item.duration,
                      thumbnail: item.thumbnail,
                      url: item.url,
                      mediaItem: item,
                    })
                  }
                  aria-label={`More options for ${item.title}`}
                  className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] shrink-0"
                >
                  <MoreVertical size={18} />
                </button>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
