# Window Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add mIRC-style window view modes (Tabs, Tile Horizontal, Tile Vertical, Tile Grid, Cascade MDI, Auto-arrange) with a 6-button toolbar in the existing tab strip and `Ctrl+Shift+W` cycle hotkey, frontend-only.

**Architecture:** Extend the existing `tabs-store` (Zustand) with view-mode state, replace `TabsShell`'s inner area with a new `MdiArea` strategy component that renders tabs/tile/cascade by mode, and add a custom drag/resize chrome (`MdiFrame`) for cascade MDI. Persist view mode + minimized set + grid dimensions to `localStorage`; cascade geometry stays in-memory. xterm visibility invariant preserved (terminals stay mounted in every mode; only positioning changes).

**Tech Stack:** Next.js 14, React 18, Zustand, TypeScript, Tailwind, lucide-react. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-04-27-window-views-design.md`
**Tracking issue:** https://github.com/ZerosAndOnesLLC/ezTerm/issues/30
**Branch:** `feat/window-views` (already created, spec already committed)

**Note on testing:** The spec confirms there is no React test infrastructure in `ui/` and adding one is out of scope. Each task's verification step uses `npm run typecheck` + `npm run lint` (must pass clean) and a manual smoke test in `cargo tauri dev` where behavior is interactive. The PR description carries the manual test plan from spec §10.

---

## File Map

**New files (all under `ui/`):**

| Path | Responsibility |
|------|----------------|
| `lib/use-mdi-drag.ts` | Drag hook bound to a cascade frame's title bar. |
| `lib/use-mdi-resize.ts` | Resize hook bound to the 8 edge/corner handles. |
| `components/view-mode-toolbar.tsx` | Six toolbar buttons rendered at the right end of the tab strip. |
| `components/mdi-area.tsx` | Strategy component — picks layout by `viewMode`. |
| `components/mdi-frame.tsx` | Cascade-mode chrome (title bar + 8 resize handles + drag area). |
| `components/minimized-strip.tsx` | Bottom strip showing iconified frames. |
| `components/tile-grid-dialog.tsx` | Modal for picking rows × cols. |

**Modified files:**

| Path | Why |
|------|-----|
| `lib/tabs-store.ts` | Add view-mode state + actions + localStorage persistence. |
| `components/tabs-shell.tsx` | Mount `ViewModeToolbar` and replace inner area with `MdiArea`. |
| `components/main-shell.tsx` | Wire `Ctrl+Shift+W` cycle keybinding. |
| `Cargo.toml` | Bump `0.11.0` → `0.12.0` (feature bump per global rules). |

---

## Task 1: Extend `tabs-store` with view-mode state

**Files:**
- Modify: `ui/lib/tabs-store.ts`

- [ ] **Step 1: Add types and state fields**

Replace the entire contents of `ui/lib/tabs-store.ts` with:

```ts
import { create } from 'zustand';
import type { Session } from './types';

export type TabStatus = 'connecting' | 'connected' | 'closed' | 'error';

export type ViewMode =
  | 'tabs' | 'tile-h' | 'tile-v' | 'tile-grid' | 'cascade' | 'auto';

export interface CascadeGeometry {
  x: number; y: number; w: number; h: number;
  z: number;                    // higher = on top
  maximized: boolean;
  prevGeom?: { x: number; y: number; w: number; h: number };
}

export interface Tab {
  tabId:        string;
  session:      Session;
  connectionId: number | null;
  status:       TabStatus;
  errorMessage: string | null;
  sftpOpen:     boolean;
  cwd:          string;
}

const VIEW_MODE_KEY  = 'ezterm.viewMode';
const TILE_GRID_KEY  = 'ezterm.tileGrid';
const MINIMIZED_KEY  = 'ezterm.minimizedTabs';

const VIEW_MODES: readonly ViewMode[] = [
  'tabs', 'tile-h', 'tile-v', 'tile-grid', 'cascade', 'auto',
];

function readViewMode(): ViewMode {
  if (typeof window === 'undefined') return 'tabs';
  try {
    const v = localStorage.getItem(VIEW_MODE_KEY);
    return (VIEW_MODES as readonly string[]).includes(v ?? '') ? (v as ViewMode) : 'tabs';
  } catch { return 'tabs'; }
}

function readTileGrid(): { rows: number; cols: number } {
  if (typeof window === 'undefined') return { rows: 2, cols: 2 };
  try {
    const raw = localStorage.getItem(TILE_GRID_KEY);
    if (!raw) return { rows: 2, cols: 2 };
    const v = JSON.parse(raw) as { rows?: unknown; cols?: unknown };
    const r = Math.max(1, Math.min(8, Number(v.rows) || 2));
    const c = Math.max(1, Math.min(8, Number(v.cols) || 2));
    return { rows: r, cols: c };
  } catch { return { rows: 2, cols: 2 }; }
}

function readMinimized(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(MINIMIZED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []);
  } catch { return new Set(); }
}

interface TabsState {
  tabs:       Tab[];
  activeId:   string | null;
  sidebarCollapsed: boolean;

  viewMode:   ViewMode;
  tileGrid:   { rows: number; cols: number };
  cascade:    Record<string, CascadeGeometry>;
  minimized:  Set<string>;
  nextZ:      number;

  open:       (session: Session) => string;
  setStatus:  (tabId: string, status: TabStatus, errorMessage?: string | null) => void;
  setConnection: (tabId: string, connectionId: number) => void;
  setActive:  (tabId: string | null) => void;
  close:      (tabId: string) => void;
  clear:      () => void;
  setSftpOpen: (tabId: string, open: boolean) => void;
  setCwd:      (tabId: string, cwd: string) => void;
  setSession:  (tabId: string, session: Session) => void;
  setSidebarCollapsed: (v: boolean) => void;
  toggleSidebar:       () => void;

  setViewMode:    (m: ViewMode) => void;
  cycleViewMode:  () => void;
  setTileGrid:    (rows: number, cols: number) => void;
  setCascadeGeom: (tabId: string, g: Partial<CascadeGeometry>) => void;
  bringToFront:   (tabId: string) => void;
  minimize:       (tabId: string) => void;
  restore:        (tabId: string) => void;
  toggleMaximize: (tabId: string, areaW: number, areaH: number) => void;
}

function uid() { return Math.random().toString(36).slice(2, 10); }

const STAIRCASE_STEP = 30;
const DEFAULT_FRAME_W = 640;
const DEFAULT_FRAME_H = 400;

function staircaseInit(count: number, nextZ: number): CascadeGeometry {
  const offset = (count % 10) * STAIRCASE_STEP;
  return {
    x: offset, y: offset,
    w: DEFAULT_FRAME_W, h: DEFAULT_FRAME_H,
    z: nextZ,
    maximized: false,
  };
}

