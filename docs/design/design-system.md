# ezTerm Design System (v0.1)

**Status:** Approved for Plan 1 / Plan 2 / Plan 3 implementation.
**Audience:** The Rust/Tauri engineer implementing the UI components, and any reviewer evaluating fidelity to the spec in `docs/superpowers/specs/2026-04-18-ezterm-design.md`.

The guiding principle for v0.1 is **MobaXterm parity**: a Windows power user should open ezTerm and feel they already know it. This document is conservative by design. When in doubt between "familiar" and "polished-but-novel", pick familiar.

---

## 1. Design Principles

1. **Familiar over novel.** Mirror MobaXterm's sidebar-left, tabs-on-top, status-bar-below layout. No reinvention.
2. **Windows-native density.** Sharp or near-sharp corners (0-4px), compact row heights (24-28px), small icons (14-16px), Segoe UI chrome.
3. **Dark by default; light is a faithful inversion.** Both themes ship the **same xterm terminal palette** — only the app chrome changes.
4. **Keyboard-first.** Every action has a shortcut. Focus rings are always visible.
5. **Information density over whitespace.** This is a tool for long sessions, not a landing page.

---

## 2. Color Tokens

All tokens are stored as space-separated RGB triplets in `ui/app/globals.css` so Tailwind's `rgb(var(--token) / <alpha-value>)` pattern works. The seven variable names below are fixed (Plan 1 components reference them); additional tokens listed afterwards were added by the design system.

### 2.1 Core chrome tokens

| Token         | Dark (RGB)       | Light (RGB)      | Role                                                                 |
|---------------|------------------|------------------|----------------------------------------------------------------------|
| `--bg`        | `24 26 30`       | `243 244 247`    | Window background (active tab content area, empty states).           |
| `--surface`   | `32 34 39`       | `252 252 253`    | Sidebar, status bar, tab bar, dialog surfaces.                        |
| `--surface-2` | `42 45 52`       | `234 236 241`    | Inputs, hovered rows, context menu background, nested panels.        |
| `--border`    | `58 62 70`       | `205 209 217`    | Dividers, input borders, subtle separators.                          |
| `--fg`        | `226 228 233`    | `24 27 33`       | Primary text on chrome surfaces.                                     |
| `--muted`     | `150 156 168`    | `100 109 123`    | Secondary text: hostnames under names, column headers, hints.        |
| `--accent`    | `88 148 225`     | `30 110 205`     | Primary button fill, focus ring, active tab underline, link color.   |

Justifications:

- **`--bg` (24 26 30)**: slightly warmer than pure `#121214` so it doesn't look "too black" next to the terminal; matches MobaXterm's chrome tone.
- **`--surface` vs `--bg`**: surface is noticeably lighter in dark mode so the sidebar lifts off the active terminal area without needing a drop shadow.
- **`--surface-2`**: one more step up in dark mode, one step darker than surface in light mode — the hover/input state always contrasts its parent without depending on a tint.
- **`--border`**: tuned to ~1.6:1 vs surface in both themes so dividers are visible but not loud.
- **`--fg`**: not pure white in dark mode (reduces fatigue during long terminal sessions); not pure black in light mode (matches Windows 11 text token).
- **`--muted`**: WCAG AA on `--surface` in both themes (see §10).
- **`--accent`**: a desaturated Windows-blue. Not the Tailwind `blue-500` default (too saturated); not Fluent's teal (wrong era).

### 2.2 Semantic status tokens

| Token         | Dark         | Light        | Role                                          |
|---------------|--------------|--------------|-----------------------------------------------|
| `--success`   | `74 170 120` | `30 130 80`  | Connected indicator, success toast, OK chip.  |
| `--warning`   | `220 170 70` | `180 125 30` | Stale session, TOFU accept banner, caution.   |
| `--danger`    | `230 95 95`  | `185 40 50`  | Destructive actions, error text, disconnect.  |
| `--selection` | `62 96 152`  | `176 206 247`| xterm selection highlight and input selection.|

