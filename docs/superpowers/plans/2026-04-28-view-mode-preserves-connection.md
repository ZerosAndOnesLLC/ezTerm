# View-Mode-Preserves-Connection Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the SSH-reconnect-on-mode-switch bug by replacing per-mode strategy components with a single stable `MdiArea` root + one `TabSlot` component whose outer `<div>` is the same element type in every mode. Differences become CSS, not different React subtrees. Cascade chrome (title bar + 8 resize handles) becomes a sibling of a stable `terminal-host` div, never a parent. SftpPane stays mounted across mode switches via `display: none`.

**Architecture:** See spec §4–§10. Net effect: `<TerminalView>` and `<SftpPane>` only ever (un)mount when the tab itself is opened/closed, never on a mode change.

**Tech Stack:** Next.js 16, React 19, TypeScript, lucide. No new dependencies. No backend changes.

**Spec:** `docs/superpowers/specs/2026-04-28-view-mode-preserves-connection-design.md`
**Tracking issue:** https://github.com/ZerosAndOnesLLC/ezTerm/issues/34
**Branch:** `fix/view-mode-preserves-connection` (already created, spec committed)

---

## File Map

**New:**
| Path | Responsibility |
|------|----------------|
| `ui/components/cascade-chrome.tsx` | Title bar + 8 resize handles. Chrome only — does NOT wrap the terminal. |
| `ui/components/tab-slot.tsx` | Single per-tab wrapper component used in every view mode. |

**Rewritten:**
| Path | Why |
|------|-----|
| `ui/components/mdi-area.tsx` | Single stable root + `tabs.map(<TabSlot/>)`. No more strategy components. |

**Deleted:**
| Path | Why |
|------|-----|
| `ui/components/mdi-frame.tsx` | Superseded by `tab-slot.tsx` + `cascade-chrome.tsx`. |

**Modified:**
| Path | Why |
|------|-----|
| `Cargo.toml` | Bump `1.1.0` → `1.1.1` (patch — bug fix, no public API change). |

---

## Task 1: Create `cascade-chrome.tsx`

Extracts the chrome (title bar + 8 resize handles + drag binding) from the current `MdiFrame`. The terminal is no longer a child — chrome is positioned absolutely inside the slot, terminal lives as a sibling.

**Files:**
- Create: `ui/components/cascade-chrome.tsx`

- [ ] **Step 1: Create the file**

```tsx
'use client';
import { Maximize2, Minimize2, Minus, X } from 'lucide-react';
import type { RefObject } from 'react';
import { useTabs, type Tab } from '@/lib/tabs-store';
import { useMdiDrag } from '@/lib/use-mdi-drag';
import { useMdiResize, type ResizeEdge } from '@/lib/use-mdi-resize';
import { StatusDot } from './status-dot';

interface Props {
  tab: Tab;
  areaRef: RefObject<HTMLDivElement | null>;
  areaW: number;
  areaH: number;
  setDragging: (v: boolean) => void;
  maximized: boolean;
}

const HANDLES: readonly { edge: ResizeEdge; cls: string; cursor: string }[] = [
  { edge: 'n',  cls: 'top-0 left-2 right-2 h-1',    cursor: 'ns-resize'   },
  { edge: 's',  cls: 'bottom-0 left-2 right-2 h-1', cursor: 'ns-resize'   },
  { edge: 'e',  cls: 'top-2 bottom-2 right-0 w-1',  cursor: 'ew-resize'   },
  { edge: 'w',  cls: 'top-2 bottom-2 left-0 w-1',   cursor: 'ew-resize'   },
  { edge: 'ne', cls: 'top-0 right-0 w-2 h-2',       cursor: 'nesw-resize' },
  { edge: 'nw', cls: 'top-0 left-0 w-2 h-2',        cursor: 'nwse-resize' },
  { edge: 'se', cls: 'bottom-0 right-0 w-2 h-2',    cursor: 'nwse-resize' },
  { edge: 'sw', cls: 'bottom-0 left-0 w-2 h-2',     cursor: 'nesw-resize' },
];

export function CascadeChrome({ tab, areaRef, areaW, areaH, setDragging, maximized }: Props) {
  const minimize  = useTabs((s) => s.minimize);
  const toggleMax = useTabs((s) => s.toggleMaximize);
  const close     = useTabs((s) => s.close);

  const drag = useMdiDrag({
    tabId: tab.tabId, areaRef,
    onDragStart: () => setDragging(true),
    onDragEnd:   () => setDragging(false),
  });

  return (
    <>
      {/* Title bar — drag handle for the frame; double-click toggles maximize. */}
      <div
        className="absolute left-0 right-0 top-0 h-6 flex items-center gap-2 px-2 select-none cursor-move border-b border-border bg-surface/95"
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
          title={maximized ? 'Restore' : 'Maximize'}
          aria-label={maximized ? 'Restore' : 'Maximize'}
          className="icon-btn w-5 h-5"
        >
          {maximized ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
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
      {/* Resize handles only when the frame can actually resize. */}
      {!maximized && HANDLES.map((h) => (
        <ResizeHandle
          key={h.edge}
          tabId={tab.tabId}
          areaRef={areaRef}
          edge={h.edge}
          cls={h.cls}
          cursor={h.cursor}
          setDragging={setDragging}
        />
      ))}
    </>
  );
}

interface HandleProps {
  tabId: string;
  areaRef: RefObject<HTMLDivElement | null>;
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

- [ ] **Step 2: Run checks**

```
npm --prefix ui run typecheck
npm --prefix ui run lint
```

Both must exit 0. (Pre-existing 3 warnings in `sync-dialog.tsx` are unrelated.)

- [ ] **Step 3: Commit**

```
git add ui/components/cascade-chrome.tsx
git commit -m "feat(views): CascadeChrome — chrome-only cascade decoration

