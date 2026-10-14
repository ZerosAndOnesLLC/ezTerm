'use client';
import { useEffect, useRef, useState } from 'react';
import { PanelLeftOpen } from 'lucide-react';
import { api } from '@/lib/tauri';
import { useTabs } from '@/lib/tabs-store';
import { toast } from '@/lib/toast';
import { maybeAutoCheck, type UpdateInfo } from '@/lib/updater';
import { SessionsSidebar } from './sessions-sidebar';
import { TabsShell } from './tabs-shell';
import { StatusBar } from './status-bar';
import { ToastRegion } from './toast-region';
import { UpdateDialog } from './update-dialog';
import { ResizeHandle } from './resize-handle';
import { FORWARDS_PANE_W, TERMINAL_MIN_W } from '@/lib/layout';

/** Space the sidebar must leave free: a usable terminal plus whichever
 *  side panes the active tab has docked. Read at drag start. */
function sidebarReserve(): number {
  const s = useTabs.getState();
  const active = s.tabs.find((t) => t.tabId === s.activeId);
  return TERMINAL_MIN_W
    + (active?.sftpOpen ? s.sftpPaneWidth : 0)
    + (active?.forwardsOpen ? FORWARDS_PANE_W : 0);
}

const SIDEBAR_WIDTH_KEY = 'ezterm.sidebarWidth';
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 520;
const SIDEBAR_DEFAULT = 240;

export function MainShell({ onLock }: { onLock: () => void }) {
  const collapsed  = useTabs((s) => s.sidebarCollapsed);
  const toggle     = useTabs((s) => s.toggleSidebar);

  // Persist sidebar width across sessions. We hydrate via the lazy
  // useState initialiser so the first render already shows the correct
  // width (avoids a one-frame jump and satisfies
  // react-hooks/set-state-in-effect). SSR-safe: `window` check for the
  // initial render when localStorage is absent.
  const [width, setWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return SIDEBAR_DEFAULT;
    const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (Number.isFinite(stored) && stored >= SIDEBAR_MIN && stored <= SIDEBAR_MAX) {
      return stored;
    }
    return SIDEBAR_DEFAULT;
  });
  const persistWidth = (w: number) => {
    try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(w)); } catch { /* disabled */ }
  };

  // Block ALL in-page native drag initiation. WebKitGTK's HTML5 drag can
  // take the pointer grab and never release it, hard-freezing the app on
  // Linux (#109) — and anchors and selected text are natively draggable
  // even with no `draggable` attribute anywhere. The app has no legitimate
  // in-page drag sources (tab/tree reordering uses pointer events, see
  // lib/pointer-drag.ts), and OS file drops into the SFTP pane are
  // unaffected: external drags never fire an in-page `dragstart`.
  useEffect(() => {
    const block = (e: DragEvent) => e.preventDefault();
    window.addEventListener('dragstart', block);
    return () => window.removeEventListener('dragstart', block);
  }, []);

  // Auto-update check — cadence-gated (30d default) so we don't hit the
  // GitHub Releases endpoint on every unlock. If an update is waiting,
  // surface a prompt via UpdateDialog; the user can always dismiss and
  // install later from the sidebar menu.
  const [autoUpdate, setAutoUpdate] = useState<UpdateInfo | null>(null);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const autoUpdateChecked = useRef(false);
  useEffect(() => {
    if (autoUpdateChecked.current) return;
    autoUpdateChecked.current = true;
    (async () => {
      const u = await maybeAutoCheck();
      if (u) {
        setAutoUpdate(u);
        setUpdateDialogOpen(true);
      }
    })();
  }, []);

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

  // Local Shells autodetect — runs on every platform. On Unix it seeds
  // entries from /etc/shells; on Windows it seeds cmd, powershell, and
  // pwsh-if-installed alongside the existing WSL folder. Same idempotent
  // semantics as the WSL flow above.
  const localShellsAutodetectRan = useRef(false);
  useEffect(() => {
    if (localShellsAutodetectRan.current) return;
    localShellsAutodetectRan.current = true;
    let cancelled = false;
    api.localShellsAutodetectSeed()
      .then((n) => {
        if (cancelled) return;
        if (n > 0) {
          toast.success(
            'Local shells detected',
            `Added ${n} session${n === 1 ? '' : 's'} to the Local Shells folder.`,
          );
        } else {
          toast.info(
            'Local shells autodetect',
            'No new shells detected (or all already present).',
          );
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        toast.danger(
          'Local shells autodetect failed',
          String((e as { message?: string })?.message ?? e),
        );
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

  // Global Ctrl+Shift+W cycles view modes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        useTabs.getState().cycleViewMode();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
            <ResizeHandle
              width={width}
              min={SIDEBAR_MIN}
              max={SIDEBAR_MAX}
              defaultWidth={SIDEBAR_DEFAULT}
              onChange={setWidth}
              onChangeEnd={persistWidth}
              reserve={sidebarReserve}
              label="Resize sidebar"
            />
          </aside>
        )}
        <div className="flex-1 min-w-0 min-h-0">
          <TabsShell />
        </div>
      </div>
      <StatusBar onLock={onLock} onOpenUpdater={() => setUpdateDialogOpen(true)} />
      <ToastRegion />
      {updateDialogOpen && (
        <UpdateDialog
          initialUpdate={autoUpdate}
          onClose={() => { setUpdateDialogOpen(false); setAutoUpdate(null); }}
        />
      )}
    </div>
  );
}
