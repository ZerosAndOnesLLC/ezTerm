'use client';
import { FolderTree, Terminal, X } from 'lucide-react';
import { useTabs } from '@/lib/tabs-store';
import { MdiArea } from './mdi-area';
import { ViewModeToolbar } from './view-mode-toolbar';
import { StatusDot } from './status-dot';

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
              {t.session.session_kind === 'ssh' && (
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
              )}
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
        <ViewModeToolbar />
      </div>
      <div className="flex-1 min-h-0 relative">
        <MdiArea />
      </div>
    </div>
  );
}