export const useTabs = create<TabsState>((set, get) => ({
  tabs: [],
  activeId: null,
  sidebarCollapsed: false,

  viewMode:  readViewMode(),
  tileGrid:  readTileGrid(),
  cascade:   {},
  minimized: readMinimized(),
  nextZ:     1,

  open: (session) => {
    const tabId = uid();
    set((s) => {
      const newZ = s.nextZ + 1;
      const cascade = {
        ...s.cascade,
        [tabId]: staircaseInit(Object.keys(s.cascade).length, newZ),
      };
      return {
        tabs: [
          ...s.tabs,
          {
            tabId,
            session,
            connectionId: null,
            status: 'connecting',
            errorMessage: null,
            sftpOpen: false,
            cwd: '/',
          },
        ],
        activeId: tabId,
        sidebarCollapsed: true,
        cascade,
        nextZ: newZ,
      };
    });
    return tabId;
  },
  setStatus: (tabId, status, errorMessage = null) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.tabId === tabId ? { ...t, status, errorMessage } : t)),
    })),
  setConnection: (tabId, connectionId) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.tabId === tabId ? { ...t, connectionId } : t)),
    })),
  setActive: (activeId) => set({ activeId }),
  close: (tabId) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.tabId !== tabId);
      const activeId = s.activeId === tabId ? (tabs[tabs.length - 1]?.tabId ?? null) : s.activeId;
      const { [tabId]: _drop, ...cascade } = s.cascade;
      const minimized = new Set(s.minimized);
      minimized.delete(tabId);
      return { tabs, activeId, cascade, minimized };
    }),
  clear: () => set({ tabs: [], activeId: null, cascade: {}, minimized: new Set() }),
  setSftpOpen: (tabId, open) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.tabId === tabId ? { ...t, sftpOpen: open } : t)),
    })),
  setCwd: (tabId, cwd) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.tabId === tabId ? { ...t, cwd } : t)),
    })),
  setSession: (tabId, session) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.tabId === tabId ? { ...t, session } : t)),
    })),
  setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
  toggleSidebar:       () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  setViewMode: (m) => set({ viewMode: m }),
  cycleViewMode: () => {
    const cur = get().viewMode;
    const idx = VIEW_MODES.indexOf(cur);
    const next = VIEW_MODES[(idx + 1) % VIEW_MODES.length];
    set({ viewMode: next });
  },
  setTileGrid: (rows, cols) => set({
    tileGrid: {
      rows: Math.max(1, Math.min(8, rows | 0)),
      cols: Math.max(1, Math.min(8, cols | 0)),
    },
  }),
  setCascadeGeom: (tabId, g) =>
    set((s) => {
      const cur = s.cascade[tabId];
      if (!cur) return {};
      return { cascade: { ...s.cascade, [tabId]: { ...cur, ...g } } };
    }),
  bringToFront: (tabId) =>
    set((s) => {
      const cur = s.cascade[tabId];
      if (!cur) return {};
      const nextZ = s.nextZ + 1;
      return {
        nextZ,
        cascade: { ...s.cascade, [tabId]: { ...cur, z: nextZ } },
      };
    }),
  minimize: (tabId) =>
    set((s) => {
      const minimized = new Set(s.minimized);
      minimized.add(tabId);
      return { minimized };
    }),
  restore: (tabId) =>
    set((s) => {
      const minimized = new Set(s.minimized);
      minimized.delete(tabId);
      const cur = s.cascade[tabId];
      if (!cur) return { minimized };
      const nextZ = s.nextZ + 1;
      return {
        minimized,
        nextZ,
        cascade: { ...s.cascade, [tabId]: { ...cur, z: nextZ } },
      };
    }),
  toggleMaximize: (tabId, areaW, areaH) =>
    set((s) => {
      const cur = s.cascade[tabId];
      if (!cur) return {};
      if (cur.maximized && cur.prevGeom) {
        const { prevGeom, ...rest } = cur;
        return {
          cascade: {
            ...s.cascade,
            [tabId]: { ...rest, ...prevGeom, maximized: false },
          },
        };
      }
      return {
        cascade: {
          ...s.cascade,
          [tabId]: {
            ...cur,
            prevGeom: { x: cur.x, y: cur.y, w: cur.w, h: cur.h },
            x: 0, y: 0, w: areaW, h: areaH,
            maximized: true,
          },
        },
      };
    }),
}));

if (typeof window !== 'undefined') {
  useTabs.subscribe((s, prev) => {
    try {
      if (s.viewMode !== prev.viewMode) {
        localStorage.setItem(VIEW_MODE_KEY, s.viewMode);
      }
      if (s.tileGrid !== prev.tileGrid) {
        localStorage.setItem(TILE_GRID_KEY, JSON.stringify(s.tileGrid));
      }
      if (s.minimized !== prev.minimized) {
        localStorage.setItem(MINIMIZED_KEY, JSON.stringify(Array.from(s.minimized)));
      }
    } catch { /* localStorage may be disabled — silently skip */ }
  });
}
```

Notes on this step:
- `readViewMode/readTileGrid/readMinimized` initialize from `localStorage` with safe parse fallback.
- Persistence is a single `subscribe` block that writes only changed slices.
- `open()` initializes a staircase-offset `CascadeGeometry` for the new tab so cascade mode never sees a missing entry.
- `close()` deletes the tab's `cascade` and `minimized` entries (no orphan state).
- All types exported so other files can import `ViewMode` and `CascadeGeometry`.

- [ ] **Step 2: Verify type-check and lint pass**

```bash
npm --prefix ui run typecheck
npm --prefix ui run lint
```

Expected: both exit 0 with no errors. Existing code that imports `useTabs` continues to compile because we kept all old fields and signatures.

- [ ] **Step 3: Commit**

```bash
git add ui/lib/tabs-store.ts
git commit -m "feat(views): extend tabs-store with view-mode state and persistence

Add ViewMode type, cascade geometry per tab, minimized set, z-order,
and tile-grid dimensions to the tabs store. Persist viewMode + tileGrid
+ minimized to localStorage; cascade geometry stays in-memory per spec.
open() now initializes staircase-offset CascadeGeometry for new tabs."
```

---

## Task 2: Create stub `MdiArea` component (tabs mode only)

Refactor: lift the existing inner-area JSX out of `TabsShell` into a new `MdiArea` component. Behavior must be identical at the end of this task — only `tabs` mode is implemented; other modes are stubs.

**Files:**
- Create: `ui/components/mdi-area.tsx`
- Modify: `ui/components/tabs-shell.tsx`

- [ ] **Step 1: Create `ui/components/mdi-area.tsx`**

```tsx
'use client';
import dynamic from 'next/dynamic';
import { Terminal } from 'lucide-react';
import { useTabs } from '@/lib/tabs-store';
import { EmptyState } from './empty-state';
import { SftpPane } from './sftp-pane';

const TerminalView = dynamic(
  () => import('./terminal').then((m) => m.TerminalView),
  { ssr: false },
);

export function MdiArea() {
  const tabs     = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const viewMode = useTabs((s) => s.viewMode);

  if (tabs.length === 0) {
    return (
      <EmptyState
        icon={Terminal}
        title="Ready to connect"
        body="Double-click a session in the sidebar, or create a new one to get started."
      />
    );
  }

  // For now, every mode renders the legacy "tabs" layout. Subsequent tasks
  // add real strategies for tile-h/tile-v/tile-grid/cascade/auto.
  void viewMode;

  return (
    <div className="absolute inset-0">
      {tabs.map((t) => {
        const active = t.tabId === activeId;
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
      })}
    </div>
  );
}
```

- [ ] **Step 2: Refactor `ui/components/tabs-shell.tsx` to use `MdiArea`**

Replace the entire contents with:

```tsx
'use client';
import { AlertCircle, FolderTree, Terminal, X } from 'lucide-react';
import { useTabs, type TabStatus } from '@/lib/tabs-store';
import { MdiArea } from './mdi-area';

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
  const { tabs, activeId, setActive, close } = useTabs();

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="h-8 border-b border-border bg-surface flex items-stretch overflow-x-auto">
        {tabs.length === 0 && (
          <div className="self-center px-3 text-muted text-xs flex items-center gap-2">
            <Terminal size={12} />
            <span>No open tabs — double-click a session in the sidebar</span>
          </div>
        )}
        {tabs.map((t) => {
          const on = t.tabId === activeId;
          return (
            <div
              key={t.tabId}
              onClick={() => setActive(t.tabId)}
              onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); close(t.tabId); } }}
              className={`group relative flex items-center gap-2 px-3 cursor-default select-none border-r border-border ${
                on ? 'bg-bg text-fg' : 'text-muted hover:text-fg hover:bg-surface2/40'
              }`}
              role="tab"
              aria-selected={on}
            >
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
        <MdiArea />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Smoke-test in dev mode**

```bash
cargo tauri dev
```

Manual checks (close dev when done):
- App launches normally.
- Open one or more sessions from the sidebar — terminals connect and render exactly as before.
- Switch active tab via the tab strip — the active terminal shows; inactive ones stay hidden but their connections remain alive (status dots stay green).
- Open the SFTP pane on an SSH tab — pane appears to the left of the terminal as before.

