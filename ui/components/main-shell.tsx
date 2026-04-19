'use client';
import { SessionsSidebar } from './sessions-sidebar';
import { TabsShell } from './tabs-shell';
import { StatusBar } from './status-bar';

export function MainShell({ onLock }: { onLock: () => void }) {
  return (
    <div className="h-full grid grid-rows-[1fr_auto] bg-bg text-fg">
      <div className="flex min-h-0">
        <aside className="w-60 shrink-0 border-r border-border bg-surface min-h-0 overflow-auto">
          <SessionsSidebar />
        </aside>
        <div className="flex-1 min-w-0 min-h-0">
          <TabsShell />
        </div>
      </div>
      <StatusBar onLock={onLock} />
    </div>
  );
}
