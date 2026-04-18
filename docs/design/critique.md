# Critique of Plan 1 Draft Tokens

## TL;DR

Plan 1's draft palette was directionally right (MobaXterm-ish near-black, muted blue accent) but read slightly too "modern dark" — colors were cool and blue-leaning where MobaXterm's chrome is neutral and slightly warm. I tightened the RGB values, kept every variable name (components reference them), and **added four new semantic tokens**.

## What I kept

- Variable names: `--bg`, `--surface`, `--surface-2`, `--border`, `--fg`, `--muted`, `--accent`. No renames.
- The dark-default / `.light` class toggle approach.
- Tailwind token wiring (`rgb(var(--token) / <alpha-value>)`).
- Use of CSS variables to drive both chrome and the xterm theme object.

## What I changed (and why)

| Token         | Plan 1 draft    | Refined         | Why                                                              |
|---------------|-----------------|-----------------|------------------------------------------------------------------|
| `--bg` (dark) | `18 18 20`      | `24 26 30`      | Slightly warmer, less "true black" next to the terminal canvas.  |
| `--surface` (dark) | `26 26 30` | `32 34 39`      | Raises sidebar/tab-bar enough to read as lifted without a shadow.|
| `--surface-2` (dark) | `34 34 40` | `42 45 52`    | Keeps a clear hover/input step above `--surface`.                |
| `--border` (dark) | `52 52 60`  | `58 62 70`      | ~1.6:1 vs surface — visible but not loud.                        |
| `--fg` (dark) | `229 231 235`   | `226 228 233`   | Fractionally warmer; long-session eye comfort.                   |
| `--muted` (dark) | `148 163 184` | `150 156 168` | Less blue cast so it reads as "neutral secondary text".          |
| `--accent` (dark) | `96 165 250` | `88 148 225`  | Desaturated from Tailwind `blue-400` to a Windows-blue.          |
| `--bg` (light) | `248 249 251` | `243 244 247`  | Matches Win11 chrome tone (not pure white).                      |
| `--accent` (light) | `37 99 235` | `30 110 205` | Stronger contrast on white buttons, still conventional.          |

## New tokens added

- `--success` (green), `--warning` (amber), `--danger` (red) — needed for connection state chips, TOFU prompts, destructive confirms, and error text. Absence of these would force ad-hoc Tailwind color classes and drift.
- `--selection` — drives xterm selection and input selection; centralized so theming is consistent.

All four ship with both dark and light values, matching the pattern of the original seven.

## Terminal palette

Plan 1 did not specify ANSI colors. The design system pins a 16-color palette (a Campbell/MobaXterm hybrid) that is **identical in both chrome themes**, so toggling light mode doesn't change the terminal. This is explicit because it prevents a very common user complaint ("why did my colors change?"). The palette lives in `docs/design/design-system.md` §2.3 and §8.

## Radii

Plan 1 didn't specify. Added `borderRadius` overrides in `tailwind.config.ts` pinning the default to 2px and max to 4px, with tabs and sidebar rows explicitly square. This enforces the Windows-native feel across component code without per-component arbitrary-value pollution.

## Fonts

Plan 1 set `font-mono` globally on body. The refined `globals.css` sets Segoe UI Variable on body instead, and leaves `font-mono` for the terminal and private-key fields. This matches the spec (chrome = Segoe UI, terminal = Cascadia Mono) rather than treating the whole UI as a monospace surface.