- [ ] **Step 4: Verify checks pass**

```bash
npm --prefix ui run typecheck
npm --prefix ui run lint
```

Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add ui/components/mdi-area.tsx ui/components/tabs-shell.tsx
git commit -m "refactor(views): extract MdiArea from TabsShell

No behaviour change — lifts the per-tab terminal layout into a new
MdiArea component so subsequent tasks can swap layout strategies by
viewMode without touching the tab strip."
```

---

## Task 3: Add `ViewModeToolbar` (buttons render, only `tabs` works visually)

Adds the 6-button toolbar at the right end of the tab strip and wires `setViewMode`. No layout strategies yet — switching modes just changes the active button highlight; the area still renders `tabs` layout.

**Files:**
- Create: `ui/components/view-mode-toolbar.tsx`
- Modify: `ui/components/tabs-shell.tsx`

- [ ] **Step 1: Create `ui/components/view-mode-toolbar.tsx`**

```tsx
'use client';
import { useState } from 'react';
import {
  Columns2, Grid3x3, LayoutGrid, Rows2, SquareStack, Sparkles,
} from 'lucide-react';
import { useTabs, type ViewMode } from '@/lib/tabs-store';
import { TileGridDialog } from './tile-grid-dialog';

interface ButtonDef { mode: ViewMode; icon: typeof Columns2; label: string; }

const BUTTONS: readonly ButtonDef[] = [
  { mode: 'tabs',      icon: LayoutGrid,   label: 'Tabs view'        },
  { mode: 'tile-h',    icon: Rows2,        label: 'Tile horizontal'  },
  { mode: 'tile-v',    icon: Columns2,     label: 'Tile vertical'    },
  { mode: 'tile-grid', icon: Grid3x3,      label: 'Tile grid…'       },
  { mode: 'cascade',   icon: SquareStack,  label: 'Cascade'          },
  { mode: 'auto',      icon: Sparkles,     label: 'Auto-arrange'     },
];

export function ViewModeToolbar() {
  const viewMode    = useTabs((s) => s.viewMode);
  const setViewMode = useTabs((s) => s.setViewMode);
  const [gridDialog, setGridDialog] = useState(false);

  function onClick(mode: ViewMode) {
    if (mode === 'tile-grid') {
      setGridDialog(true);
      return;
    }
    setViewMode(mode);
  }

  return (
    <>
      <div
        className="ml-auto flex items-stretch border-l border-border"
        role="toolbar"
        aria-label="Window view mode"
      >
        {BUTTONS.map(({ mode, icon: Icon, label }) => {
          const on = viewMode === mode;
          return (
            <button
              key={mode}
              type="button"
              onClick={() => onClick(mode)}
              title={label}
              aria-label={label}
              aria-pressed={on}
              className={`relative w-8 h-full flex items-center justify-center ${
                on ? 'text-fg' : 'text-muted hover:text-fg hover:bg-surface2/40'
              } focus-ring`}
            >
              {on && <span className="absolute left-1 right-1 bottom-0 h-0.5 bg-accent" aria-hidden />}
              <Icon size={14} />
            </button>
          );
        })}
      </div>
      {gridDialog && (
        <TileGridDialog
          onCancel={() => setGridDialog(false)}
          onConfirm={(rows, cols) => {
            useTabs.getState().setTileGrid(rows, cols);
            setViewMode('tile-grid');
            setGridDialog(false);
          }}
        />
      )}
    </>
  );
}
```

- [ ] **Step 2: Create stub `ui/components/tile-grid-dialog.tsx`**

We'll keep this minimal in this task and flesh out validation later if needed.

```tsx
'use client';
import { useEffect, useRef, useState } from 'react';
import { Grid3x3 } from 'lucide-react';
import { useTabs } from '@/lib/tabs-store';

interface Props {
  onCancel:  () => void;
  onConfirm: (rows: number, cols: number) => void;
}

export function TileGridDialog({ onCancel, onConfirm }: Props) {
  const stored = useTabs((s) => s.tileGrid);
  const [rows, setRows] = useState<number>(stored.rows);
  const [cols, setCols] = useState<number>(stored.cols);
  const okBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { okBtnRef.current?.focus(); }, []);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  function clamp(n: number) { return Math.max(1, Math.min(8, n | 0)); }

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4 overlay-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tile-grid-title"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <form
        className="w-[360px] max-w-full bg-surface border border-border rounded-md shadow-dialog overflow-hidden dialog-in"
        onSubmit={(e) => { e.preventDefault(); onConfirm(clamp(rows), clamp(cols)); }}
      >
        <div className="p-4 flex gap-3">
          <div className="shrink-0 text-accent"><Grid3x3 size={22} /></div>
          <div className="min-w-0 flex-1">
            <h2 id="tile-grid-title" className="font-semibold text-sm">Tile grid</h2>
            <p className="text-muted text-xs mt-1">Pick the rows × columns layout.</p>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs text-muted">Rows</span>
                <input
                  type="number" min={1} max={8}
                  value={rows}
                  onChange={(e) => setRows(Number(e.target.value))}
                  className="mt-1 w-full px-2 py-1.5 bg-bg border border-border rounded text-sm focus-ring"
                />
              </label>
              <label className="block">
                <span className="text-xs text-muted">Columns</span>
                <input
                  type="number" min={1} max={8}
                  value={cols}
                  onChange={(e) => setCols(Number(e.target.value))}
                  className="mt-1 w-full px-2 py-1.5 bg-bg border border-border rounded text-sm focus-ring"
                />
              </label>
            </div>
          </div>
        </div>
        <div className="px-4 py-3 border-t border-border bg-surface2/30 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 border border-border rounded text-sm hover:bg-surface2 focus-ring"
          >
            Cancel
          </button>
          <button
            ref={okBtnRef}
            type="submit"
            className="px-3 py-1.5 rounded text-sm font-medium bg-accent text-white hover:brightness-110 focus-ring"
          >
            Apply
          </button>
        </div>
      </form>
    </div>
  );
}
```

- [ ] **Step 3: Mount `ViewModeToolbar` at the end of the tab strip**

Edit `ui/components/tabs-shell.tsx`. Add the import at the top:

```tsx
import { ViewModeToolbar } from './view-mode-toolbar';
```

Inside the tab strip `<div className="h-8 border-b border-border bg-surface flex items-stretch overflow-x-auto">`, append `<ViewModeToolbar />` as the last child (after the `tabs.map(...)` block, still inside the strip div):

```tsx
        {tabs.map((t) => {
          /* ...existing tab rendering... */
        })}
        <ViewModeToolbar />
      </div>
```

- [ ] **Step 4: Smoke-test in dev mode**

```bash
cargo tauri dev
```

Manual checks:
- The tab strip now shows 6 small icon buttons at its right edge.
- Hovering each shows a tooltip ("Tabs view", "Tile horizontal", etc.).
- The currently-selected mode (initially "Tabs view") shows the accent underline on its button.
- Clicking each non-grid button moves the underline to that button. Layout stays in tabs view (expected — strategies not implemented yet).
- Clicking the Tile-grid button opens a small dialog with two number inputs. Cancel/Esc closes it; clicking Apply with default 2×2 sets `tile-grid` mode (underline moves there). Layout still tabs (expected).
- Reload the app — the last selected mode persists across reload (toolbar underline restored).

- [ ] **Step 5: Verify checks pass**

```bash
npm --prefix ui run typecheck
npm --prefix ui run lint
```

- [ ] **Step 6: Commit**

```bash
git add ui/components/view-mode-toolbar.tsx \
        ui/components/tile-grid-dialog.tsx \
        ui/components/tabs-shell.tsx
git commit -m "feat(views): add view-mode toolbar and tile-grid dialog

