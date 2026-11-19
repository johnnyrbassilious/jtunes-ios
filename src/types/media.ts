export type TabId = 'search' | 'downloads' | 'library' | 'settings';

export type SearchFilterType = 'all' | 'videos' | 'audio' | 'podcasts' | 'radio';

export type MediaFormatMode = 'audio' | 'video';

export type VideoQuality = '1080' | '720' | '480' | '360';

export type LoopMode = 'off' | 'all' | 'one';

export type ThemeMode = 'light' | 'dark' | 'system';

export type AccentThemeId =
  | 'crimson'
  | 'violet'
  | 'emerald'
  | 'ocean'
  | 'amber'
  | 'monochrome';

export type SleepTimerOption = 'off' | '5' | '15' | '30' | '45' | '60' | 'end';

export interface AppSettings {
  backendUrl: string;
  themeMode: ThemeMode;
  accentTheme: AccentThemeId;
  defaultPlayMode: MediaFormatMode;
  defaultQuality: VideoQuality;
  autoplayRelated: boolean;
  swipeBetweenTabs: boolean;
}

export interface UserProfile {
  name: string;
  email: string;
  provider: 'local' | 'google' | 'apple';
  signedInAt: number;
}

export interface ListenHistoryEntry {
  id: string;
  title: string;
  uploader: string;
  mediaType: MediaFormatMode;
  timestamp: number;
}

export interface MediaItem {
  id: string;
  url: string;
  title: string;
  uploader: string;
  duration: number;
  thumbnail: string;
  platform?: string;
  mediaType?: MediaFormatMode;
  isLiveRadio?: boolean;
  directStreamUrl?: string;
}

export type DownloadStatus =
  | 'resolving'
  | 'downloading'
  | 'encoding'
  | 'saving'
  | 'completed'
  | 'error'
  | 'cancelled';

export interface ActiveDownload {
  id: string;
  item: MediaItem;
  mode: MediaFormatMode;
  quality: string;
  formatLabel: string;
  status: DownloadStatus;
  progress: number;
  receivedBytes: number;
  totalBytes: number | null;
  chunkIndex: number;
  error?: string;
  createdAt: number;
  offlineFileId?: string;
}

export interface OfflineMediaFile {
  id: string;
  title: string;
  uploader: string;
  duration: number;
  thumbnail: string;
  mediaType: 'video' | 'audio';
  formatLabel: string;
  sizeBytes: number;
  createdAt: number;
  blob: Blob;
  sourceUrl?: string;
}

export interface PlaylistRecord {
  id: string;
  name: string;
  createdAt: number;
  itemIds: string[];
}

export interface PlayableTrack {
  id: string;
  title: string;
  uploader: string;
  duration: number;
  thumbnail: string;
  url?: string;
  sourceUrl: string;
  streamUrl: string;
  directStreamUrl?: string;
  fallbackStreamUrl?: string;
  mode: MediaFormatMode;
  isOffline: boolean;
  isLiveRadio?: boolean;
  queueOrigin?: 'manual' | 'auto';
  offlineFileId?: string;
  offlineBlob?: Blob;
  blob?: Blob;
}
