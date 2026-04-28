# Window Views — Design Spec

**Date:** 2026-04-27
**Status:** Approved (design phase)
**Tracking issue:** [#30](https://github.com/ZerosAndOnesLLC/ezTerm/issues/30)

## 1. Goal

Give ezTerm mIRC-style multi-window view modes for its session tabs:

- **Tabs** — current behavior; only the focused terminal is visible.
- **Tile Horizontal** — every visible terminal stacked in rows, full width each.
- **Tile Vertical** — every visible terminal side-by-side in columns, full height each.
- **Tile Grid** — `rows × cols` grid; user picks dimensions via small dialog.
- **Cascade** — full MDI: each terminal is a draggable, resizable, overlapping floating frame with title bar (minimize / maximize / close), z-order on click, double-click title to maximize, minimize to a bottom iconified strip.
- **Auto-arrange** — `tile-grid` with `cols = ceil(sqrt(N))`, recomputed as tabs open and close.

The view mode is **global** (one mode for all tabs), driven by a 6-button toolbar at the right end of the existing tab strip and cycled with `Ctrl+Shift+W`.

## 2. Non-Goals (v1)

- Persisting cascade geometry across restarts.
- Saving / loading named layouts.
- Drag-to-detach a tab into a floating window from `tabs` mode.
- Snap-to-edge / snap-to-frame.
- Aspect-ratio-aware auto-arrange.
- Any backend (`src-tauri/`) changes.

## 3. UX Requirements

### Toolbar

Six icon buttons appended to the right of the tab strip in `TabsShell`:

| Button | Mode | Tooltip |
|--------|------|---------|
| Tabs icon | `tabs` | "Tabs view" |
| Stacked rows | `tile-h` | "Tile horizontal" |
| Side-by-side cols | `tile-v` | "Tile vertical" |
| Grid icon | `tile-grid` | "Tile grid…" (opens dialog) |
| Overlapping squares | `cascade` | "Cascade" |
| Auto / sparkle | `auto` | "Auto-arrange" |

The active mode's button shows the accent underline used elsewhere in the app (`§6.4` of the existing design system).

### Cascade frame chrome

Each `MdiFrame` has:

- **Title bar** (24px tall): status dot, session name, spacer, three buttons — minimize, maximize/restore, close.
- **8 resize handles**: 4 edges (n/s/e/w, 4px hit zone) and 4 corners (ne/nw/se/sw, 8×8 hit zone).
- **Drag area** = the title bar (anywhere except the three buttons).
- **Min size** 200 × 120 px.
- **Click anywhere in frame** brings to front (`bringToFront`) and sets `activeId`.
- **Double-click title bar** toggles maximize.

### Minimized iconified strip

Only rendered when `viewMode === 'cascade'` and `minimized.size > 0`. A 28px-tall row docked at the bottom of the MDI area showing one chip per minimized tab (status dot + name + restore-on-click). Mirrors mIRC's iconified strip.

### SFTP pane

The SFTP side-pane (`tab.sftpOpen`) only renders in `tabs` mode. In any other mode the pane is hidden but `tab.sftpOpen` is preserved, so switching back to `tabs` restores it. The SFTP toggle button on the tab strip remains functional in all modes (clicking it just won't show the pane until the user is back in `tabs`).

### Keyboard

Single shortcut: **`Ctrl+Shift+W`** cycles `tabs → tile-h → tile-v → tile-grid → cascade → auto → tabs`. No per-mode shortcuts.

### Persistence (`localStorage`)

Persisted:
- `viewMode`
- `tileGrid` (rows × cols)
- `minimized` (as a serialized array of tabIds)

Not persisted:
- Cascade geometry (`cascade` map)
- Z-order counter (`nextZ`)

(Tab list itself doesn't survive restart today, so persisting cascade geometry would have nothing to attach to.)

## 4. Architecture

```
TabsShell
├── tab strip  ──────────────────  ViewModeToolbar (NEW, 6 buttons + dialog launcher)
├── MdiArea (NEW, replaces existing inner div)
│   ├── strategy: tabs       → existing absolute + visibility:hidden layout
│   ├── strategy: tile-h     → flex column, flex:1 per tab
│   ├── strategy: tile-v     → flex row, flex:1 per tab
│   ├── strategy: tile-grid  → CSS grid from store.tileGrid
│   ├── strategy: auto       → CSS grid, cols=ceil(sqrt(N))
│   └── strategy: cascade    → absolutely-positioned MdiFrame per tab
│                              + MinimizedStrip at bottom when minimized.size > 0
└── (status bar, toasts — unchanged)
```

The xterm visibility invariant ("never give xterm a 0×0 container or `display:none`") is preserved across all strategies — terminals stay mounted in every mode; only positioning, sizing, or `visibility` changes. xterm's existing per-terminal `ResizeObserver` already triggers `safeFit` when geometry changes, so layout switches don't need any extra terminal-side wiring.

No backend changes. No new Rust commands. No DB or migration changes.

## 5. State (Zustand `tabs-store.ts`)

Additions to `TabsState`:

```ts
export type ViewMode =
  | 'tabs' | 'tile-h' | 'tile-v' | 'tile-grid' | 'cascade' | 'auto';

export interface CascadeGeometry {
  x: number; y: number; w: number; h: number;
  z: number;                  // monotonically assigned, higher = on top
  maximized: boolean;
  prevGeom?: { x: number; y: number; w: number; h: number };  // restore target
}

interface TabsState {
  // ...existing fields preserved...
  viewMode:  ViewMode;
  tileGrid:  { rows: number; cols: number };
  cascade:   Record<string, CascadeGeometry>;
  minimized: Set<string>;
  nextZ:     number;

  setViewMode:    (m: ViewMode) => void;
  cycleViewMode:  () => void;
  setTileGrid:    (rows: number, cols: number) => void;
  setCascadeGeom: (tabId: string, g: Partial<CascadeGeometry>) => void;
  bringToFront:   (tabId: string) => void;
  minimize:       (tabId: string) => void;
  restore:        (tabId: string) => void;
  toggleMaximize: (tabId: string, areaW: number, areaH: number) => void;
}
```

Defaults:
- `viewMode: 'tabs'`
- `tileGrid: { rows: 2, cols: 2 }`
- `cascade: {}`, `minimized: new Set()`, `nextZ: 1`

Existing `open(session)` initializes a staircase-offset `CascadeGeometry` for the new tab so cascade view "just works" without lazy initialization later:

```
const count = Object.keys(s.cascade).length;
const offset = (count % 10) * 30;
cascade[tabId] = {
  x: offset, y: offset, w: 640, h: 400,
  z: ++s.nextZ, maximized: false,
};
```

`close(tabId)` deletes the tab's entries from `cascade` and `minimized`.

Persistence: a small `subscribe` block in `tabs-store.ts` writes `viewMode`, `tileGrid`, and `Array.from(minimized)` to `localStorage` on change; module-level init reads them back, falling back to defaults on parse failure.

## 6. Components (all in `ui/components/`)

### `view-mode-toolbar.tsx`

Renders six buttons. Active mode gets the accent underline. The Tile Grid button opens `<TileGridDialog>` on click instead of immediately switching mode (and sets `viewMode='tile-grid'` only after dialog OK).

### `mdi-area.tsx`

Reads `tabs`, `viewMode`, `tileGrid`, `cascade`, `minimized`, `activeId` from the store. Returns one of:

- `tabs`: today's absolute + visibility:hidden layout (lifted out of `TabsShell`).
- `tile-h` / `tile-v`: flex container with `flex:1` children, one per non-minimized tab.
- `tile-grid` / `auto`: `display:grid` with computed `gridTemplateRows`/`gridTemplateColumns`.
- `cascade`: `position:relative` container; one `<MdiFrame>` per non-minimized tab; `<MinimizedStrip>` if `minimized.size > 0`.

In `tabs` mode renders `<SftpPane>` per tab when `tab.sftpOpen`; suppressed in all other modes.

Tracks its own size with a `ResizeObserver` on the container for cascade frame clamping and maximize sizing.

### `mdi-frame.tsx`

Absolutely-positioned div (uses `cascade[tabId]` for `left/top/width/height/zIndex`). Children:
- Title bar (status dot, name, min/max/close, drag binding via `useMdiDrag`).
- Terminal content: `<TerminalView tab={tab} visible={true} />`. No `<SftpPane>` inside the frame — SFTP is `tabs`-mode only in v1.
- 8 resize handle divs (one per edge/corner, bound via `useMdiResize`).

`onMouseDown` on the frame calls `bringToFront(tabId)` and `setActive(tabId)`.

### `minimized-strip.tsx`

Renders a horizontal row of chips at the bottom of the MDI area. Each chip: status dot + truncated session name; click → `restore(tabId)`.

### `tile-grid-dialog.tsx`

Small modal: two number inputs (rows 1–8, cols 1–8), OK / Cancel. On OK: `setTileGrid(r, c)` then `setViewMode('tile-grid')`.

## 7. Hooks (in `ui/lib/`)

### `useMdiDrag.ts`

```ts
useMdiDrag({
  tabId, areaRef, onDragStart, onDragEnd
}): { onMouseDown }  // bind to title bar
```

`mousedown` → records start mouse pos and start geometry → attaches `mousemove`/`mouseup` to `window` → on each move, updates `cascade[tabId].{x,y}` clamped to `[0, areaW-w] × [0, areaH-h]` → on `mouseup`, detaches handlers. Sets a `pointer-events:none` flag on the MDI area's terminal layer during drag (same pattern as the existing sidebar resize handler in `main-shell.tsx`) so xterm doesn't capture the mouse mid-drag.

### `useMdiResize.ts`

```ts
useMdiResize({
  tabId, areaRef, edge: 'n'|'s'|'e'|'w'|'ne'|'nw'|'se'|'sw'
}): { onMouseDown }   // bind to handle div
```

Same lifecycle as drag, but adjusts `{x, y, w, h}` according to which edge(s) the handle controls, preserving the opposite edge. Clamps to `min 200×120` and to area bounds.

## 8. Data Flow

**Mode change:** `setViewMode(m)` → store updates → `MdiArea` re-renders with new strategy → each `TerminalView`'s `ResizeObserver` fires → `safeFit()` → `api.{ssh|local}Resize(connId, cols, rows)`. No new wiring; existing observer handles all cases.

**Cascade drag:** `mousedown` → drag hook records start state → `mousemove` updates `cascade[tabId]` (clamped) → `mouseup` finalizes. Frame re-renders on each store write; xterm `ResizeObserver` fires on resize-style drags only.

**Click-to-front:** `mousedown` on `MdiFrame` → `bringToFront(tabId)` increments `nextZ` and writes to `cascade[tabId].z` → frame re-renders with new `zIndex`.

**Minimize / Restore / Maximize:** straightforward store mutations; frame disappears or fills MDI area accordingly.

**Active tab semantics:** in `tabs` mode, `activeId` drives visibility (existing). In all other modes, every non-minimized terminal is visible; `activeId` only controls the focused tab strip highlight, status bar target, and SFTP toggle target. Clicking a tile cell or cascade frame calls `setActive(tabId)`; in cascade also `bringToFront(tabId)`.

## 9. Edge Cases

- **Zero tabs** — `MdiArea` renders existing `EmptyState` regardless of mode.
- **One tab** — Tile/auto: one cell fills area. Cascade: one frame at staircase offset 0.
- **Closing last visible tab in cascade** — `close()` cleans `cascade[tabId]` and `minimized` entries.
- **Closing tab during drag** — drag hook checks tab still exists in store before writing geometry on `mouseup`.
- **Window resize shrinking MDI area** — `MdiFrame` clamps its read of `{x,y,w,h}` for display only; user drag overwrites with valid values. Maximized frames track area size automatically (no stored geometry while maximized).
- **MDI area zero-sized during initial mount** — guards on `areaW > 0 && areaH > 0`; `safeFit` already tolerates 0×0.
- **Tile-grid with `rows*cols < N`** — surplus tabs flow into an overflow row at the bottom (`overflow:auto`). Visible to the user so they can bump grid size.
- **Switch cascade → another mode while a frame is maximized** — `maximized` flag persists; ignored outside cascade; switching back restores state.
- **localStorage parse failure** — try/catch on read, fall back to defaults.
- **Multiple visible terminals + focus** — xterm captures focus on click; nothing extra needed.
- **Keyboard chord conflict** — `Ctrl+Shift+W` does not collide with xterm's `Ctrl+Shift+C/V/F` shortcuts.

## 10. Testing

No React component test infrastructure exists in `ui/` yet; adding one is out of scope.

**Required pre-PR checks:**
- `npm --prefix ui run lint` (no warnings)
- `npm --prefix ui run typecheck`
- `cargo check` (untouched but per global rules)

**Manual test plan (PR description checklist):**

1. Open 1, 2, 4, 7 tabs; cycle every mode via `Ctrl+Shift+W`. Each terminal stays connected and renders.
2. In cascade: drag, resize from each of 8 handles, double-click title to maximize, minimize, click iconified strip to restore, click background frame to bring to front.
3. Resize main window in each mode — terminals reflow without crashing xterm; cascade frames stay reachable.
4. Toggle SFTP on a tab in `tabs` mode → switch to cascade → switch back. SFTP pane returns in same state.
5. Reload the app: view mode and minimized state restored; cascade geometry resets (expected per non-goals).
6. Tile-grid dialog with `rows*cols < N` — overflow row appears, bump cols, layout corrects.
7. Disconnect a tab's SSH session in cascade — error overlay renders inside the frame; reconnect works.

## 11. Out of Scope (v1)

Restated for clarity:

- Persisted cascade geometry.
- Named saved layouts.
- Drag-to-detach tabs into floating windows from `tabs` mode.
- Snap-to-edge / snap-to-frame in cascade.
- Aspect-ratio-aware auto-arrange.
- Any `src-tauri/` changes.

## 12. Workflow

1. Spec committed (this file).
2. GitHub issue opened linking this spec.
3. Feature branch + implementation plan (writing-plans skill).
4. Implement; commit incrementally per global rules (cargo check + version bump).
5. Open PR with `Closes #<issue>`.
6. Four parallel review agents (performance, security, completeness, code quality).
7. Address feedback; merge.