Six icon buttons at the right end of the tab strip switch viewMode.
Tile-grid opens a small modal for rows × cols selection. Selection
persists across reload via tabs-store. Layout strategies follow in
later commits."
```

---

## Task 4: Implement `tile-h` and `tile-v` strategies

Render every non-minimized tab as a flex child. SFTP pane suppressed in non-tabs modes. Active tab still renders its overlays inside its own cell.

**Files:**
- Modify: `ui/components/mdi-area.tsx`

- [ ] **Step 1: Replace `MdiArea` with strategy split**

Replace `ui/components/mdi-area.tsx` contents with:

```tsx
'use client';
import dynamic from 'next/dynamic';
import { Terminal } from 'lucide-react';
import { useTabs, type Tab, type ViewMode } from '@/lib/tabs-store';
import { EmptyState } from './empty-state';
import { SftpPane } from './sftp-pane';

const TerminalView = dynamic(
  () => import('./terminal').then((m) => m.TerminalView),
  { ssr: false },
);

export function MdiArea() {
  const tabs      = useTabs((s) => s.tabs);
  const activeId  = useTabs((s) => s.activeId);
  const viewMode  = useTabs((s) => s.viewMode);
  const minimized = useTabs((s) => s.minimized);

  if (tabs.length === 0) {
    return (
      <EmptyState
        icon={Terminal}
        title="Ready to connect"
        body="Double-click a session in the sidebar, or create a new one to get started."
      />
    );
  }

  if (viewMode === 'tabs') {
    return <TabsLayout tabs={tabs} activeId={activeId} />;
  }

  // In non-tabs modes, minimized tabs are hidden from the layout.
  const visible = tabs.filter((t) => !minimized.has(t.tabId));

  if (viewMode === 'tile-h' || viewMode === 'tile-v') {
    return <TileFlexLayout tabs={visible} dir={viewMode === 'tile-h' ? 'col' : 'row'} />;
  }

  // tile-grid / cascade / auto handled in later tasks
  return <PlaceholderLayout mode={viewMode} />;
}

function TabsLayout({ tabs, activeId }: { tabs: Tab[]; activeId: string | null }) {
  return (
    <div className="absolute inset-0">
      {tabs.map((t) => {
        const active = t.tabId === activeId;
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
      })}
    </div>
  );
}

function TileFlexLayout({ tabs, dir }: { tabs: Tab[]; dir: 'row' | 'col' }) {
  const setActive = useTabs((s) => s.setActive);
  return (
    <div
      className={`absolute inset-0 flex ${dir === 'col' ? 'flex-col' : 'flex-row'} gap-px bg-border`}
    >
      {tabs.map((t) => (
        <div
          key={t.tabId}
          className="flex-1 min-w-0 min-h-0 bg-bg relative"
          onMouseDown={() => setActive(t.tabId)}
        >
          <TerminalView tab={t} visible={true} />
        </div>
      ))}
    </div>
  );
}

function PlaceholderLayout({ mode }: { mode: ViewMode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center text-muted text-xs">
      Layout for <span className="mx-1 font-mono">{mode}</span> not yet wired.
    </div>
  );
}
```

Notes:
- `TileFlexLayout` uses `gap-px bg-border` to draw 1px hairline dividers between cells (cheap and matches the existing border style).
- Each cell registers `onMouseDown → setActive(tabId)` so the status bar / SFTP-toggle target stays sane.
- SFTP pane is intentionally not rendered in tile/cascade/auto (per spec §3 SFTP).

- [ ] **Step 2: Smoke-test in dev mode**

```bash
cargo tauri dev
```

Manual checks:
- Open 2–4 sessions.
- Click "Tile horizontal" → cells stack vertically (rows). Each terminal renders and is interactive (type into one, it accepts input independently of the others).
- Click "Tile vertical" → cells flow horizontally (columns).
- Resize the main window — cells reflow without crashing xterm.
- Click "Tabs view" → returns to the single-active-terminal layout.
- Click "Tile grid", "Cascade", or "Auto-arrange" → placeholder text appears (expected — implemented in later tasks).
- Confirm xterm doesn't throw "dimensions" errors in the dev console.

- [ ] **Step 3: Verify checks pass**

```bash
npm --prefix ui run typecheck
npm --prefix ui run lint
```

- [ ] **Step 4: Commit**

```bash
git add ui/components/mdi-area.tsx
git commit -m "feat(views): tile horizontal and tile vertical strategies

Render every non-minimized tab as a flex cell, full size of its
share of the area. Hairline border between cells. Click any cell
to set activeId. SFTP pane suppressed in non-tabs modes per spec."
```

---

## Task 5: Implement `tile-grid` and `auto` strategies

Both are CSS Grid layouts. `tile-grid` reads `tileGrid` from the store; `auto` computes `cols = ceil(sqrt(N))`. Surplus tabs (more than `rows*cols`) flow into an extra row at the bottom via `grid-auto-rows`.

**Files:**
- Modify: `ui/components/mdi-area.tsx`

- [ ] **Step 1: Add `TileGridLayout` and wire into `MdiArea`**

In `ui/components/mdi-area.tsx`, replace the `// tile-grid / cascade / auto handled in later tasks` block (and the `<PlaceholderLayout>` return + the `PlaceholderLayout` component) with:

```tsx
  if (viewMode === 'tile-grid' || viewMode === 'auto') {
    return <TileGridLayout tabs={visible} mode={viewMode} />;
  }

  return <PlaceholderLayout mode={viewMode} />;
}
```

Then add the `TileGridLayout` component (and keep `PlaceholderLayout` for cascade until Task 10):

```tsx
function TileGridLayout({ tabs, mode }: { tabs: Tab[]; mode: 'tile-grid' | 'auto' }) {
  const setActive = useTabs((s) => s.setActive);
  const tileGrid  = useTabs((s) => s.tileGrid);

  let rows: number;
  let cols: number;
  if (mode === 'auto') {
    const n = Math.max(1, tabs.length);
    cols = Math.ceil(Math.sqrt(n));
    rows = Math.ceil(n / cols);
  } else {
    ({ rows, cols } = tileGrid);
  }

  return (
    <div
      className="absolute inset-0 grid gap-px bg-border overflow-auto"
      style={{
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridTemplateRows:    `repeat(${rows}, minmax(160px, 1fr))`,
        gridAutoRows:        'minmax(160px, 1fr)',
      }}
    >
      {tabs.map((t) => (
        <div
          key={t.tabId}
          className="min-w-0 min-h-0 bg-bg relative"
          onMouseDown={() => setActive(t.tabId)}
        >
          <TerminalView tab={t} visible={true} />
        </div>
      ))}
    </div>
  );
}
```

Notes:
- `minmax(0, 1fr)` on columns + `min-w-0` on cells prevents xterm content from forcing the grid wider than its container.
- `minmax(160px, 1fr)` on rows + `gridAutoRows: minmax(160px, 1fr)` lets surplus tabs (when `N > rows*cols` in `tile-grid` mode) flow into an extra row that's at least 160px tall, with the container scrolling vertically.
- `auto` always sizes to fit so it never overflows.

- [ ] **Step 2: Smoke-test in dev mode**

```bash
cargo tauri dev
```

Manual checks:
- Open 6 sessions. Click "Auto-arrange". Layout becomes a 3×2 grid (`cols = ceil(sqrt(6)) = 3`, `rows = 2`). All terminals visible and interactive.
- Open one more session (7 total) → auto re-tiles to 3×3 with one empty cell.
- Close two sessions (5 total) → auto re-tiles to 3×2 with one empty cell.
- Click "Tile grid" → dialog opens, default 2×2. Apply → 4 cells visible at most; if you have 5+ sessions a 5th flows into a 3rd row at the bottom (scrollable).
- Re-open tile-grid dialog, set 3×3 → all sessions visible.
- Resize window — cells reflow.

- [ ] **Step 3: Verify checks pass**

```bash
npm --prefix ui run typecheck
npm --prefix ui run lint
```

- [ ] **Step 4: Commit**