Title bar (status dot, name, min/max/close) + 8 resize handles + drag
binding via useMdiDrag. Returns a fragment of two absolutely-positioned
elements that overlay the slot they're rendered into; does NOT wrap a
terminal. Drop-in for the chrome half of the old MdiFrame component.
The terminal is now rendered by TabSlot as a sibling of CascadeChrome."
```

---

## Task 2: Create `tab-slot.tsx`

Single component that handles all six view modes via CSS. Outer `<div>` is the same React element type in every mode; only its `className`/`style` and conditional siblings change.

**Files:**
- Create: `ui/components/tab-slot.tsx`

- [ ] **Step 1: Create the file**

```tsx
'use client';
import dynamic from 'next/dynamic';
import type { CSSProperties, RefObject } from 'react';
import { useTabs, type Tab, type ViewMode, type CascadeGeometry } from '@/lib/tabs-store';
import { CascadeChrome } from './cascade-chrome';
import { SftpPane } from './sftp-pane';

const TerminalView = dynamic(
  () => import('./terminal').then((m) => m.TerminalView),
  { ssr: false },
);

interface Props {
  tab: Tab;
  viewMode: ViewMode;
  isActive: boolean;
  isMinimized: boolean;
  cascadeAreaRef: RefObject<HTMLDivElement | null>;
  cascadeAreaW: number;
  cascadeAreaH: number;
  cascadeGeom?: CascadeGeometry;     // undefined-safe; cascade mode reads it, others don't
  dragging: boolean;
  setDragging: (v: boolean) => void;
}

// One enum, one place to compute "what kind of slot is this in this render?"
// All other styling decisions are derived from this.
type SlotKind = 'hidden' | 'tabs-active' | 'tile-flex' | 'tile-grid' | 'cascade';

function classifySlot(viewMode: ViewMode, isActive: boolean, isMinimized: boolean): SlotKind {
  if (isMinimized) return 'hidden';
  if (viewMode === 'tabs') return isActive ? 'tabs-active' : 'hidden';
  if (viewMode === 'tile-h' || viewMode === 'tile-v') return 'tile-flex';
  if (viewMode === 'tile-grid' || viewMode === 'auto') return 'tile-grid';
  return 'cascade';
}

