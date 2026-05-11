'use client';
import { useState } from 'react';
import { FolderTree, Network, Terminal, X } from 'lucide-react';
import { useTabs } from '@/lib/tabs-store';
import { MdiArea } from './mdi-area';
import { ViewModeToolbar } from './view-mode-toolbar';
import { StatusDot } from './status-dot';

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
              {t.session.session_kind === 'ssh' && (
                <button
                  type="button"
                  draggable={false}
                  onClick={(e) => {
                    e.stopPropagation();
                    useTabs.getState().setForwardsOpen(t.tabId, !t.forwardsOpen);
                  }}
                  title={t.forwardsOpen ? 'Hide forwards pane' : 'Show forwards pane'}
                  aria-label={t.forwardsOpen ? 'Hide forwards pane' : 'Show forwards pane'}
                  aria-pressed={t.forwardsOpen}
                  className="icon-btn w-5 h-5"
                >
                  <Network size={12} />
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
        <ViewModeToolbar />
      </div>
      <div className="flex-1 min-h-0 relative">
        <MdiArea />
      </div>
    </div>
  );
}
