import { Download, FolderHeart, Search, Settings } from 'lucide-react';
import type { TabId } from '../types/media';

interface BottomTabBarProps {
  activeTab: TabId;
  onSelectTab: (tab: TabId) => void;
  activeDownloadCount: number;
}

const TABS: Array<{ id: TabId; label: string; icon: typeof Search }> = [
  { id: 'search', label: 'Search', icon: Search },
  { id: 'downloads', label: 'Downloads', icon: Download },
  { id: 'library', label: 'Library', icon: FolderHeart },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export function BottomTabBar({
  activeTab,
  onSelectTab,
  activeDownloadCount,
}: BottomTabBarProps) {
  return (
    <nav
      aria-label="Primary navigation"
      className="fixed bottom-0 left-0 right-0 z-40 border-t border-zinc-200 bg-white/92 backdrop-blur-xl pb-safe dark:border-zinc-800/80 dark:bg-zinc-950/92"
    >
      <div className="mx-auto grid h-16 max-w-5xl grid-cols-4 items-center px-2">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onSelectTab(tab.id)}
              aria-current={isActive ? 'page' : undefined}
              className={`relative flex min-h-[44px] flex-col items-center justify-center gap-1 rounded-xl px-2 py-1.5 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                isActive
                  ? 'text-accent'
                  : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200'
              }`}
            >
              <span className="relative flex items-center justify-center">
                <Icon size={21} strokeWidth={isActive ? 2.25 : 1.75} />
                {tab.id === 'downloads' && activeDownloadCount > 0 && (
                  <span
                    aria-label={`${activeDownloadCount} active downloads`}
                    className="absolute -right-3 -top-1.5 min-w-[16px] rounded-full bg-accent px-1 text-center font-mono text-[10px] font-semibold leading-4 tabular-nums"
                  >
                    {activeDownloadCount}
                  </span>
                )}
              </span>
              <span className="text-[11px] font-medium leading-none tracking-tight whitespace-nowrap shrink-0">
                {tab.label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
