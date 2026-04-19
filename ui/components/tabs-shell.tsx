'use client';
export function TabsShell() {
  return (
    <div className="h-full flex flex-col">
      <div className="h-9 border-b border-border bg-surface text-muted text-xs flex items-center px-3">
        No open tabs — double-click a session to connect (Plan 2).
      </div>
      <div className="flex-1 flex items-center justify-center text-muted">
        Terminal area
      </div>
    </div>
  );
}