```bash
git add ui/components/mdi-area.tsx
git commit -m "feat(views): tile-grid and auto-arrange strategies

CSS Grid layout. tile-grid reads rows/cols from the store; auto-arrange
computes cols = ceil(sqrt(N)) and re-tiles on tab open/close. Surplus
tabs in tile-grid overflow into an extra scrollable row so nothing is
ever hidden when the grid is undersized."
```

---

## Task 6: Create `useMdiDrag` hook

Mouse-event-driven hook that drags a frame's `{x, y}` while clamping to MDI area bounds. Suppresses xterm pointer events on the area while dragging (same trick as the sidebar resize handler in `main-shell.tsx`).

**Files:**
- Create: `ui/lib/use-mdi-drag.ts`

- [ ] **Step 1: Write the hook**

```ts
import { useCallback } from 'react';
import { useTabs } from './tabs-store';

interface Args {
  tabId:  string;
  /** Ref to the MDI area container — used to read live width/height for clamping. */
  areaRef: React.RefObject<HTMLDivElement>;
  /** Called on mousedown so the consumer can flip a `dragging` flag for pointer-events suppression. */
  onDragStart?: () => void;
  /** Called on mouseup. */
  onDragEnd?: () => void;
}

export function useMdiDrag({ tabId, areaRef, onDragStart, onDragEnd }: Args) {
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const area = areaRef.current;
    if (!area) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const cur = useTabs.getState().cascade[tabId];
    if (!cur) return;
    if (cur.maximized) return;          // can't drag while maximized
    const startGeom = { x: cur.x, y: cur.y, w: cur.w, h: cur.h };
    const areaW = area.clientWidth;
    const areaH = area.clientHeight;

    e.preventDefault();
    onDragStart?.();

    function onMove(ev: MouseEvent) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const x = Math.max(0, Math.min(areaW - startGeom.w, startGeom.x + dx));
      const y = Math.max(0, Math.min(areaH - startGeom.h, startGeom.y + dy));
      // Re-check tab still exists (could be closed mid-drag).
      const live = useTabs.getState().cascade[tabId];
      if (!live) return;
      useTabs.getState().setCascadeGeom(tabId, { x, y });
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      onDragEnd?.();
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [tabId, areaRef, onDragStart, onDragEnd]);

  return { onMouseDown };
}
```

- [ ] **Step 2: Verify checks pass**

```bash
npm --prefix ui run typecheck
npm --prefix ui run lint
```

(No runtime test yet — exercised in Task 8 when `MdiFrame` consumes the hook.)

- [ ] **Step 3: Commit**

```bash
git add ui/lib/use-mdi-drag.ts
git commit -m "feat(views): useMdiDrag hook

Drag a cascade frame's {x,y} via mousedown on title bar. Window-level
mousemove/mouseup so fast cursor exits don't lose the drag. Clamps to
area bounds; ignores drags on maximized frames; recovers gracefully if
the tab is closed mid-drag."
```

---

## Task 7: Create `useMdiResize` hook

Same lifecycle as `useMdiDrag` but adjusts edges. Eight handles: `n s e w ne nw se sw`. Min size 200×120.

**Files:**
- Create: `ui/lib/use-mdi-resize.ts`

- [ ] **Step 1: Write the hook**

```ts
import { useCallback } from 'react';
import { useTabs } from './tabs-store';

export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const MIN_W = 200;
const MIN_H = 120;

interface Args {
  tabId:   string;
  edge:    ResizeEdge;
  areaRef: React.RefObject<HTMLDivElement>;
  onDragStart?: () => void;
  onDragEnd?:   () => void;
}

export function useMdiResize({ tabId, edge, areaRef, onDragStart, onDragEnd }: Args) {
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const area = areaRef.current;
    if (!area) return;
    const cur = useTabs.getState().cascade[tabId];
    if (!cur || cur.maximized) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const start  = { x: cur.x, y: cur.y, w: cur.w, h: cur.h };
    const areaW = area.clientWidth;
    const areaH = area.clientHeight;

    e.preventDefault();
    e.stopPropagation();   // don't trigger title-bar drag from a corner
    onDragStart?.();

    function onMove(ev: MouseEvent) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      let { x, y, w, h } = start;

      if (edge.includes('e')) {
        w = Math.max(MIN_W, Math.min(areaW - start.x, start.w + dx));
      }
      if (edge.includes('w')) {
        // West edge: x and w move opposite.
        const newX = Math.max(0, Math.min(start.x + start.w - MIN_W, start.x + dx));
        w = start.w + (start.x - newX);
        x = newX;
      }
      if (edge.includes('s')) {
        h = Math.max(MIN_H, Math.min(areaH - start.y, start.h + dy));
      }
      if (edge.includes('n')) {
        const newY = Math.max(0, Math.min(start.y + start.h - MIN_H, start.y + dy));
        h = start.h + (start.y - newY);
        y = newY;
      }

      if (!useTabs.getState().cascade[tabId]) return;
      useTabs.getState().setCascadeGeom(tabId, { x, y, w, h });
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      onDragEnd?.();
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [tabId, edge, areaRef, onDragStart, onDragEnd]);

  return { onMouseDown };
}
```

- [ ] **Step 2: Verify checks pass**

```bash
npm --prefix ui run typecheck
npm --prefix ui run lint
```

- [ ] **Step 3: Commit**

```bash
git add ui/lib/use-mdi-resize.ts
git commit -m "feat(views): useMdiResize hook

Edge/corner resize for cascade frames. Eight edges, MIN_W=200, MIN_H=120.
Preserves the opposite edge so the user-grabbed edge tracks the cursor.
Clamps to area bounds; stops mousedown from bubbling to the title-bar
drag handler."
```

---

## Task 8: Create `MdiFrame` component (cascade chrome)

Title bar with status dot + name + min/max/close, drag area, 8 resize handles. Click anywhere → `bringToFront` + `setActive`. Double-click title → `toggleMaximize`.

**Files:**
- Create: `ui/components/mdi-frame.tsx`

- [ ] **Step 1: Write the component**

