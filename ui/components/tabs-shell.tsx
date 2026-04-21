'use client';
import dynamic from 'next/dynamic';
import { AlertCircle, FolderTree, Terminal, X } from 'lucide-react';
import { useTabs, type TabStatus } from '@/lib/tabs-store';
import { EmptyState } from './empty-state';
import { SftpPane } from './sftp-pane';

const TerminalView = dynamic(
  () => import('./terminal').then((m) => m.TerminalView),
  { ssr: false },
);

function StatusDot({ status }: { status: TabStatus }) {
  if (status === 'error') {
    return <AlertCircle size={11} className="text-danger shrink-0" aria-label="error" />;
  }
  let cls = 'bg-muted';
  if (status === 'connected') cls = 'bg-success';
  else if (status === 'connecting') cls = 'bg-warning animate-pulse';
  else if (status === 'closed') cls = 'bg-muted/60';
  return (
    <span
      className={`w-1.5 h-1.5 rounded-full ${cls} shrink-0`}
      aria-label={status}
    />
  );
}

export function TabsShell() {
  const { tabs, activeId, setActive, close } = useTabs();

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="h-8 border-b border-border bg-surface flex items-stretch overflow-x-auto">
        {tabs.length === 0 && (
          <div className="self-center px-3 text-muted text-xs flex items-center gap-2">
            <Terminal size={12} />
            <span>No open tabs — double-click a session in the sidebar</span>
          </div>
        )}
        {tabs.map((t) => {
          const on = t.tabId === activeId;
          return (
            <div
              key={t.tabId}
              onClick={() => setActive(t.tabId)}
              onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); close(t.tabId); } }}
              className={`group relative flex items-center gap-2 px-3 cursor-default select-none border-r border-border ${
                on ? 'bg-bg text-fg' : 'text-muted hover:text-fg hover:bg-surface2/40'
              }`}
              role="tab"
              aria-selected={on}
            >
              {/* Active tab accent underline (design-system §6.4). */}
              {on && <span className="absolute left-0 right-0 bottom-0 h-0.5 bg-accent" aria-hidden />}
              {t.session.color && (
                <span
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{ background: t.session.color }}
                  aria-hidden
                />
              )}
              <StatusDot status={t.status} />
              <span
                className="truncate max-w-[200px]"
                title={`${t.session.username}@${t.session.host} (${t.status})${
                  t.errorMessage ? `\n${t.errorMessage}` : ''
                }`}
              >
                {t.session.name}
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  useTabs.getState().setSftpOpen(t.tabId, !t.sftpOpen);
                }}
                title={t.sftpOpen ? 'Hide SFTP pane' : 'Show SFTP pane'}
                aria-label={t.sftpOpen ? 'Hide SFTP pane' : 'Show SFTP pane'}
                aria-pressed={t.sftpOpen}
                className="icon-btn w-5 h-5 ml-1"
              >
                <FolderTree size={12} />
              </button>
              <button
                type="button"
                aria-label="Close tab"
                onClick={(e) => { e.stopPropagation(); close(t.tabId); }}
                className={`icon-btn w-5 h-5 ${on ? '' : 'opacity-0 group-hover:opacity-100'}`}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>
      <div className="flex-1 min-h-0 relative">
        {tabs.length === 0 ? (
          <EmptyState
            icon={Terminal}
            title="Ready to connect"
            body="Double-click a session in the sidebar, or create a new one to get started."
          />
        ) : (
          tabs.map((t) => {
            const active = t.tabId === activeId;
            // Inactive tabs stay laid out (real non-zero dimensions) and are
            // just hidden via visibility. Using display:none would give
            // xterm.js a zero-sized container, leaving its render service
            // half-initialised and later viewport syncs crash with
            // "Cannot read properties of undefined (reading 'dimensions')".
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
                {t.sftpOpen && <SftpPane tab={t} />}
                <div className="flex-1 min-h-0 relative">
                  <TerminalView tab={t} visible={active} />
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
