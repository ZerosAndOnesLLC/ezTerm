'use client';
import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, FolderTree, Network, Terminal, X } from 'lucide-react';
import { useTabs } from '@/lib/tabs-store';
import { beginPointerDrag } from '@/lib/pointer-drag';
import { MdiArea } from './mdi-area';
import { ViewModeToolbar } from './view-mode-toolbar';
import { StatusDot } from './status-dot';

type DropTarget = { index: number; side: 'left' | 'right' };

/** Tab width bounds (px). Applied as inline style — Tailwind can't JIT
 *  arbitrary-value classes built from template strings. The floor must
 *  clear an SSH tab's fixed chrome (padding, dots, three icon buttons,
 *  gaps: ~140 px) with room for a few characters of name. */
const TAB_MIN_W = 180;
const TAB_MAX_W = 260;

export function TabsShell() {
  // Slice subscriptions — a whole-store subscription would re-render the
  // strip on every SFTP-pane resize frame and cascade-drag frame.
  const tabs      = useTabs((s) => s.tabs);
  const activeId  = useTabs((s) => s.activeId);
  const setActive = useTabs((s) => s.setActive);
  const close     = useTabs((s) => s.close);
  const reorder   = useTabs((s) => s.reorder);

  // Pointer-event drag-reorder (NOT HTML5 DnD — WebKitGTK's native drag can
  // hold the pointer grab forever and freeze the app on Linux, see #109).
  // Both states only change on drag start/end and when the insertion point
  // crosses a tab midpoint — not once per pointermove tick. The dragged tab
  // is tracked by stable tabId, not index — a chorded middle-click can
  // close a tab mid-drag and shift every index.
  const [dragTabId, setDragTabId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  // Tear down an in-flight drag if this component ever unmounts — the
  // helper's window listeners would otherwise outlive it.
  const dragCancelRef = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => dragCancelRef.current?.(), []);

  const clearDrag = () => {
    setDragTabId(null);
    setDropTarget(null);
  };

  // Overflow chevrons. Tabs shrink to TAB_MIN_W before the strip starts
  // scrolling; once it does, the scrollbar is hidden (32 px strip) and
  // these buttons plus wheel / drag auto-scroll / scrollIntoView move it.
  // Only written when a boolean actually flips, so scroll events at 60 Hz
  // don't re-render the strip.
  const [overflow, setOverflow] = useState({ left: false, right: false });
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const measure = () => {
      const left = strip.scrollLeft > 0;
      const right = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1;
      setOverflow((cur) => (cur.left === left && cur.right === right ? cur : { left, right }));
    };
    // ResizeObserver delivers an initial observation on observe(), which
    // covers the mount-time measurement. Tabs being added/removed changes
    // the strip's scrollWidth, not its box, so re-measure on count too.
    const ro = new ResizeObserver(measure);
    ro.observe(strip);
    for (const el of strip.children) ro.observe(el);
    strip.addEventListener('scroll', measure, { passive: true });
    return () => {
      ro.disconnect();
      strip.removeEventListener('scroll', measure);
    };
  }, [tabs.length]);

  // Keep the active tab visible — a newly opened tab becomes active and
  // lands at the far right of an overflowing strip, and keyboard tab
  // switching would otherwise move focus off-screen. Keyed on activeId
  // only: closing a non-active tab must not yank a manually scrolled
  // strip back to the active one.
  useEffect(() => {
    if (!activeId) return;
    const el = stripRef.current?.querySelector<HTMLElement>(
      `[data-tab-id="${CSS.escape(activeId)}"]`,
    );
    el?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [activeId]);

  const scrollBy = (dir: -1 | 1) => {
    const strip = stripRef.current;
    if (!strip) return;
    strip.scrollBy({ left: dir * Math.max(120, strip.clientWidth * 0.6), behavior: 'smooth' });
  };

  /** Vertical wheel over the strip scrolls it horizontally — there is no
   *  vertical axis to compete with, and a horizontal-only scroller is
   *  otherwise unreachable from a plain mouse wheel. */
  const onWheel = (e: React.WheelEvent) => {
    const strip = stripRef.current;
    if (!strip || e.deltaX !== 0 || e.deltaY === 0) return;
    strip.scrollLeft += e.deltaY;
  };

  /** Pointer must stay within this band above/below the strip for a drop
   *  target to resolve — releasing further away aborts the drag, matching
   *  the old HTML5 drop-outside-is-a-no-op behavior. */
  const STRIP_Y_TOLERANCE_PX = 24;

  /** Live index of a tab — resolved at use time, never captured, so a tab
   *  closing mid-drag can't make us reorder the wrong one. */
  const tabIndexOf = (id: string) =>
    useTabs.getState().tabs.findIndex((tb) => tb.tabId === id);

  /** Tab-strip drop target under the pointer, by hit-testing tab rects.
   *  Past either horizontal end of the strip snaps to the first/last edge;
   *  vertically outside the strip (plus tolerance) is no target at all.
   *  The pointer x is clamped to the strip's visible box first: tabs
   *  scrolled out of view still have rects, and a pointer over the chevron
   *  zone must resolve to the visible edge tab, not a hidden one. */
  const dropTargetAt = (px: number, y: number): DropTarget | null => {
    const strip = stripRef.current;
    if (!strip) return null;
    const stripRect = strip.getBoundingClientRect();
    if (
      y < stripRect.top - STRIP_Y_TOLERANCE_PX ||
      y > stripRect.bottom + STRIP_Y_TOLERANCE_PX
    ) {
      return null;
    }
    const x = Math.max(stripRect.left, Math.min(stripRect.right - 1, px));
    const els = Array.from(strip.querySelectorAll<HTMLElement>('[data-tab-index]'));
    if (els.length === 0) return null;
    let firstLeft = Infinity;
    let lastRight = -Infinity;
    for (const el of els) {
      const rect = el.getBoundingClientRect();
      firstLeft = Math.min(firstLeft, rect.left);
      lastRight = Math.max(lastRight, rect.right);
      if (x < rect.left || x >= rect.right) continue;
      const index = Number(el.dataset.tabIndex);
      return { index, side: x < rect.left + rect.width / 2 ? 'left' : 'right' };
    }
    if (x < firstLeft) return { index: 0, side: 'left' };
    if (x >= lastRight) return { index: els.length - 1, side: 'right' };
    return null;
  };

  const startTabDrag = (e: React.PointerEvent, tabId: string) => {
    dragCancelRef.current = beginPointerDrag(e, {
      onDragStart: () => setDragTabId(tabId),
      onDragMove: (x, y) => {
        const next = dropTargetAt(x, y);
        // Dropping onto the source tab is a no-op (see store.reorder).
        // Suppress the drop indicator there so users don't think a
        // move will happen when it won't.
        const shown = next && next.index === tabIndexOf(tabId) ? null : next;
        setDropTarget((prev) =>
          prev?.index === shown?.index && prev?.side === shown?.side ? prev : shown,
        );
      },
      onDrop: (x, y) => {
        const from = tabIndexOf(tabId);
        const target = dropTargetAt(x, y);
        if (from < 0 || !target) return;
        reorder(from, target.side === 'left' ? target.index : target.index + 1);
      },
      onEnd: clearDrag,
      scrollContainer: () => stripRef.current,
      axis: 'x',
    });
  };

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="h-8 border-b border-border bg-surface flex items-stretch">
        {overflow.left && (
          <button
            type="button"
            onClick={() => scrollBy(-1)}
            aria-label="Scroll tabs left"
            title="Scroll tabs left"
            className="w-6 shrink-0 flex items-center justify-center border-r border-border text-muted hover:text-fg hover:bg-surface2/40 focus-ring"
          >
            <ChevronLeft size={14} />
          </button>
        )}
        <div
          ref={stripRef}
          onWheel={onWheel}
          role="tablist"
          className="flex-1 min-w-0 flex items-stretch overflow-x-auto scrollbar-none"
        >
          {tabs.length === 0 && (
            <div className="self-center px-3 text-muted text-xs flex items-center gap-2 whitespace-nowrap">
              <Terminal size={12} />
              <span>No open tabs — double-click a session in the sidebar</span>
            </div>
          )}
          {tabs.map((t, index) => {
            const on = t.tabId === activeId;
            const dragging = dragTabId === t.tabId;
            const showLeftIndicator = dropTarget?.index === index && dropTarget.side === 'left';
            const showRightIndicator = dropTarget?.index === index && dropTarget.side === 'right';
            return (
              <div
                key={t.tabId}
                data-tab-index={index}
                data-tab-id={t.tabId}
                onPointerDown={(e) => startTabDrag(e, t.tabId)}
                onClick={() => setActive(t.tabId)}
                onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); close(t.tabId); } }}
                // Natural width up to TAB_MAX_W, then shrink down to TAB_MIN_W
                // as the strip fills; past that the strip scrolls. The name
                // span is the only shrinkable child (truncate => overflow
                // hidden => min-width 0); every icon is shrink-0.
                style={{ minWidth: TAB_MIN_W, maxWidth: TAB_MAX_W }}
                className={`group relative flex items-center gap-2 px-3 overflow-hidden cursor-grab active:cursor-grabbing select-none border-r border-border ${
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
                  className="truncate min-w-0"
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
                    className="icon-btn w-5 h-5 ml-1 shrink-0"
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
                    className="icon-btn w-5 h-5 shrink-0"
                  >
                    <Network size={12} />
                  </button>
                )}
                <button
                  type="button"
                  aria-label="Close tab"
                  onClick={(e) => { e.stopPropagation(); close(t.tabId); }}
                  className={`icon-btn w-5 h-5 shrink-0 ${on ? '' : 'opacity-0 group-hover:opacity-100'}`}
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>
        {overflow.right && (
          <button
            type="button"
            onClick={() => scrollBy(1)}
            aria-label="Scroll tabs right"
            title="Scroll tabs right"
            className="w-6 shrink-0 flex items-center justify-center border-l border-border text-muted hover:text-fg hover:bg-surface2/40 focus-ring"
          >
            <ChevronRight size={14} />
          </button>
        )}
        <ViewModeToolbar />
      </div>
      <div className="flex-1 min-h-0 relative">
        <MdiArea />
      </div>
    </div>
  );
}