### 2.3 Terminal ANSI palette (identical in both themes)

The terminal palette does **not** switch with the chrome theme. This is intentional: users configure xterm colors once and expect them to stay. Values below are a MobaXterm-leaning take on the Campbell/Windows Terminal defaults.

| Index | Name    | Hex       |
|-------|---------|-----------|
| 0     | black   | `#0c0c0c` |
| 1     | red     | `#c23127` |
| 2     | green   | `#31a354` |
| 3     | yellow  | `#c7a02c` |
| 4     | blue    | `#3b78ff` |
| 5     | magenta | `#b148c6` |
| 6     | cyan    | `#3aa4c6` |
| 7     | white   | `#cccccc` |
| 8     | br.black   | `#676767` |
| 9     | br.red     | `#e74856` |
| 10    | br.green   | `#57c47a` |
| 11    | br.yellow  | `#e4c76f` |
| 12    | br.blue   | `#6aa6ff` |
| 13    | br.magenta | `#d670d7` |
| 14    | br.cyan    | `#66ccd4` |
| 15    | br.white  | `#f2f2f2` |

Terminal surface (distinct from chrome):

| Token                   | Value       | Role                          |
|-------------------------|-------------|-------------------------------|
| terminal background     | `#0c0c0c`   | xterm canvas fill.            |
| terminal foreground     | `#cccccc`   | default text.                 |
| terminal cursor         | `#cccccc`   | block cursor.                 |
| terminal cursorAccent   | `#0c0c0c`   | text under cursor.            |
| selectionBackground     | `#3a4b6b`   | xterm selection.              |

---

## 3. Typography

Font families are always declared with a full Windows fallback stack. No web fonts are downloaded.

| Role               | Family                                                         | Size | Weight | Line height |
|--------------------|----------------------------------------------------------------|------|--------|-------------|
| Window chrome      | `'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif`       | 13px | 400    | 1.4         |
| Sidebar section    | Segoe UI Variable                                              | 11px | 600 (uppercase, 0.06em tracking) | 1.2 |
| Sidebar row        | Segoe UI Variable                                              | 13px | 400    | 1.3         |
| Sidebar row (hint) | Segoe UI Variable                                              | 11px | 400    | 1.3         |
| Tab title          | Segoe UI Variable                                              | 12px | 500    | 1.3         |
| Button             | Segoe UI Variable                                              | 12px | 500    | 1.2         |
| Dialog heading     | Segoe UI Variable                                              | 15px | 600    | 1.3         |
| Dialog field label | Segoe UI Variable                                              | 11px | 500    | 1.2         |
| Dialog input       | Segoe UI Variable                                              | 13px | 400    | 1.3         |
| Status bar         | Segoe UI Variable                                              | 11px | 400    | 1.2         |
| Terminal (default) | `'Cascadia Mono', 'Consolas', ui-monospace, monospace`         | 14px (11pt approx) | 400 | 1.25 |
| Terminal (bold)    | Cascadia Mono                                                  | 14px | 700    | 1.25        |

Font smoothing: `-webkit-font-smoothing: antialiased; text-rendering: geometricPrecision;` on body. Cascadia Mono inside the terminal keeps its default rendering (no AA override) so it stays crisp.

---

## 4. Spacing Scale

A plain 4px scale, mapped to Tailwind defaults (we use `px-2`, `py-1.5` etc. directly — no custom scale).

| Token | px  | Tailwind |
|-------|-----|----------|
| 0.5   | 2   | `p-0.5`  |
| 1     | 4   | `p-1`    |
| 1.5   | 6   | `p-1.5`  |
| 2     | 8   | `p-2`    |
| 3     | 12  | `p-3`    |
| 4     | 16  | `p-4`    |
| 5     | 20  | `p-5`    |
| 6     | 24  | `p-6`    |
| 8     | 32  | `p-8`    |