```tsx
'use client';
import dynamic from 'next/dynamic';
import { AlertCircle, Maximize2, Minimize2, Minus, X } from 'lucide-react';
import type { RefObject } from 'react';
import { useTabs, type Tab, type TabStatus } from '@/lib/tabs-store';
import { useMdiDrag } from '@/lib/use-mdi-drag';
import { useMdiResize, type ResizeEdge } from '@/lib/use-mdi-resize';

const TerminalView = dynamic(
  () => import('./terminal').then((m) => m.TerminalView),
  { ssr: false },
);

interface Props {
  tab:     Tab;
  areaRef: RefObject<HTMLDivElement>;
  areaW:   number;
  areaH:   number;
  setDragging: (v: boolean) => void;
}

const HANDLES: readonly { edge: ResizeEdge; cls: string; cursor: string }[] = [
  { edge: 'n',  cls: 'top-0 left-2 right-2 h-1',                cursor: 'ns-resize' },
  { edge: 's',  cls: 'bottom-0 left-2 right-2 h-1',             cursor: 'ns-resize' },
  { edge: 'e',  cls: 'top-2 bottom-2 right-0 w-1',              cursor: 'ew-resize' },
  { edge: 'w',  cls: 'top-2 bottom-2 left-0 w-1',               cursor: 'ew-resize' },
  { edge: 'ne', cls: 'top-0 right-0 w-2 h-2',                   cursor: 'nesw-resize' },
  { edge: 'nw', cls: 'top-0 left-0 w-2 h-2',                    cursor: 'nwse-resize' },
  { edge: 'se', cls: 'bottom-0 right-0 w-2 h-2',                cursor: 'nwse-resize' },
  { edge: 'sw', cls: 'bottom-0 left-0 w-2 h-2',                 cursor: 'nesw-resize' },
];

function StatusDot({ status }: { status: TabStatus }) {
  if (status === 'error') {
    return <AlertCircle size={11} className="text-danger shrink-0" aria-label="error" />;
  }
  let cls = 'bg-muted';
  if (status === 'connected') cls = 'bg-success';
  else if (status === 'connecting') cls = 'bg-warning animate-pulse';
  else if (status === 'closed') cls = 'bg-muted/60';
  return <span className={`w-1.5 h-1.5 rounded-full ${cls} shrink-0`} aria-label={status} />;
}

export function MdiFrame({ tab, areaRef, areaW, areaH, setDragging }: Props) {
  const cascade  = useTabs((s) => s.cascade[tab.tabId]);
  const activeId = useTabs((s) => s.activeId);
  const setActive     = useTabs((s) => s.setActive);
  const bringToFront  = useTabs((s) => s.bringToFront);
  const minimize      = useTabs((s) => s.minimize);
  const toggleMax     = useTabs((s) => s.toggleMaximize);
  const close         = useTabs((s) => s.close);

  if (!cascade) return null;

  // Display-only clamp so a previously-stored geometry doesn't leak off-screen
  // after a window resize. We don't write back; user dragging will normalise.
  const w = Math.min(cascade.w, Math.max(200, areaW));
  const h = Math.min(cascade.h, Math.max(120, areaH));
  const x = Math.max(0, Math.min(areaW - w, cascade.x));
  const y = Math.max(0, Math.min(areaH - h, cascade.y));

  const drag = useMdiDrag({
    tabId: tab.tabId, areaRef,
    onDragStart: () => setDragging(true),
    onDragEnd:   () => setDragging(false),
  });

  const isActive = tab.tabId === activeId;

  function focusFrame() {
    if (tab.tabId !== activeId) setActive(tab.tabId);
    bringToFront(tab.tabId);
  }

  return (
    <div
      className={`absolute bg-bg border rounded-md shadow-lg flex flex-col overflow-hidden ${
        isActive ? 'border-accent' : 'border-border'
      }`}
      style={{ left: x, top: y, width: w, height: h, zIndex: cascade.z }}
      onMouseDown={focusFrame}
      role="group"
      aria-label={`${tab.session.name} window`}
    >
      <div
        className={`h-6 flex items-center gap-2 px-2 select-none cursor-move border-b border-border ${
          isActive ? 'bg-surface' : 'bg-surface/70'
        }`}
        onMouseDown={drag.onMouseDown}
        onDoubleClick={() => toggleMax(tab.tabId, areaW, areaH)}
      >
        <StatusDot status={tab.status} />
        <span className="truncate text-xs flex-1" title={`${tab.session.username}@${tab.session.host}`}>
          {tab.session.name}
        </span>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); minimize(tab.tabId); }}
          title="Minimize"
          aria-label="Minimize"
          className="icon-btn w-5 h-5"
        >
          <Minus size={11} />
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); toggleMax(tab.tabId, areaW, areaH); }}
          title={cascade.maximized ? 'Restore' : 'Maximize'}
          aria-label={cascade.maximized ? 'Restore' : 'Maximize'}
          className="icon-btn w-5 h-5"
        >
          {cascade.maximized ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); close(tab.tabId); }}
          title="Close"
          aria-label="Close"
          className="icon-btn w-5 h-5 hover:text-danger"
        >
          <X size={11} />
        </button>
      </div>
      <div className="flex-1 min-h-0 relative">
        <TerminalView tab={tab} visible={true} />
      </div>
      {!cascade.maximized && HANDLES.map((h) => (
        <ResizeHandle key={h.edge} tabId={tab.tabId} areaRef={areaRef} edge={h.edge}
                      cls={h.cls} cursor={h.cursor} setDragging={setDragging} />
      ))}
    </div>
  );
}

interface HandleProps {
  tabId: string;
  areaRef: RefObject<HTMLDivElement>;
  edge: ResizeEdge;
  cls: string;
  cursor: string;
  setDragging: (v: boolean) => void;
}

function ResizeHandle({ tabId, areaRef, edge, cls, cursor, setDragging }: HandleProps) {
  const r = useMdiResize({
    tabId, edge, areaRef,
    onDragStart: () => setDragging(true),
    onDragEnd:   () => setDragging(false),
  });
  return (
    <div
      className={`absolute ${cls}`}
      style={{ cursor }}
      onMouseDown={r.onMouseDown}
      aria-hidden
    />
  );
}
```

- [ ] **Step 2: Verify checks pass**

```bash
npm --prefix ui run typecheck
npm --prefix ui run lint
```

- [ ] **Step 3: Commit**

```bash
git add ui/components/mdi-frame.tsx
git commit -m "feat(views): MdiFrame chrome for cascade mode

Title bar (status dot + name + min/max/close), 8 resize handles, drag
binding via useMdiDrag, click-to-front, double-click to toggle maximize.
Display-only clamp on geometry so window-resize never leaves a frame
unreachable; clamps don't write back."
```

---

## Task 9: Wire `cascade` strategy in `MdiArea`

Adds the cascade strategy: tracks own size via `ResizeObserver`, renders one `MdiFrame` per non-minimized tab, suppresses xterm pointer events while a drag/resize is in flight.

**Files:**
- Modify: `ui/components/mdi-area.tsx`

- [ ] **Step 1: Replace `MdiArea` with cascade-aware version**

Replace the current `ui/components/mdi-area.tsx` contents with:

```tsx
'use client';
import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';
import { Terminal } from 'lucide-react';
import { useTabs, type Tab, type ViewMode } from '@/lib/tabs-store';
import { EmptyState } from './empty-state';
import { SftpPane } from './sftp-pane';
import { MdiFrame } from './mdi-frame';

const TerminalView = dynamic(
  () => import('./terminal').then((m) => m.TerminalView),
  { ssr: false },
);

export function MdiArea() {
  const tabs      = useTabs((s) => s.tabs);
  const activeId  = useTabs((s) => s.activeId);
  const viewMode  = useTabs((s) => s.viewMode);
  const minimized = useTabs((s) => s.minimized);

  if (tabs.length === 0) {
    return (
      <EmptyState
        icon={Terminal}
        title="Ready to connect"
        body="Double-click a session in the sidebar, or create a new one to get started."
      />
    );
  }

  if (viewMode === 'tabs') {
    return <TabsLayout tabs={tabs} activeId={activeId} />;
  }

  const visible = tabs.filter((t) => !minimized.has(t.tabId));

  if (viewMode === 'tile-h' || viewMode === 'tile-v') {
    return <TileFlexLayout tabs={visible} dir={viewMode === 'tile-h' ? 'col' : 'row'} />;
  }
  if (viewMode === 'tile-grid' || viewMode === 'auto') {
    return <TileGridLayout tabs={visible} mode={viewMode} />;
  }
  if (viewMode === 'cascade') {
    return <CascadeLayout tabs={visible} />;
  }

  return <PlaceholderLayout mode={viewMode} />;
}

function TabsLayout({ tabs, activeId }: { tabs: Tab[]; activeId: string | null }) {
  return (
    <div className="absolute inset-0">
      {tabs.map((t) => {
        const active = t.tabId === activeId;
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
      })}
    </div>
  );
}

function TileFlexLayout({ tabs, dir }: { tabs: Tab[]; dir: 'row' | 'col' }) {
  const setActive = useTabs((s) => s.setActive);
  return (
    <div className={`absolute inset-0 flex ${dir === 'col' ? 'flex-col' : 'flex-row'} gap-px bg-border`}>
      {tabs.map((t) => (
        <div
          key={t.tabId}
          className="flex-1 min-w-0 min-h-0 bg-bg relative"
          onMouseDown={() => setActive(t.tabId)}
        >
          <TerminalView tab={t} visible={true} />
        </div>
      ))}
    </div>
  );
}

function TileGridLayout({ tabs, mode }: { tabs: Tab[]; mode: 'tile-grid' | 'auto' }) {
  const setActive = useTabs((s) => s.setActive);
  const tileGrid  = useTabs((s) => s.tileGrid);

  let rows: number;
  let cols: number;
  if (mode === 'auto') {
    const n = Math.max(1, tabs.length);
    cols = Math.ceil(Math.sqrt(n));
    rows = Math.ceil(n / cols);
  } else {
    ({ rows, cols } = tileGrid);
  }

  return (
    <div
      className="absolute inset-0 grid gap-px bg-border overflow-auto"
      style={{
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridTemplateRows:    `repeat(${rows}, minmax(160px, 1fr))`,
        gridAutoRows:        'minmax(160px, 1fr)',
      }}
    >
      {tabs.map((t) => (
        <div
          key={t.tabId}
          className="min-w-0 min-h-0 bg-bg relative"
          onMouseDown={() => setActive(t.tabId)}
        >
          <TerminalView tab={t} visible={true} />
        </div>
      ))}
    </div>
  );
}

function CascadeLayout({ tabs }: { tabs: Tab[] }) {
  const areaRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={areaRef}
      className="absolute inset-0 bg-surface2/30"
      style={{ pointerEvents: dragging ? undefined : undefined }}  // root keeps pointer events
    >
      {/* During drag/resize, suppress pointer events on terminal layers so
          xterm doesn't capture the mouse. We do this by toggling a CSS
          variable consumed by frame children. */}
      <div
        className="absolute inset-0"
        style={{ pointerEvents: dragging ? 'none' : 'auto' }}
      >
        {size.w > 0 && size.h > 0 && tabs.map((t) => (
          <MdiFrame
            key={t.tabId}
            tab={t}
            areaRef={areaRef}
            areaW={size.w}
            areaH={size.h}
            setDragging={setDragging}
          />
        ))}
      </div>
    </div>
  );
}

function PlaceholderLayout({ mode }: { mode: ViewMode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center text-muted text-xs">
      Layout for <span className="mx-1 font-mono">{mode}</span> not yet wired.
    </div>
  );
}
```

