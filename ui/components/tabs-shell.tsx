'use client';
import { useRef, useState } from 'react';
import { FolderTree, Network, Terminal, X } from 'lucide-react';
import { useTabs } from '@/lib/tabs-store';
import { beginPointerDrag } from '@/lib/pointer-drag';
import { MdiArea } from './mdi-area';
import { ViewModeToolbar } from './view-mode-toolbar';
import { StatusDot } from './status-dot';

type DropTarget = { index: number; side: 'left' | 'right' };

export function TabsShell() {
  const { tabs, activeId, setActive, close, reorder } = useTabs();

  // Pointer-event drag-reorder (NOT HTML5 DnD — WebKitGTK's native drag can
  // hold the pointer grab forever and freeze the app on Linux, see #109).
  // Both states only change on drag start/end and when the insertion point
  // crosses a tab midpoint — not once per pointermove tick.
  const [dragFromIndex, setDragFromIndex] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  const clearDrag = () => {
    setDragFromIndex(null);
    setDropTarget(null);
  };

  /** Tab-strip drop target under the pointer, by hit-testing tab rects.
   *  Past either end of the strip snaps to the first/last edge. */
  const dropTargetAt = (x: number): DropTarget | null => {
    const strip = stripRef.current;
    if (!strip) return null;
    const els = Array.from(strip.querySelectorAll<HTMLElement>('[data-tab-index]'));
    if (els.length === 0) return null;
    for (const el of els) {
      const rect = el.getBoundingClientRect();
      if (x < rect.left || x >= rect.right) continue;
      const index = Number(el.dataset.tabIndex);
      return { index, side: x < rect.left + rect.width / 2 ? 'left' : 'right' };
    }
    if (x < els[0].getBoundingClientRect().left) return { index: 0, side: 'left' };
    if (x >= els[els.length - 1].getBoundingClientRect().right) {
      return { index: els.length - 1, side: 'right' };
    }
    return null;
  };

  const startTabDrag = (e: React.PointerEvent, fromIndex: number) => {
    // Buttons inside the tab (close, panes) are clicks, never drag handles.
    if ((e.target as HTMLElement).closest('button')) return;
    beginPointerDrag(e, {
      onDragStart: () => setDragFromIndex(fromIndex),
      onDragMove: (x) => {
        const next = dropTargetAt(x);
        // Dropping onto the source tab is a no-op (see store.reorder).
        // Suppress the drop indicator there so users don't think a
        // move will happen when it won't.
        const shown = next && next.index === fromIndex ? null : next;
        setDropTarget((prev) =>
          prev?.index === shown?.index && prev?.side === shown?.side ? prev : shown,
        );
      },
      onDrop: (x) => {
        const target = dropTargetAt(x);
        if (!target) return;
        reorder(fromIndex, target.side === 'left' ? target.index : target.index + 1);
      },
      onEnd: clearDrag,
      scrollContainer: () => stripRef.current,
      axis: 'x',
    });
  };

  return (
    <div className="h-full flex flex-col min-h-0">
      <div ref={stripRef} className="h-8 border-b border-border bg-surface flex items-stretch overflow-x-auto">
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
              data-tab-index={index}
              onPointerDown={(e) => startTabDrag(e, index)}
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
              {(t.session.session_kind === 'ssh' || t.session.session_kind === 'wsl') && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    useTabs.getState().setSftpOpen(t.tabId, !t.sftpOpen);
                  }}
                  title={t.sftpOpen ? 'Hide file pane' : 'Show file pane'}
                  aria-label={t.sftpOpen ? 'Hide file pane' : 'Show file pane'}
                  aria-pressed={t.sftpOpen}
                  className="icon-btn w-5 h-5 ml-1"
                >
                  <FolderTree size={12} />
                </button>
              )}
              {t.session.session_kind === 'ssh' && (
                <button
                  type="button"
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
