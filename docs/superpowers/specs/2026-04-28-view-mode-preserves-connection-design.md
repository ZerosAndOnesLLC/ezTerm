# View-mode switches must preserve SSH connections — Design Spec

**Date:** 2026-04-28
**Status:** Approved (design phase)
**Tracking issue:** [#34](https://github.com/ZerosAndOnesLLC/ezTerm/issues/34)

## 1. Goal

Switching window view modes (Tabs ↔ Tile-H ↔ Tile-V ↔ Tile-Grid ↔ Cascade ↔ Auto) must be a pure layout operation. Existing SSH/local terminals stay connected, scrollback is intact, shell state (current dir, exported env, running commands, REPL state) is unaffected. SFTP panes likewise survive mode switches with their state intact.

## 2. Background — root cause

`MdiArea` (`ui/components/mdi-area.tsx`) renders one of four different component types depending on `viewMode` (`TabsLayout`, `TileFlexLayout`, `TileGridLayout`, `CascadeLayout`). React reconciliation rule: *different element type at the same position → unmount the previous subtree, mount the new one*. Stable `key={t.tabId}` doesn't save the children — keys reconcile children of the *same parent*; the parent type itself is changing here.

When `<TerminalView>` unmounts, its effect cleanup at `terminal.tsx:201-217` calls `api.{ssh,local}Disconnect(connectionId)` and the next mount triggers a fresh `runConnect()`. Result: the user sees their session drop and reconnect on every mode switch.

Same class of bug applies to `<SftpPane>` (only rendered in tabs mode today; mode switches drop pane state).

This was flagged in the PR #31 code-quality review (#31 review thread) as a risk; it wasn't actioned and is now biting in production.

## 3. Non-Goals (this PR)

- Persisting cascade frame geometry across app restarts (still in-memory only per the original spec).
- Saved named layouts.
- Any change to the six-mode set, the toolbar, the `Ctrl+Shift+W` cycle, or the cascade chrome features (drag, resize, min/max/close, click-to-front, double-click maximize).
- Backend changes — this is purely a frontend reconciliation fix.

## 4. Architecture

A single `MdiArea` renders one stable list of `<TabSlot>` children, keyed by `tabId`. Each slot's outer element is **always a `<div>`** across all six modes; only its `className`/`style` and the chrome rendered alongside it change. Cascade chrome (title bar + 8 resize handles) becomes a *sibling* of the terminal-host inside the slot, not a parent of it.

```
MdiArea (single mounted root, owns cascade-area ref + cascade size + dragging flag)
└── tabs.map((t) => <TabSlot key={t.tabId} ... />)
    └── TabSlot (outer <div>, className/style by mode)
        ├── (cascade only, non-minimized) <CascadeChrome key="chrome" ... />     ← sibling
        ├── (tabs mode only, sftp open)   <SftpPane     key="sftp"    tab={t} /> ← sibling
        └── <div key="terminal-host">                                             ← sibling, ALWAYS rendered
            └── <TerminalView tab={t} visible={...} />
```

Because `TabSlot`'s outer `<div>` is the same React element type in every mode, and the `terminal-host` inner `<div>` has a stable React key, React preserves both across mode switches. `<TerminalView>` never unmounts because of a mode change. SFTP pane likewise stays mounted whenever `tab.sftpOpen` is true; only its visibility flips.

`MdiFrame` (the current cascade-only chrome+wrapper) is replaced by a leaner `CascadeChrome` that owns chrome only — title bar (status dot, name, min/max/close), 8 resize handle divs, drag binding. **It does not wrap the terminal.** Drag and resize hooks (`useMdiDrag`, `useMdiResize`) are unchanged.

## 5. Hidden-tab visibility (one consistent rule)

Hidden tabs in any mode get `position: absolute; visibility: hidden; inset: 0`:
- Off-flow in flex/grid layouts → doesn't take a tile cell.
- Dimensions preserved (xterm's render service stays alive; no `0×0` crash).
- No mouse capture (clicks pass through to whatever is on top).
- For cascade specifically, minimized frames sit invisibly at `inset: 0` rather than at their stored cascade rectangle. When restored from minimize, the slot reads `cascade[tabId]` for its position and the rectangle returns to where it was. (This is the same pattern the existing tabs mode already uses for inactive tabs.)

A tab is "hidden" when:
- `viewMode === 'tabs'` and `tab.tabId !== activeId`
- `minimized.has(tab.tabId)` (cascade or any other mode)

Otherwise it's visible and gets the per-mode `className`/`style`.

## 6. Per-mode slot styling (computed in `TabSlot`)

```ts
type SlotKind = 'hidden' | 'tabs' | 'tile-flex' | 'tile-grid' | 'cascade';

function slotKind(viewMode, isActive, isMinimized): SlotKind {
  if (isMinimized) return 'hidden';
  if (viewMode === 'tabs') return isActive ? 'tabs' : 'hidden';
  if (viewMode === 'tile-h' || viewMode === 'tile-v') return 'tile-flex';
  if (viewMode === 'tile-grid' || viewMode === 'auto') return 'tile-grid';
  return 'cascade';
}
```

| Kind | className | style |
|------|-----------|-------|
| `hidden` | `absolute inset-0` | `{ visibility: 'hidden', pointerEvents: 'none' }` |
| `tabs` | `absolute inset-0 flex` | (none) — terminal-host is a real flex item below; SftpPane sits next to it in the same flex row |
| `tile-flex` | `flex-1 min-w-0 min-h-0 bg-bg relative` | (none) — flex parent handles sizing |
| `tile-grid` | `min-w-0 min-h-0 bg-bg relative` | (none) — grid parent handles sizing |
| `cascade` | `absolute bg-bg border rounded-md shadow-lg overflow-hidden` (+ `border-accent` when active else `border-border`) | `{ left, top, width, height, zIndex }` from `cascade[tabId]` (display-only clamp same as today) |

Terminal-host positioning is mode-dependent so it composes correctly with the SftpPane sibling and the cascade title bar:

- **`tabs` mode**: the slot is `display: flex` and the terminal-host is a real flex item (`flex: 1 1 0%; min-width: 0; min-height: 0; position: relative`). When the SftpPane is open it occupies its `w-72` width and the terminal-host fills the rest of the row. **Not** absolutely positioned — that would overlay the pane.
- **`tile-flex` / `tile-grid`**: terminal-host is `position: absolute; inset: 0` inside a slot whose own size is driven by its flex/grid parent.
- **`cascade`**: terminal-host is `position: absolute; left: 0; right: 0; top: 24px; bottom: 0` so the title bar sibling has room at the top of the slot.

## 7. State that moves to `MdiArea`

`CascadeLayout`'s state is hoisted to `MdiArea` so it's always live (not gated on a cascade-specific subtree existing):

- `cascadeAreaRef: RefObject<HTMLDivElement | null>` — the MdiArea's root div doubles as the cascade area for clamping purposes.
- `[cascadeSize, setCascadeSize]` — kept up-to-date via a `ResizeObserver` on the root div, with the no-op short-circuit added in the post-review fix (skip writes when dimensions unchanged).
- `[dragging, setDragging]` — true while a drag/resize is in flight in cascade mode. Drives `pointer-events: none` on the terminal-host *of every cascade slot* so xterm doesn't capture the mouse mid-drag. Outside cascade mode it stays `false` and has no effect.

`MdiArea` passes `cascadeAreaRef`, `cascadeSize`, `setDragging`, and `dragging` into each `TabSlot`. Slots only consume them in cascade mode.

## 8. SFTP pane persistence

`<SftpPane>` is rendered as a sibling of terminal-host in every `TabSlot` whenever `tab.sftpOpen && tab.session.session_kind === 'ssh'`, regardless of mode. Visibility:

- `viewMode === 'tabs'` → visible (same as today: shows to the left of the terminal in the slot's flex layout)
- Any other mode → `display: none` on the SftpPane wrapper

`display: none` does **not** unmount the React component — it only hides it visually. SftpPane keeps its component-level state (current dir listing, expanded folders, transfer progress) across mode switches.

## 9. Components — file map

**New / refactored:**
- `ui/components/tab-slot.tsx` (NEW) — replaces the per-mode wrapping logic; one component, all modes.
- `ui/components/cascade-chrome.tsx` (NEW) — title bar + 8 resize handles, chrome only.

**Modified:**
- `ui/components/mdi-area.tsx` — rewritten to a single root + `tabs.map(<TabSlot/>)`.
- `ui/components/mdi-frame.tsx` (DELETED) — superseded by `tab-slot.tsx` + `cascade-chrome.tsx`.

Existing files unchanged:
- `ui/lib/use-mdi-drag.ts`, `ui/lib/use-mdi-resize.ts`
- `ui/lib/tabs-store.ts`
- `ui/components/minimized-strip.tsx`, `ui/components/view-mode-toolbar.tsx`, `ui/components/tile-grid-dialog.tsx`
- `ui/components/status-dot.tsx`
- `ui/components/terminal.tsx`, `ui/components/sftp-pane.tsx`

## 10. Reconciliation invariants (the contract)

1. The `MdiArea` returns the same root `<div>` element type for every value of `viewMode`.
2. `tabs.map(...)` is the only direct array-children block under that root, and every child is a `<TabSlot key={tabId}>`.
3. `TabSlot` returns a single root `<div>` element type for every value of `viewMode`.
4. Inside `TabSlot`, the `<div key="terminal-host">` is always rendered (regardless of mode and visibility), so `<TerminalView>` is never unmounted by mode/visibility changes.
5. `<SftpPane>` mounts/unmounts only on `tab.sftpOpen` toggle, not on mode change.

These invariants are what guarantee the bug doesn't recur. Any future edit that breaks one of them — e.g., wrapping `<TerminalView>` in a mode-conditional component — re-opens the bug.

## 11. Edge cases

- **Window resize during cascade:** `cascadeSize` updates via the existing `ResizeObserver` path. `TabSlot` reads cascade geometry and clamps for display only (existing behavior preserved).
- **Initial mount with `cascadeSize.w === 0`:** in cascade mode, slots use the existing `size.w > 0 && size.h > 0` guard — they still mount the terminal-host (so the connection runs) but skip cascade chrome until size is known. That keeps the connection invariant intact even on first paint.
- **Switching modes mid-drag:** the drag hooks already handle "tab disappears mid-drag" by re-checking the store. Mode switch doesn't unmount the slot (per the new contract), so the drag's `mouseup` handler still fires.
- **Tab close mid-mode-switch:** `close(tabId)` removes the tab from `tabs[]` → its slot unmounts → terminal-host unmounts → `disconnect(cid)` fires correctly. This is the *only* path that should cause a disconnect.
- **`tab.sftpOpen` toggle in non-tabs mode:** SftpPane mounts even though it'll be hidden by `display: none`. The user can flip back to tabs mode and see the pane in its expected open state.
- **Cascade-only minimized frames switching to tile/grid:** the slot stays at the hidden `(absolute, visibility: hidden, inset: 0)` rule above. Switching back to cascade and restoring from minimize repositions to `cascade[tabId]` geometry.

## 12. Testing

No React test infrastructure in `ui/` — adding it is out of scope. Verification is manual smoke + lint/typecheck, with one concrete invariant we can assert in dev mode.

**Pre-PR checks:**
- `npm --prefix ui run typecheck` clean
- `npm --prefix ui run lint` clean (the 3 pre-existing `sync-dialog.tsx` warnings on main are unrelated and acceptable)
- `cargo check` clean (no Rust changes; this should be a no-op)

**Manual test plan (PR description checklist, the load-bearing one):**
1. Open one or more SSH sessions. Note `connectionId` per tab via the React DevTools or by observing the status bar (steady-state).
2. Run a long-lived process inside one terminal — e.g., `top` or `tail -f /var/log/syslog`.
3. Cycle every mode via `Ctrl+Shift+W` six times round-trip.
   - **Pass criteria:** the running process stays running. No "Connection closed" overlay appears in any tab. Scrollback is preserved. The status dot stays green.
4. Open the SFTP pane on an SSH tab. Navigate to a deep directory. Switch to cascade. Switch back to tabs.
   - **Pass criteria:** SFTP pane reopens at the same directory; no spinner / re-listing happened.
5. In cascade mode, drag a frame, resize, minimize, restore, double-click maximize. All still work as before.
6. Reload the app (Ctrl+R or close/reopen). View mode + minimized state restored from `localStorage`. Cascade geometry resets to staircase (intentional, per the original spec).

**Defensive logging during dev (optional, removed before merge):** add a `console.log('TerminalView mount', tabId)` and `console.log('TerminalView unmount', tabId)` in `terminal.tsx`'s mount effect. Cycle modes — if the bug is fixed, mount logs only fire on tab open/close, never on mode switch.

## 13. Workflow

1. Spec committed (this file)
2. Implementation plan
3. Branch + fix (already on `fix/view-mode-preserves-connection`)
4. PR (`Closes #34`)
5. Four parallel review agents (perf, security, completeness, code quality)
6. Findings presented to user — user decides which to action (per global rule)
7. Merge + patch release notes (`v1.1.1`)
