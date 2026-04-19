# Implementation Notes — Decisions on Designer's Open Questions

Issued 2026-04-18. These resolve the three open questions raised by the UX designer and take precedence over Plan 1 where they differ.

## 1. Tab color — swatches, not free-form

Replace the `<input type="color">` in Plan 1 Task 17 with a 6-swatch palette picker.

Six swatches shown. Five are real colors. The sixth (slate, visually `#94a3b8`) is the "no accent" option and stores `null`.

- `#60a5fa` (blue)
- `#34d399` (green)
- `#fbbf24` (amber)
- `#f87171` (red)
- `#a78bfa` (purple)
- slate = "None" → stores `null`

DB column is `color TEXT NULL`. The picker writes exactly six possible states: five hex strings or `null`.

**Rationale:** matches MobaXterm's fixed palette, keeps UI consistent, eliminates the awkward macOS-style color well in a Windows-native tool.

## 2. Tree order — folders first, then root sessions

Inside any folder node, render child folders before child sessions. At the root level, render folders first, then ungrouped sessions after the folder tree (equivalent to treating the root as a regular folder).

This means Plan 1 Task 16's `NodeView` component should render `node.folders` **before** `node.sessions`, which is already the case for child folders but must also apply at the root. Update the root-level ordering accordingly.

**Rationale:** standard file-tree convention; matches MobaXterm and Windows Explorer.

## 3. Sidebar resize — deferred to post-v0.1

Remove the `sidebarWidth` `useState` from Plan 1 Task 15. Fix the sidebar at 240px (Tailwind `w-60`). No resize handle in v0.1.

```tsx
// Replace this:
const [sidebarWidth, setSidebarWidth] = useState(240);
<aside style={{ width: sidebarWidth }} … />

// With this:
<aside className="w-60 shrink-0 border-r border-border bg-surface min-h-0 overflow-auto">
```

A future plan will add a proper draggable handle with persistence to `app_settings` (`sidebar_width` key).

**Rationale:** a stateful resize handle is its own small feature (drag logic, persistence, min/max clamping, theme awareness). YAGNI for v0.1.
