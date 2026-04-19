'use client';
import dynamic from 'next/dynamic';
import { useTabs } from '@/lib/tabs-store';

const TerminalView = dynamic(
  () => import('./terminal').then((m) => m.TerminalView),
  { ssr: false },
);

export function TabsShell() {
  const { tabs, activeId, setActive, close } = useTabs();

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="h-9 border-b border-border bg-surface flex items-stretch overflow-x-auto">
        {tabs.length === 0 && (
          <div className="self-center px-3 text-muted text-xs">
            No open tabs — double-click a session in the sidebar to connect.
          </div>
        )}
        {tabs.map((t) => (
          <div
            key={t.tabId}
            onClick={() => setActive(t.tabId)}
            onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); close(t.tabId); } }}
            className={`group flex items-center gap-2 px-3 cursor-default select-none border-r border-border ${t.tabId === activeId ? 'bg-bg text-fg' : 'text-muted hover:text-fg'}`}
            role="tab"
            aria-selected={t.tabId === activeId}
          >
            {t.session.color && <span className="w-2 h-2 rounded-full" style={{ background: t.session.color }} />}
            <span className="truncate max-w-[200px]" title={`${t.session.username}@${t.session.host}`}>
              {t.session.name}
            </span>
            {t.status === 'connecting' && <span className="text-xs text-muted">…</span>}
            {t.status === 'error'      && <span className="text-xs text-danger">!</span>}
            {t.status === 'closed'     && <span className="text-xs text-muted">×</span>}
            <button
              type="button"
              aria-label="Close tab"
              onClick={(e) => { e.stopPropagation(); close(t.tabId); }}
              className="opacity-0 group-hover:opacity-100 hover:text-fg"
            >×</button>
          </div>
        ))}
      </div>
      <div className="flex-1 min-h-0 relative">
        {tabs.map((t) => (
          <TerminalView key={t.tabId} tab={t} visible={t.tabId === activeId} />
        ))}
      </div>
    </div>
  );
}