export function TabSlot({
  tab, viewMode, isActive, isMinimized,
  cascadeAreaRef, cascadeAreaW, cascadeAreaH, cascadeGeom,
  dragging, setDragging,
}: Props) {
  const setActive    = useTabs((s) => s.setActive);
  const bringToFront = useTabs((s) => s.bringToFront);
  const kind = classifySlot(viewMode, isActive, isMinimized);

  // Compute slot styling. Same outer element type (a <div>) for every kind so
  // React reconciliation never unmounts the terminal-host child.
  let slotClass: string;
  let slotStyle: CSSProperties;
  switch (kind) {
    case 'hidden':
      slotClass = 'absolute inset-0';
      slotStyle = { visibility: 'hidden', pointerEvents: 'none' };
      break;
    case 'tabs-active':
      slotClass = 'absolute inset-0 flex';
      slotStyle = {};
      break;
    case 'tile-flex':
      slotClass = 'flex-1 min-w-0 min-h-0 bg-bg relative';
      slotStyle = {};
      break;
    case 'tile-grid':
      slotClass = 'min-w-0 min-h-0 bg-bg relative';
      slotStyle = {};
      break;
    case 'cascade': {
      // Display-only clamp so a previously-stored geometry doesn't leak
      // off-screen after a window resize. We don't write back; user dragging
      // will normalise.
      const g = cascadeGeom;
      if (!g || cascadeAreaW === 0 || cascadeAreaH === 0) {
        // Defensive: cascade frame with no geometry yet — render hidden until
        // the store fills it in (which open() does at tab creation time, so
        // this branch should be unreachable in practice).
        slotClass = 'absolute inset-0';
        slotStyle = { visibility: 'hidden', pointerEvents: 'none' };
        break;
      }
      const w = Math.min(g.w, Math.max(200, cascadeAreaW));
      const h = Math.min(g.h, Math.max(120, cascadeAreaH));
      const x = Math.max(0, Math.min(cascadeAreaW - w, g.x));
      const y = Math.max(0, Math.min(cascadeAreaH - h, g.y));
      slotClass = `absolute bg-bg border rounded-md shadow-lg overflow-hidden ${
        isActive ? 'border-accent' : 'border-border'
      }`;
      slotStyle = { left: x, top: y, width: w, height: h, zIndex: g.z };
      break;
    }
  }

  function focusSlot() {
    if (!isActive) setActive(tab.tabId);
    if (kind === 'cascade') bringToFront(tab.tabId);
  }

  // Chrome and SFTP rendering rules:
  //   - Cascade chrome only for visible cascade slots.
  //   - SftpPane mounted whenever tab.sftpOpen, but hidden via display:none in
  //     non-tabs modes. Mount/unmount only on the explicit user toggle, never
  //     on a mode switch — preserves the pane's local state across mode flips.
  const showCascadeChrome = kind === 'cascade';
  const sftpVisible = kind === 'tabs-active' && tab.sftpOpen && tab.session.session_kind === 'ssh';
  const sftpMounted = tab.sftpOpen && tab.session.session_kind === 'ssh';

  // Terminal-host positioning differs in cascade (room for title bar) vs
  // every other mode (fill the slot).
  const hostStyle: CSSProperties = kind === 'cascade'
    ? { position: 'absolute', left: 0, right: 0, top: 24, bottom: 0 }
    : { position: 'absolute', inset: 0 };

  // pointer-events suppression on the terminal-host while a cascade drag is
  // in flight. Only matters in cascade mode; in other modes `dragging` is
  // always false so this is a no-op.
  const hostPointerEvents = dragging && kind === 'cascade' ? 'none' : 'auto';

  return (
    <div
      className={slotClass}
      style={slotStyle}
      onMouseDown={kind === 'cascade' || kind === 'tile-flex' || kind === 'tile-grid' ? focusSlot : undefined}
      role="group"
      aria-label={kind === 'cascade' ? `${tab.session.name} window` : undefined}
      aria-hidden={kind === 'hidden' || undefined}
    >
      {showCascadeChrome && (
        <CascadeChrome
          key="chrome"
          tab={tab}
          areaRef={cascadeAreaRef}
          areaW={cascadeAreaW}
          areaH={cascadeAreaH}
          setDragging={setDragging}
          maximized={!!cascadeGeom?.maximized}
        />
      )}
      {sftpMounted && (
        <div
          key="sftp"
          // display:none keeps SftpPane mounted (preserves local state) while
          // hiding it visually in non-tabs modes. The user can flip back to
          // tabs and find the pane in the same state they left it.
          style={{ display: sftpVisible ? 'flex' : 'none' }}
        >
          <SftpPane tab={tab} />
        </div>
      )}
      <div
        key="terminal-host"
        className="bg-bg"
        style={{ ...hostStyle, pointerEvents: hostPointerEvents }}
      >
        <TerminalView tab={tab} visible={kind !== 'hidden'} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run checks**

```
npm --prefix ui run typecheck
npm --prefix ui run lint
```

Both must exit 0.

- [ ] **Step 3: Commit**

```
git add ui/components/tab-slot.tsx
git commit -m "feat(views): TabSlot — single per-tab wrapper for all six modes

Outer <div> is the same React element type in every viewMode; only
className/style and conditional siblings (cascade chrome, sftp pane)
change. Children with stable keys so React reconciliation preserves
the terminal-host div across mode switches — meaning TerminalView
never unmounts due to a mode change, so its disconnect cleanup never
fires due to a mode change either.

Hidden slots use absolute inset-0 + visibility:hidden so they're
off-flow in flex/grid layouts but xterm dimensions stay valid.
SftpPane is mounted whenever tab.sftpOpen and hidden via display:none
in non-tabs modes — preserves pane state across mode flips."
```

---

## Task 3: Rewrite `mdi-area.tsx`

Single root `<div>`, single `tabs.map(<TabSlot/>)` block, `MinimizedStrip` rendered conditionally for cascade mode. All cascade-area state hoisted here.

**Files:**
- Modify: `ui/components/mdi-area.tsx`

- [ ] **Step 1: Replace the entire contents of `ui/components/mdi-area.tsx` with:**

```tsx
'use client';
import { useEffect, useRef, useState } from 'react';
import { Terminal } from 'lucide-react';
import { useTabs } from '@/lib/tabs-store';
import { EmptyState } from './empty-state';
import { TabSlot } from './tab-slot';
import { MinimizedStrip } from './minimized-strip';

export function MdiArea() {
  const tabs      = useTabs((s) => s.tabs);
  const activeId  = useTabs((s) => s.activeId);
  const viewMode  = useTabs((s) => s.viewMode);
  const minimized = useTabs((s) => s.minimized);
  const tileGrid  = useTabs((s) => s.tileGrid);
  const cascade   = useTabs((s) => s.cascade);

  // Cascade area metadata is hoisted here so it stays live across all view
  // modes. The MdiArea root div doubles as the cascade area for clamping.
  // In non-cascade modes setSize / dragging are still updated by the
  // ResizeObserver but nothing consumes them.
  const areaRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      // Skip the state write when dimensions are unchanged. ResizeObserver
      // fires for sub-pixel changes too, which would re-render every
      // TabSlot and re-fit every xterm via prop change.
      setSize((cur) => (cur.w === w && cur.h === h ? cur : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (tabs.length === 0) {
    return (
      <EmptyState
        icon={Terminal}
        title="Ready to connect"
        body="Double-click a session in the sidebar, or create a new one to get started."
      />
    );
  }

  // Root container styling depends on the layout direction needed by the
  // children. Tabs/cascade are absolutely-positioned children — the root is
  // a positioning context. Tile modes use flex/grid on the root.
  let rootClass = 'absolute inset-0';
  let rootStyle: React.CSSProperties = {};
  switch (viewMode) {
    case 'tabs':
      // Children: one slot per tab, each absolute inset-0; only the active
      // one is visible. Same as today.
      rootClass = 'absolute inset-0';
      break;
    case 'tile-h':
      rootClass = 'absolute inset-0 flex flex-col gap-px bg-border';
      break;
    case 'tile-v':
      rootClass = 'absolute inset-0 flex flex-row gap-px bg-border';
      break;
    case 'tile-grid':
    case 'auto': {
      const visibleCount = tabs.filter((t) => !minimized.has(t.tabId)).length;
      let rows: number;
      let cols: number;
      if (viewMode === 'auto') {
        const n = Math.max(1, visibleCount);
        cols = Math.ceil(Math.sqrt(n));
        rows = Math.ceil(n / cols);
      } else {
        ({ rows, cols } = tileGrid);
      }
      rootClass = 'absolute inset-0 grid gap-px bg-border overflow-auto';
      rootStyle = {
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridTemplateRows:    `repeat(${rows}, minmax(160px, 1fr))`,
        gridAutoRows:        'minmax(160px, 1fr)',
      };
      break;
    }
    case 'cascade':
      rootClass = 'absolute inset-0 bg-surface2/30';
      break;
  }

  // Strip reservation only depends on whether ANY tab is minimized. Pulling
  // a boolean keeps this from re-rendering on every status tick.
  const hasMinimized = minimized.size > 0;
  const stripH = viewMode === 'cascade' && hasMinimized ? 28 : 0;

  return (
    <div className="absolute inset-0">
      <div
        ref={areaRef}
        className={rootClass}
        style={{ ...rootStyle, bottom: stripH > 0 ? stripH : undefined }}
      >
        {tabs.map((t) => (
          <TabSlot
            key={t.tabId}
            tab={t}
            viewMode={viewMode}
            isActive={t.tabId === activeId}
            isMinimized={minimized.has(t.tabId)}
            cascadeAreaRef={areaRef}
            cascadeAreaW={size.w}
            cascadeAreaH={size.h}
            cascadeGeom={cascade[t.tabId]}
            dragging={dragging}
            setDragging={setDragging}
          />
        ))}
      </div>
      {viewMode === 'cascade' && <MinimizedStrip />}
    </div>
  );
}
```

- [ ] **Step 2: Run checks**

```
npm --prefix ui run typecheck
npm --prefix ui run lint
```

Both must exit 0.

- [ ] **Step 3: Commit**

```
git add ui/components/mdi-area.tsx
git commit -m "fix(views): single MdiArea root preserves SSH connections across modes

Replace the per-mode strategy components (TabsLayout / TileFlexLayout /
TileGridLayout / CascadeLayout) with a single MdiArea that always
returns the same root <div> shape and one tabs.map(<TabSlot/>) block.
Slots are keyed by tabId and the inner terminal-host div has a stable
key inside TabSlot, so React preserves the entire <TerminalView>
subtree across viewMode changes. The disconnect cleanup in TerminalView
no longer fires on mode switches.

Cascade-specific state (areaRef, size, dragging) is hoisted to MdiArea
so it stays live in every mode (cheap: setSize is only triggered by
the existing ResizeObserver on the root div, dragging stays false in
non-cascade modes).

Closes #34."
```

---

## Task 4: Delete the dead `mdi-frame.tsx`

`MdiFrame` is fully superseded by `TabSlot` + `CascadeChrome`. Delete the file and verify nothing imports it.

**Files:**
- Delete: `ui/components/mdi-frame.tsx`

- [ ] **Step 1: Verify no imports remain**

```
grep -rn "mdi-frame\|MdiFrame" ui/ src-tauri/ 2>&1 | grep -v node_modules
```

Expected: no matches outside of comments/docs. If any remain, stop and fix.

- [ ] **Step 2: Delete the file**

```
git rm ui/components/mdi-frame.tsx
```

- [ ] **Step 3: Run checks**

```
npm --prefix ui run typecheck
npm --prefix ui run lint
```

Both must exit 0. (If typecheck fails complaining about `MdiFrame`, something still imports it — go back to Step 1.)

- [ ] **Step 4: Commit**

```
git commit -m "refactor(views): delete mdi-frame.tsx (superseded)

MdiFrame's title bar + handles + drag binding moved to CascadeChrome
(chrome-only). The terminal child role moved to TabSlot's stable
terminal-host div. Removing the file ensures no future edit can
re-introduce the wrap-the-terminal pattern that caused #34."
```

---

## Task 5: Final verification, version bump, PR, four-reviewer pass

**Files:**
- Modify: `Cargo.toml`

- [ ] **Step 1: Bump workspace version**

Edit `Cargo.toml`: `1.1.0` → `1.1.1` (patch — bug fix only).

- [ ] **Step 2: Run all repo-level checks**

```
npm --prefix ui run typecheck
npm --prefix ui run lint
cargo check 2>&1 | tail -5
```

All must exit clean. Lint will show 3 pre-existing warnings on `sync-dialog.tsx` from main; those are not from this change.

- [ ] **Step 3: Manual smoke test in dev mode** (per spec §12)

```
cargo tauri dev
```

Walk these steps. Each MUST pass before opening the PR:

1. Open one or more SSH sessions; start `top` or `tail -f /var/log/syslog` in one tab.
2. Press `Ctrl+Shift+W` six times to round-trip every mode.
   - Pass: the running process keeps running. No "Connection closed" overlay. Status dot stays green.
3. Open the SFTP pane on an SSH tab; navigate to a deep dir. Switch to cascade. Switch back to tabs.
   - Pass: SFTP pane reopens at the same dir; no spinner / re-listing.
4. In cascade mode: drag a frame, resize from each handle, double-click title to maximize, minimize, click iconified strip to restore, click background frame to bring forward. All still work.
5. Close/reopen the app. View mode + minimized state restored from `localStorage`. Cascade geometry resets to staircase (intentional).

If anything fails: fix on this branch and re-run. Do not open the PR with a broken smoke pass.

- [ ] **Step 4: Commit version bump**

```
git add Cargo.toml Cargo.lock
git commit -m "chore: bump version 1.1.0 → 1.1.1 (mode-switch reconnect fix)"
```

- [ ] **Step 5: Push the branch**

```
git push -u origin fix/view-mode-preserves-connection
```

- [ ] **Step 6: Open the PR**

```
gh pr create --title "fix(views): mode switches no longer reconnect SSH" --body "$(cat <<'EOF'
Closes #34

## Summary
Switching window view modes was tearing down and reconnecting every SSH session. Root cause: \`MdiArea\` returned a different React component type per \`viewMode\` (TabsLayout / TileFlexLayout / TileGridLayout / CascadeLayout), so React reconciliation unmounted the previous subtree on each mode change, which unmounted \`TerminalView\`, which fired its disconnect cleanup.

This PR replaces the strategy components with a single \`MdiArea\` root + one \`TabSlot\` per tab. The outer wrapper element type is the same in every mode; differences are CSS only. Cascade chrome (title bar + 8 resize handles) is now a sibling of a stable terminal-host div, not a parent of it. SftpPane is also kept mounted across mode switches via display:none, so its local state survives mode flips.

Patch release (1.1.0 → 1.1.1).

- Spec: \`docs/superpowers/specs/2026-04-28-view-mode-preserves-connection-design.md\`
- Plan: \`docs/superpowers/plans/2026-04-28-view-mode-preserves-connection.md\`

## Test plan
- [ ] Run \`top\` in a tab, cycle every view mode via \`Ctrl+Shift+W\` — process keeps running, status dot stays green
- [ ] Open SFTP pane at a deep dir, switch to cascade and back — pane reopens at the same dir without re-listing
- [ ] Cascade interactions (drag, resize from each handle, min/max/restore, double-click maximize, click-to-front) all still work
- [ ] Reload the app — view mode and minimized state restored, cascade geometry resets to staircase (intentional)
- [x] \`npm --prefix ui run typecheck\` clean
- [x] \`npm --prefix ui run lint\` clean (3 pre-existing warnings in sync-dialog.tsx are unrelated)
- [x] \`cargo check\` clean
EOF
)"
```

- [ ] **Step 7: Launch four parallel review agents (single message, parallel)**

Dispatch performance, security, completeness, and code-quality reviewers in one message. Each gets the PR URL, the spec path, the diff range (`main..fix/view-mode-preserves-connection`), and a tight scope statement. After findings come back: **present them grouped by severity to the user; do not auto-apply.** Wait for per-finding direction.

---

## Self-Review

Spec coverage check:
- §4 architecture (single MdiArea root, TabSlot per tab, CascadeChrome as sibling) → Tasks 1–4
- §5 hidden-tab visibility rule → Task 2 (`classifySlot`'s `'hidden'` branch)
- §6 per-mode slot styling table → Task 2 (the `switch (kind)` block matches the table)
- §7 hoisted state → Task 3 (`areaRef`, `size`, `dragging` in MdiArea)
- §8 SftpPane persistence → Task 2 (`sftpMounted` is `tab.sftpOpen`, `display: none` flip via `sftpVisible`)
- §9 file map (new tab-slot.tsx, new cascade-chrome.tsx, rewritten mdi-area.tsx, deleted mdi-frame.tsx) → Tasks 1, 2, 3, 4
- §10 reconciliation invariants 1–5 → preserved by Task 2/3 design (verified by inspection: every code path keeps the same root element type, stable child keys, mounted SftpPane on `tab.sftpOpen`)
- §11 edge cases → all handled in code: window resize (Task 3 ResizeObserver), zero-size area (Task 2 cascade defensive branch), drag-mid-mode-switch (slot stays mounted), tab close (only path that disconnects), SFTP toggle outside tabs mode (mounts hidden, reveals on flip back), minimized cross-mode (`'hidden'` branch wins regardless of mode)
- §12 testing (manual smoke + lint/typecheck/cargo check) → Task 5

Placeholder scan: no `TBD`/`TODO` markers; every code step shows the actual code; every command step shows the exact invocation and the expected outcome.

Type consistency:
- `TabSlot`'s `Props` shape (`cascadeAreaRef`, `cascadeAreaW`, `cascadeAreaH`, `cascadeGeom?`, `dragging`, `setDragging`) matches the prop names passed in Task 3.
- `CascadeChrome`'s `Props` shape matches the call site in Task 2 (`tab`, `areaRef`, `areaW`, `areaH`, `setDragging`, `maximized`).
- `RefObject<HTMLDivElement | null>` is used consistently (matches the React 19 fix that landed earlier on this codebase).
- Action names from the store (`bringToFront`, `setActive`, `minimize`, `toggleMaximize`, `close`) match `tabs-store.ts` exports.

No drift detected.
