'use client';
import dynamic from 'next/dynamic';
import { Terminal } from 'lucide-react';
import { useTabs } from '@/lib/tabs-store';
import { EmptyState } from './empty-state';
import { SftpPane } from './sftp-pane';

const TerminalView = dynamic(
  () => import('./terminal').then((m) => m.TerminalView),
  { ssr: false },
);

export function MdiArea() {
  const tabs     = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const viewMode = useTabs((s) => s.viewMode);

  if (tabs.length === 0) {
    return (
      <EmptyState
        icon={Terminal}
        title="Ready to connect"
        body="Double-click a session in the sidebar, or create a new one to get started."
      />
    );
  }

  // For now, every mode renders the legacy "tabs" layout. Subsequent tasks
  // add real strategies for tile-h/tile-v/tile-grid/cascade/auto.
  void viewMode;

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