Notes:
- The wrapping `<div style={{ pointerEvents: dragging ? 'none' : 'auto' }}>` covers all the frames, suppressing xterm capture during drag/resize. The drag/resize handlers themselves bind `mousemove` to `window`, so they don't need pointer events.
- We render frames only after `size.w/h > 0` so initial-mount clamps don't divide by zero.

- [ ] **Step 2: Smoke-test in dev mode**

```bash
cargo tauri dev
```

Manual checks (open 3+ sessions first):
- Click "Cascade" → frames appear at staircase offsets, each with a title bar and 4 visible chrome buttons (status dot, min, max, close).
- Drag a title bar — frame moves, doesn't escape the area, doesn't drop xterm.
- Resize from each of 8 edges/corners — frame resizes; opposite edge stays put; min size enforced.
- Click a background frame — comes to front, gains the active accent border.
- Double-click a title bar — frame maximizes to fill the area; resize handles disappear; double-click again → restores.
- Click the X on a frame's title bar — closes that tab.
- Click "Tabs view" → returns to the legacy single-active layout. Click "Cascade" again → frames re-appear (geometry reset to staircase only on `open()`; existing frames keep their last position from this session).

- [ ] **Step 3: Verify checks pass**

```bash
npm --prefix ui run typecheck
npm --prefix ui run lint
```

- [ ] **Step 4: Commit**

```bash
git add ui/components/mdi-area.tsx
git commit -m "feat(views): cascade strategy with full MDI

CascadeLayout tracks its own size via ResizeObserver and renders one
MdiFrame per non-minimized tab. A single inner div toggles
pointer-events:none while any drag/resize is in flight so xterm doesn't
capture the mouse. Frames are skipped until area has non-zero size to
avoid first-mount clamp issues."
```

---

## Task 10: Build `MinimizedStrip` and wire minimize/restore

Adds the bottom iconified strip in cascade mode. Restoring a frame removes it from `minimized` and brings it to front.

**Files:**
- Create: `ui/components/minimized-strip.tsx`
- Modify: `ui/components/mdi-area.tsx`

- [ ] **Step 1: Create `ui/components/minimized-strip.tsx`**

```tsx
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
```

- [ ] **Step 2: Mount the strip inside `CascadeLayout`**

In `ui/components/mdi-area.tsx`, import `MinimizedStrip`:

```tsx
import { MinimizedStrip } from './minimized-strip';
```

Update `CascadeLayout` to render the strip and shrink the frame area when it's visible. Replace the current `CascadeLayout` with:

```tsx
function CascadeLayout({ tabs }: { tabs: Tab[] }) {
  const areaRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [dragging, setDragging] = useState(false);
  const minimized = useTabs((s) => s.minimized);
  const hasMinimized = tabs.some((t) => minimized.has(t.tabId)) ||
                       useTabs.getState().tabs.some((t) => minimized.has(t.tabId));

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 28px reserve for the strip when at least one tab is minimized.
  const stripH = hasMinimized ? 28 : 0;

  return (
    <div className="absolute inset-0 bg-surface2/30">
      <div
        ref={areaRef}
        className="absolute left-0 right-0 top-0"
        style={{ bottom: stripH }}
      >
        <div
          className="absolute inset-0"
          style={{ pointerEvents: dragging ? 'none' : 'auto' }}
        >
          {size.w > 0 && size.h > 0 && tabs.map((t) => (
            <MdiFrame
              key={t.tabId}
              tab={t}
              areaRef={areaRef}
              areaW={size.w}
              areaH={size.h}
              setDragging={setDragging}
            />
          ))}
        </div>
      </div>
      <MinimizedStrip />
    </div>
  );
}
```

Notes:
- `tabs` here is the already-filtered "non-minimized" list, so the strip checks `useTabs.getState().tabs` instead to know if any tab in the whole store is minimized. `hasMinimized` keeps the visible cascade area shorter while the strip is up.
- `MinimizedStrip` reads `tabs` and `minimized` from the store directly and renders nothing if empty, so it's safe to mount unconditionally.

- [ ] **Step 3: Smoke-test in dev mode**

```bash
cargo tauri dev
```

Manual checks (open 3 sessions, switch to Cascade):
- Click the minimize button (`-`) on one frame's title bar → frame disappears; a chip with the session name appears in a strip along the bottom of the cascade area.
- Other frames re-render in the slightly-shorter area (28px reserved for the strip).
- Click the chip → frame re-appears in front, accent border on, status preserved (still connected).
- Minimize all frames → all show as chips; cascade area is empty above the strip.
- Switch to "Tabs view" while frames are minimized → those tabs still appear (and take focus on click); minimize state is invisible in tabs mode but preserved.
- Switch back to "Cascade" → minimized state restored; chips visible again.
- Reload the app → minimized state persists across reload (chips re-appear in cascade mode).

- [ ] **Step 4: Verify checks pass**

```bash
npm --prefix ui run typecheck
npm --prefix ui run lint
```

- [ ] **Step 5: Commit**

```bash
git add ui/components/minimized-strip.tsx ui/components/mdi-area.tsx
git commit -m "feat(views): minimized iconified strip for cascade mode

A 28px-tall strip docks at the bottom of the cascade area when any
tab is minimized, showing one chip per minimized session. Click a
chip to restore the frame and bring it to front. Strip persists
across reload via the minimized set in localStorage."
```

---

## Task 11: Wire `Ctrl+Shift+W` cycle keybinding

Single global handler in `MainShell`. Cycles through all 6 modes; for `tile-grid` cycle just sets the mode without opening the dialog (existing dimensions are reused).

**Files:**
- Modify: `ui/components/main-shell.tsx`

- [ ] **Step 1: Add the cycle handler**

In `ui/components/main-shell.tsx`, find the existing `Ctrl+B` keybinding effect (the block that toggles the sidebar). Right after that block, add:

```tsx
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
```

Note: the file already imports `useTabs` at the top (line 5 in the current file) — no new imports needed.

- [ ] **Step 2: Smoke-test in dev mode**

```bash
cargo tauri dev
```

