'use client';
import dynamic from 'next/dynamic';
import { Terminal } from 'lucide-react';
import { useTabs, type Tab, type ViewMode } from '@/lib/tabs-store';
import { EmptyState } from './empty-state';
import { SftpPane } from './sftp-pane';

const TerminalView = dynamic(
  () => import('./terminal').then((m) => m.TerminalView),
  { ssr: false },
);

export function MdiArea() {
  const tabs      = useTabs((s) => s.tabs);
  const activeId  = useTabs((s) => s.activeId);
  const viewMode  = useTabs((s) => s.viewMode);
  const minimized = useTabs((s) => s.minimized);

  if (tabs.length === 0) {
    return (
      <EmptyState
        icon={Terminal}
        title="Ready to connect"
        body="Double-click a session in the sidebar, or create a new one to get started."
      />
    );
  }

  if (viewMode === 'tabs') {
    return <TabsLayout tabs={tabs} activeId={activeId} />;
  }

  // In non-tabs modes, minimized tabs are hidden from the layout.
  const visible = tabs.filter((t) => !minimized.has(t.tabId));

  if (viewMode === 'tile-h' || viewMode === 'tile-v') {
    return <TileFlexLayout tabs={visible} dir={viewMode === 'tile-h' ? 'col' : 'row'} />;
  }

  // tile-grid / cascade / auto handled in later tasks
  return <PlaceholderLayout mode={viewMode} />;
}

function TabsLayout({ tabs, activeId }: { tabs: Tab[]; activeId: string | null }) {
  return (
    <div className="absolute inset-0">
      {tabs.map((t) => {
        const active = t.tabId === activeId;
        return (
          <div
            key={t.tabId}
            className="absolute inset-0 flex"
            style={{
              visibility: active ? 'visible' : 'hidden',
              pointerEvents: active ? 'auto' : 'none',
            }}
            aria-hidden={!active}
          >
            {t.sftpOpen && t.session.session_kind === 'ssh' && <SftpPane tab={t} />}
            <div className="flex-1 min-h-0 relative">
              <TerminalView tab={t} visible={active} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TileFlexLayout({ tabs, dir }: { tabs: Tab[]; dir: 'row' | 'col' }) {
  const setActive = useTabs((s) => s.setActive);
  return (
    <div
      className={`absolute inset-0 flex ${dir === 'col' ? 'flex-col' : 'flex-row'} gap-px bg-border`}
    >
      {tabs.map((t) => (
        <div
          key={t.tabId}
          className="flex-1 min-w-0 min-h-0 bg-bg relative"
          onMouseDown={() => setActive(t.tabId)}
        >
          <TerminalView tab={t} visible={true} />
        </div>
      ))}
    </div>
  );
}

function PlaceholderLayout({ mode }: { mode: ViewMode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center text-muted text-xs">
      Layout for <span className="mx-1 font-mono">{mode}</span> not yet wired.
    </div>
  );
}
