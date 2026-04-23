'use client';
import dynamic from 'next/dynamic';
import { useState } from 'react';
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
  const { tabs, activeId, setActive, close, reorder } = useTabs();

  // Drag-reorder state. Both only change on drag start/end and when the
  // insertion point crosses a tab midpoint — not once per dragover tick.
  const [dragFromIndex, setDragFromIndex] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<{ index: number; side: 'left' | 'right' } | null>(null);

  const clearDrag = () => {
    setDragFromIndex(null);
    setDropTarget(null);
  };

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="h-8 border-b border-border bg-surface flex items-stretch overflow-x-auto">
        {tabs.length === 0 && (
          <div className="self-center px-3 text-muted text-xs flex items-center gap-2">
            <Terminal size={12} />
            <span>No open tabs — double-click a session in the sidebar</span>
          </div>
        )}
        {tabs.map((t, index) => {
          const on = t.tabId === activeId;
          const dragging = dragFromIndex === index;
          const showLeftIndicator = dropTarget?.index === index && dropTarget.side === 'left';
          const showRightIndicator = dropTarget?.index === index && dropTarget.side === 'right';
          return (
            <div
              key={t.tabId}
              draggable
              onDragStart={(e) => {
                setDragFromIndex(index);
                e.dataTransfer.effectAllowed = 'move';
                // Blank drag image — our opacity + accent bar carry the feedback.
                // 1x1 transparent GIF avoids the OS "ghost tab" that looks janky
                // over the existing visual cues.
                const img = new Image();
                img.src =
                  'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
                e.dataTransfer.setDragImage(img, 0, 0);
              }}
              onDragOver={(e) => {
                if (dragFromIndex === null) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                // Dropping onto the source tab is a no-op (see store.reorder).
                // Suppress the drop indicator there so users don't think a
                // move will happen when it won't.
                if (dragFromIndex === index) return;
                const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                const side = e.clientX < rect.left + rect.width / 2 ? 'left' : 'right';
                setDropTarget((prev) =>
                  prev?.index === index && prev.side === side ? prev : { index, side },
                );
              }}
              onDragLeave={(e) => {
                // Only clear if we're leaving this tab, not entering a child.
                const related = e.relatedTarget as Node | null;
                if (related && (e.currentTarget as HTMLDivElement).contains(related)) return;
                setDropTarget((prev) => (prev?.index === index ? null : prev));
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragFromIndex === null) return;
                const from = dragFromIndex;
                const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                const side = e.clientX < rect.left + rect.width / 2 ? 'left' : 'right';
                const to = side === 'left' ? index : index + 1;
                reorder(from, to);
                clearDrag();
              }}
              onDragEnd={clearDrag}
              onClick={() => setActive(t.tabId)}
              onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); close(t.tabId); } }}
              className={`group relative flex items-center gap-2 px-3 cursor-grab active:cursor-grabbing select-none border-r border-border ${
                on ? 'bg-bg text-fg' : 'text-muted hover:text-fg hover:bg-surface2/40'
              } ${dragging ? 'opacity-50' : ''}`}
              role="tab"
              aria-selected={on}
            >
              {showLeftIndicator && (
                <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-accent z-10" aria-hidden />
              )}
              {showRightIndicator && (
                <span className="absolute right-0 top-0 bottom-0 w-0.5 bg-accent z-10" aria-hidden />
              )}
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
              {t.session.session_kind === 'ssh' && (
                <button
                  type="button"
                  draggable={false}
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
                draggable={false}
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
                {t.sftpOpen && t.session.session_kind === 'ssh' && <SftpPane tab={t} />}
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