Manual checks (open 2+ sessions):
- Press `Ctrl+Shift+W` repeatedly. Toolbar underline cycles: Tabs → Tile-H → Tile-V → Tile-Grid → Cascade → Auto → Tabs.
- Layout updates after each press.
- Tile-grid via cycle uses the previously-saved rows/cols (no dialog).
- Confirm the chord doesn't conflict with terminal `Ctrl+W` (close-word in some shells). It shouldn't because we require Shift too.

- [ ] **Step 3: Verify checks pass**

```bash
npm --prefix ui run typecheck
npm --prefix ui run lint
```

- [ ] **Step 4: Commit**

```bash
git add ui/components/main-shell.tsx
git commit -m "feat(views): Ctrl+Shift+W cycles view modes

Single global keybinding for the six-mode cycle. Reuses last-saved
rows/cols when cycling through tile-grid (no dialog interrupt)."
```

---

## Task 12: Final pre-PR verification

End-to-end manual run, full lint+typecheck+cargo check, version bump, push branch.

**Files:**
- Modify: `Cargo.toml`

- [ ] **Step 1: Bump workspace version**

Edit `Cargo.toml`: change line 6 from:

```toml
version = "0.11.0"
```

to:

```toml
version = "0.12.0"
```

- [ ] **Step 2: Run all repo-level checks**

```bash
npm --prefix ui run typecheck
npm --prefix ui run lint
cargo check
```

All three must exit 0 with no warnings.

- [ ] **Step 3: Manual end-to-end smoke per spec §10**

```bash
cargo tauri dev
```

Walk through every step in the spec's "Manual test plan":

1. Open 1, 2, 4, 7 tabs; cycle every mode via `Ctrl+Shift+W`. Each terminal stays connected and renders.
2. In cascade: drag, resize from each of 8 handles, double-click title to maximize, minimize, click iconified strip to restore, click background frame to bring to front.
3. Resize main window in each mode — terminals reflow without crashing xterm; cascade frames stay reachable.
4. Toggle SFTP on a tab in `tabs` mode → switch to cascade → switch back. SFTP pane returns in same state.
5. Reload the app: view mode and minimized state restored; cascade geometry resets (expected).
6. Tile-grid dialog with `rows*cols < N` — overflow row appears, bump cols, layout corrects.
7. Disconnect a tab's SSH session in cascade — error overlay renders inside the frame; reconnect works.

If any step fails, fix and re-run from step 2.

- [ ] **Step 4: Commit version bump**

```bash
git add Cargo.toml
git commit -m "chore: bump version 0.11.0 → 0.12.0 (window views)"
```

- [ ] **Step 5: Push the branch**

```bash
git push -u origin feat/window-views
```

- [ ] **Step 6: Open the PR**

```bash
gh pr create --title "feat: mIRC-style window view modes (tile/cascade/tabs/auto)" --body "$(cat <<'EOF'
Closes #30

## Summary
- Six view modes for session tabs: Tabs, Tile Horizontal, Tile Vertical, Tile Grid, Cascade (full MDI), Auto-arrange
- Toolbar at right end of tab strip; `Ctrl+Shift+W` cycles
- Cascade frames are draggable/resizable with title bar (status dot, min/max/close), z-order on click, double-click title to maximize, minimize to bottom iconified strip
- View mode + tile-grid dimensions + minimized set persist via localStorage; cascade geometry stays in-memory per spec
- Frontend-only — no `src-tauri/` changes; no new dependencies
- Spec: `docs/superpowers/specs/2026-04-27-window-views-design.md`
- Plan: `docs/superpowers/plans/2026-04-27-window-views.md`

## Test plan
- [ ] Open 1, 2, 4, 7 tabs; cycle every mode via Ctrl+Shift+W. Each terminal stays connected and renders.
- [ ] Cascade: drag, resize from each of 8 handles, double-click title to maximize, minimize, click iconified strip to restore, click background frame to bring to front.
- [ ] Resize main window in each mode — terminals reflow without crashing xterm; cascade frames stay reachable.
- [ ] Toggle SFTP on a tab in `tabs` mode → switch to cascade → switch back. SFTP pane returns in same state.
- [ ] Reload the app: view mode and minimized state restored; cascade geometry resets (expected).
- [ ] Tile-grid dialog with `rows*cols < N` — overflow row appears, bump cols, layout corrects.
- [ ] Disconnect a tab's SSH session in cascade — error overlay renders inside the frame; reconnect works.
- [ ] `npm --prefix ui run typecheck` clean
- [ ] `npm --prefix ui run lint` clean
- [ ] `cargo check` clean
EOF
)"
```

- [ ] **Step 7: Launch four parallel review agents**

After the PR URL is returned, launch four review subagents in **a single message** (parallel):

1. **Performance** — focus: re-render frequency in the new strategies (zustand selector hygiene, ResizeObserver churn, `cascade` map updates), xterm `safeFit` thrashing during cascade drag, any layout-thrashing CSS.
2. **Security** — focus: any new XSS surface (none expected — pure layout), localStorage handling (no PII; safe-parse on read), event handler scope (window-level mousemove/mouseup correctly torn down).
3. **Completeness** — focus: each requirement and edge case in spec §3, §8, §9 has a corresponding implementation; nothing in the spec is silently dropped.
4. **Code quality** — focus: file boundaries, prop drilling vs store reads, dead code, comments-on-why discipline, naming consistency.

Each agent gets the PR URL, the spec path, and a tight scope statement. Address findings in follow-up commits on the same branch before merging.

---

## Self-Review

Spec coverage:
- §3 toolbar (6 buttons + accent underline) → Task 3
- §3 cascade frame chrome (title bar contents, 8 handles, drag area, double-click, click-to-front) → Tasks 6/7/8
- §3 minimized iconified strip → Task 10
- §3 SFTP pane gating → Tasks 2/4 (only rendered in `tabs` mode)
- §3 keyboard `Ctrl+Shift+W` → Task 11
- §3 persistence (viewMode + tileGrid + minimized; not cascade geom) → Task 1
- §4 architecture (MdiArea strategy split) → Tasks 2/4/5/9
- §5 state shape (ViewMode, CascadeGeometry, actions, defaults, staircase init, close cleanup) → Task 1
- §6 components → Tasks 2/3/8/10 (+ TileGridDialog in Task 3)
- §7 hooks → Tasks 6/7
- §8 data flow (mode change → ResizeObserver → safeFit; click-to-front; min/max/restore; active-tab semantics) → Tasks 4/5/8/9/10
- §9 edge cases:
  - Zero tabs → MdiArea early return (Task 2)
  - One tab → fallthrough; works in every layout
  - Closing during drag → recheck in hooks (Tasks 6/7)
  - Window-resize clamp → display-only clamp in MdiFrame (Task 8)
  - Zero-sized area → `size.w > 0 && size.h > 0` guard in cascade (Task 9)
  - Tile-grid surplus → `gridAutoRows` + container `overflow:auto` (Task 5)
  - Maximized across mode switch → `maximized` flag persists in `cascade` map (Task 1)
  - localStorage parse failure → try/catch in read fns (Task 1)
  - Multi-terminal focus → xterm handles natively
  - Keybinding conflicts → Shift required (Task 11)
- §10 testing → Task 12 step 3 walks the manual plan; lint/typecheck/cargo check enforced
- §11 out-of-scope → not implemented (correct)
- §12 workflow → spec already committed, issue exists, PR + review agents at end of Task 12

Placeholder scan: no `TBD`/`TODO`/`fill in details` in plan steps. Every code step shows the actual code; every command step shows the exact command and expected outcome.

Type consistency:
- `ViewMode`, `CascadeGeometry`, `Tab`, `TabStatus` defined in Task 1 and imported consistently in later tasks.
- Hook signatures (`useMdiDrag`, `useMdiResize`) match consumer call sites in `MdiFrame` (Task 8).
- Store actions (`setViewMode`, `cycleViewMode`, `setTileGrid`, `setCascadeGeom`, `bringToFront`, `minimize`, `restore`, `toggleMaximize`) defined in Task 1 and used identically in Tasks 3, 8, 9, 10, 11.

No drift detected.
