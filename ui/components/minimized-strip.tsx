'use client';
import { AlertCircle } from 'lucide-react';
import { useTabs, type TabStatus } from '@/lib/tabs-store';

function StatusDot({ status }: { status: TabStatus }) {
  if (status === 'error') {
    return <AlertCircle size={10} className="text-danger shrink-0" aria-label="error" />;
  }
  let cls = 'bg-muted';
  if (status === 'connected') cls = 'bg-success';
  else if (status === 'connecting') cls = 'bg-warning animate-pulse';
  else if (status === 'closed') cls = 'bg-muted/60';
  return <span className={`w-1.5 h-1.5 rounded-full ${cls} shrink-0`} aria-label={status} />;
}

export function MinimizedStrip() {
  const tabs      = useTabs((s) => s.tabs);
  const minimized = useTabs((s) => s.minimized);
  const restore   = useTabs((s) => s.restore);
  const setActive = useTabs((s) => s.setActive);

  const items = tabs.filter((t) => minimized.has(t.tabId));
  if (items.length === 0) return null;

  return (
    <div
      className="absolute left-0 right-0 bottom-0 h-7 border-t border-border bg-surface flex items-center gap-1 px-2 overflow-x-auto"
      role="toolbar"
      aria-label="Minimized windows"
    >
      {items.map((t) => (
        <button
          key={t.tabId}
          type="button"
          onClick={() => { restore(t.tabId); setActive(t.tabId); }}
          title={`Restore ${t.session.name}`}
          className="flex items-center gap-1.5 px-2 h-5 text-xs rounded border border-border bg-bg hover:bg-surface2 focus-ring"
        >
          <StatusDot status={t.status} />
          <span className="truncate max-w-[160px]">{t.session.name}</span>
        </button>
      ))}
    </div>
  );
}