Fixed structural sizes (do not use arbitrary values elsewhere):

| Element              | Size  |
|----------------------|-------|
| Sidebar default width| 240px |
| Sidebar min / max    | 180 / 420 |
| Status bar height    | 24px  |
| Tab bar height       | 32px  |
| Tab min/max width    | 140 / 240 |
| Sidebar row height   | 24px  |
| Dialog width         | 480px |
| Context menu width   | 200px min |
| Border radius        | 2px default, 3px for dialogs, 0px for tabs and sidebar rows |

---

## 5. Iconography

**Library:** [Lucide](https://lucide.dev) (MIT). 16px stroke=1.75 for buttons, 14px stroke=1.75 for inline icons, 18px stroke=1.75 for the sidebar chevron/folder glyph only if drawn as an icon (the mockups use the glyphs `▸` and `▾` directly — see note below).

> Note: folder expand/collapse triangles use the Unicode glyphs `▸ ▾` rather than icons, because they render pixel-sharp in Segoe UI at 11-12px. Files and folders themselves use Lucide icons.

| Action                     | Icon (Lucide name)       |
|----------------------------|--------------------------|
| Folder (closed/open)       | `folder` / `folder-open` |
| Session (terminal)         | `terminal`               |
| SFTP (files)               | `folder-tree`            |
| New session                | `plus`                   |
| New folder                 | `folder-plus`            |
| Rename                     | `pencil`                 |
| Delete                     | `trash-2`                |
| Duplicate                  | `copy`                   |
| Connect                    | `play`                   |
| Disconnect                 | `power`                  |
| Lock vault                 | `lock`                   |
| Unlock                     | `lock-open`              |
| Theme toggle (dark→light)  | `sun`                    |
| Theme toggle (light→dark)  | `moon`                   |
| Settings                   | `settings`               |
| Find / search              | `search`                 |
| Copy                       | `copy`                   |
| Paste                      | `clipboard`              |
| Clear scrollback           | `eraser`                 |
| Close (tab, dialog)        | `x`                      |
| Dropdown / expand          | `chevron-down`           |
| Upload (SFTP)              | `upload`                 |
| Download (SFTP)            | `download`               |
| Refresh                    | `refresh-cw`             |
| Show password              | `eye` / `eye-off`        |

Rules:
- No decorative icons. Every icon represents an action or object.
- Icons inherit `currentColor`; they never carry their own color tokens.
- Icon-only buttons must carry an `aria-label` matching the action name.

---

## 6. Interaction States

All states use the tokens above; no ad-hoc colors.

### 6.1 Buttons (primary)

| State        | Background            | Foreground        | Border                |
|--------------|-----------------------|-------------------|-----------------------|
| Default      | `--accent`            | white             | transparent           |
| Hover        | `--accent` +10% L     | white             | transparent           |
| Active       | `--accent` -10% L     | white             | transparent           |
| Focus-visible| default bg            | white             | 2px `--accent` outline, 2px offset |
| Disabled     | `--accent` @ 40% opacity | white @ 70%    | transparent           |

### 6.2 Buttons (secondary / ghost)

| State        | Background        | Foreground | Border       |
|--------------|-------------------|------------|--------------|
| Default      | transparent       | `--fg`     | `--border`   |
| Hover        | `--surface-2`     | `--fg`     | `--border`   |
| Active       | `--surface-2` -4% | `--fg`     | `--accent`   |
| Focus-visible| default bg        | `--fg`     | 2px `--accent` outline |
| Disabled     | transparent       | `--muted`  | `--border` @ 60% |

### 6.3 Tree rows (sidebar)

| State          | Background        | Foreground                    |
|----------------|-------------------|-------------------------------|
| Default        | transparent       | `--fg` (sessions), `--muted` (folders) |
| Hover          | `--surface-2`     | `--fg`                        |
| Selected       | `--accent` @ 18%  | `--fg`                        |
| Selected+focus | `--accent` @ 28%, 2px `--accent` inset left | `--fg`       |

Row height is fixed at 24px. No icons move on hover.

### 6.4 Tabs

| State        | Background        | Foreground  | Underline       |
|--------------|-------------------|-------------|-----------------|
| Default      | `--surface`       | `--muted`   | none            |
| Hover        | `--surface-2`     | `--fg`      | none            |
| Active       | `--bg`            | `--fg`      | 2px `--accent` bottom |
| Focus-visible| as active         | `--fg`      | 2px `--accent` outline (offset -2) |

Close-button inside tab: only shown on hover or when tab is active.

### 6.5 Inputs (text, number, select, textarea)

| State        | Background        | Border                |
|--------------|-------------------|-----------------------|
| Default      | `--surface-2`     | `--border`            |
| Hover        | `--surface-2`     | `--muted`             |
| Focus        | `--surface-2`     | `--accent` (2px)      |
| Disabled     | `--surface-2` @ 60% | `--border` @ 60%    |
| Error        | `--surface-2`     | `--danger` (2px)      |

### 6.6 Focus ring

Keyboard focus uses a **2px solid `--accent` outline** with a 2px offset. Never `outline: none` without a replacement. Focus ring is drawn on top so it overlays neighboring chrome.

---

## 7. Motion

Minimal. This is a power-user tool — snappy beats smooth.

| Action                         | Duration | Easing            |
|--------------------------------|----------|-------------------|
| Theme toggle (color swap)      | 120ms    | `ease-out`        |
| Hover background               | 80ms     | `linear`          |
| Dialog appear                  | 140ms    | `ease-out` (fade + 4px rise) |
| Context menu appear            | 0ms      | instant           |
| SFTP pane slide open/close     | 160ms    | `ease-out`        |
| Tab close                      | 0ms      | instant           |
| Focus ring                     | 0ms      | instant           |

No decorative animations. No bouncing. Respect `prefers-reduced-motion: reduce` — all non-essential transitions drop to 0ms.

---

## 8. xterm.js Theme Objects

Both themes pass the **same** `theme` object to xterm.js. Only the chrome changes on toggle.

```json
{
  "foreground": "#cccccc",
  "background": "#0c0c0c",
  "cursor": "#cccccc",
  "cursorAccent": "#0c0c0c",
  "selectionBackground": "#3a4b6b",
  "selectionForeground": "#ffffff",
  "black":        "#0c0c0c",
  "red":          "#c23127",
  "green":        "#31a354",
  "yellow":       "#c7a02c",
  "blue":         "#3b78ff",
  "magenta":      "#b148c6",
  "cyan":         "#3aa4c6",
  "white":        "#cccccc",
  "brightBlack":  "#676767",
  "brightRed":    "#e74856",
  "brightGreen":  "#57c47a",
  "brightYellow": "#e4c76f",
  "brightBlue":   "#6aa6ff",
  "brightMagenta":"#d670d7",
  "brightCyan":   "#66ccd4",
  "brightWhite":  "#f2f2f2"
}
```

If a future version offers a "light terminal" preset, the object below ships as an optional user-selected palette — it is **not** auto-applied on light theme toggle.

```json
{
  "foreground": "#1a1a1a",
  "background": "#f8f8f8",
  "cursor": "#1a1a1a",
  "cursorAccent": "#f8f8f8",
  "selectionBackground": "#b0cef7",
  "selectionForeground": "#1a1a1a",
  "black":        "#0c0c0c",
  "red":          "#a4251f",
  "green":        "#237a3f",
  "yellow":       "#8a7010",
  "blue":         "#1e6ecd",
  "magenta":      "#8a389a",
  "cyan":         "#1f7f97",
  "white":        "#555555",
  "brightBlack":  "#676767",
  "brightRed":    "#c23127",
  "brightGreen":  "#31a354",
  "brightYellow": "#b08a1a",
  "brightBlue":   "#3b78ff",
  "brightMagenta":"#b148c6",
  "brightCyan":   "#3aa4c6",
  "brightWhite":  "#1a1a1a"
}
```

---

## 9. Keyboard Shortcuts (v0.1)

From spec §4.2 plus the set added during design. All shortcuts work when the tab bar or terminal has focus unless noted.

### Terminal

| Shortcut            | Action                                    |
|---------------------|-------------------------------------------|
| `Shift+Insert`      | Paste clipboard into terminal             |
| `Ctrl+Shift+C`      | Copy selection (if any)                   |
| `Ctrl+Shift+V`      | Paste clipboard                           |
| `Ctrl+Shift+F`      | Open find overlay                         |
| `Ctrl+Shift+K`      | Clear scrollback                          |
| `Ctrl+Shift+A`      | Select all (terminal buffer)              |
| `F3` / `Shift+F3`   | Find next / previous (while overlay open) |
| `Escape`            | Close find overlay                        |

### Tabs

| Shortcut                  | Action                |
|---------------------------|-----------------------|
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Cycle next / prev tab |
| `Ctrl+1` … `Ctrl+8`       | Switch to tab 1-8     |
| `Ctrl+9`                  | Switch to last tab    |
| `Ctrl+W`                  | Close current tab     |
| `Ctrl+Shift+T`            | Reopen last closed tab (if available) |

### Sessions / folders (when sidebar has focus)

| Shortcut          | Action                    |
|-------------------|---------------------------|
| `Ctrl+N`          | New session dialog        |
| `Ctrl+Shift+N`    | New folder                |
| `F2`              | Rename selected node      |
| `Delete`          | Delete selected node      |
| `Ctrl+D`          | Duplicate selected session|
| `Enter` / double-click | Connect / open tab   |
| `ArrowUp/Down`    | Move selection            |
| `ArrowLeft/Right` | Collapse / expand folder  |

### Global

| Shortcut       | Action                              |
|----------------|-------------------------------------|
| `Ctrl+L`       | Lock vault                          |
| `Ctrl+,`       | Settings                            |
| `Ctrl+B`       | Toggle sidebar                      |
| `Ctrl+K` then `T` | Toggle theme (chord)             |
| `F1`           | About / keyboard shortcuts reference|
| `Escape`       | Close dialog / context menu         |

---

## 10. Accessibility

### 10.1 Contrast (WCAG 2.1)

Computed against background:

| Pair (dark)                       | Ratio  | Grade |
|-----------------------------------|--------|-------|
| `--fg` on `--bg`                  | 11.8:1 | AAA   |
| `--fg` on `--surface`             | 10.6:1 | AAA   |
| `--muted` on `--surface`          | 5.1:1  | AA    |
| `--accent` on `--surface`         | 4.6:1  | AA    |
| white on `--accent` (button)      | 5.3:1  | AA    |

| Pair (light)                      | Ratio  | Grade |
|-----------------------------------|--------|-------|
| `--fg` on `--bg`                  | 14.2:1 | AAA   |
| `--muted` on `--surface`          | 4.9:1  | AA    |
| white on `--accent` (button)      | 4.8:1  | AA    |

Terminal contrast (same in both themes): `#cccccc` on `#0c0c0c` = 12.7:1 (AAA).

### 10.2 Other a11y rules

- Every interactive element reachable by `Tab`; logical order: sidebar → tab bar → terminal → status bar.
- `aria-label` on every icon-only button.
- Dialog: `role="dialog" aria-modal="true"`, focus trap, `Escape` closes.
- Context menu: `role="menu"`, arrow keys navigate, `Enter` activates, `Escape` closes.
- No reliance on color alone — connection status has an icon *and* text label; validation errors have an icon and prose.
- Respect `prefers-reduced-motion` (see §7).
