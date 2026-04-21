'use client';
import { useEffect } from 'react';
import { PanelLeftOpen } from 'lucide-react';
import { useTabs } from '@/lib/tabs-store';
import { SessionsSidebar } from './sessions-sidebar';
import { TabsShell } from './tabs-shell';
import { StatusBar } from './status-bar';
import { ToastRegion } from './toast-region';

export function MainShell({ onLock }: { onLock: () => void }) {
  const collapsed  = useTabs((s) => s.sidebarCollapsed);
  const toggle     = useTabs((s) => s.toggleSidebar);

  // Global Ctrl+B toggles the sidebar. Ctrl+Shift+B reserved for future.
  // Not scoped by target — the hotkey works when xterm has focus too,
  // which is where the user spends most of their time.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggle();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);

  return (
    <div className="h-full grid grid-rows-[1fr_auto] bg-bg text-fg">
      <div className="flex min-h-0">
        {collapsed ? (
          <button
            type="button"
            onClick={toggle}
            aria-label="Show sessions sidebar"
            title="Show sessions (Ctrl+B)"
            className="w-6 shrink-0 border-r border-border bg-surface flex items-center justify-center text-muted hover:text-fg hover:bg-surface2 focus-ring"
          >
            <PanelLeftOpen size={14} />
          </button>
        ) : (
          <aside className="w-60 shrink-0 border-r border-border bg-surface min-h-0 flex flex-col">
            <SessionsSidebar />
          </aside>
        )}
        <div className="flex-1 min-w-0 min-h-0">
          <TabsShell />
        </div>
      </div>
      <StatusBar onLock={onLock} />
      <ToastRegion />
    </div>
  );
}
