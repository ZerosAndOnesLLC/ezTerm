'use client';
import { useEffect, useRef, useState } from 'react';
import { PanelLeftOpen } from 'lucide-react';
import { api } from '@/lib/tauri';
import { useTabs } from '@/lib/tabs-store';
import { toast } from '@/lib/toast';
import { SessionsSidebar } from './sessions-sidebar';
import { TabsShell } from './tabs-shell';
import { StatusBar } from './status-bar';
import { ToastRegion } from './toast-region';

const SIDEBAR_WIDTH_KEY = 'ezterm.sidebarWidth';
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 520;
const SIDEBAR_DEFAULT = 240;

export function MainShell({ onLock }: { onLock: () => void }) {
  const collapsed  = useTabs((s) => s.sidebarCollapsed);
  const toggle     = useTabs((s) => s.toggleSidebar);

  // Persist sidebar width across sessions. SSR-safe: start with default and
  // hydrate from localStorage in an effect so the initial render matches.
  const [width, setWidth] = useState<number>(SIDEBAR_DEFAULT);
  useEffect(() => {
    const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (Number.isFinite(stored) && stored >= SIDEBAR_MIN && stored <= SIDEBAR_MAX) {
      setWidth(stored);
    }
  }, []);
  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
  }, [width]);

  // WSL autodetect — runs on every unlock. The Rust command is idempotent
  // per-distro (only adds distros not already present as a session in the
  // WSL folder) and consolidates any stray duplicate folders into one, so
  // re-running is safe. The useRef guard blocks React 18 strict-mode's
  // double-mount from racing into two concurrent calls during dev.
  const autodetectRan = useRef(false);
  useEffect(() => {
    if (autodetectRan.current) return;
    autodetectRan.current = true;
    let cancelled = false;
    api.wslAutodetectSeed()
      .then((n) => {
        if (cancelled) return;
        if (n > 0) {
          toast.success('WSL detected', `Added ${n} session${n === 1 ? '' : 's'} to the WSL folder.`);
        } else {
          // Distinguish "ran and found nothing" from "errored silently" —
          // makes diagnosis possible when a user expects detection but
          // doesn't see the folder appear.
          toast.info('WSL autodetect', 'No distros detected (or all already present).');
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        toast.danger('WSL autodetect failed', String((e as { message?: string })?.message ?? e));
      });
    return () => { cancelled = true; };
  }, []);

  // Global Ctrl+B toggles the sidebar.
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

  // Sidebar resize via a 4px grab-strip on the right edge. Mouse events are
  // captured on window while dragging so fast mouse movement outside the
  // strip doesn't lose focus. The `resizingRef` flag suppresses pointer
  // events on the terminal area while dragging — prevents xterm from
  // stealing the mouse mid-resize.
  const resizingRef = useRef(false);
  const [resizing, setResizing] = useState(false);

  function startResize(e: React.MouseEvent) {
    e.preventDefault();
    resizingRef.current = true;
    setResizing(true);

    function onMove(ev: MouseEvent) {
      if (!resizingRef.current) return;
      const next = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, ev.clientX));
      setWidth(next);
    }
    function onUp() {
      resizingRef.current = false;
      setResizing(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

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
          <aside
            className="shrink-0 border-r border-border bg-surface min-h-0 flex flex-col relative"
            style={{ width }}
            aria-label="Sessions sidebar"
          >
            <SessionsSidebar />
            {/* Resize handle — a 4px hit zone at the right edge with a
                visible accent strip on hover/drag. Double-click resets
                the width to the default. */}
            <div
              onMouseDown={startResize}
              onDoubleClick={() => setWidth(SIDEBAR_DEFAULT)}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize sidebar"
              title="Drag to resize · Double-click to reset"
              className={`absolute top-0 right-0 h-full w-1 cursor-col-resize group ${
                resizing ? 'bg-accent/60' : 'hover:bg-accent/40'
              } transition-colors`}
            >
              <span
                className={`absolute inset-y-0 right-0 w-[2px] ${
                  resizing ? 'bg-accent' : 'bg-transparent group-hover:bg-accent/60'
                }`}
                aria-hidden
              />
            </div>
          </aside>
        )}
        <div
          className="flex-1 min-w-0 min-h-0"
          style={{ pointerEvents: resizing ? 'none' : undefined }}
        >
          <TabsShell />
        </div>
      </div>
      <StatusBar onLock={onLock} />
      <ToastRegion />
    </div>
  );
}
