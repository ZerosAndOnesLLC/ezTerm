import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import type { CursorStyle } from './types';

export interface TerminalBundle {
  terminal: Terminal;
  fit:      FitAddon;
  search:   SearchAddon;
  links:    WebLinksAddon;
  dispose:  () => void;
}

export interface TerminalOptionsOverride {
  fontSize?:   number;
  scrollback?: number;
  cursorStyle?: CursorStyle;
  /** Optional per-session font stack. Empty / undefined falls back to
   *  the app default ([`DEFAULT_FONT_STACK`]). Values from the Font
   *  picker / session dialog are stored verbatim — we re-wrap unquoted
   *  single-name stacks in quotes so CSS doesn't split them on spaces. */
  fontFamily?: string;
}

/** Cross-OS default stack. `ui-monospace` resolves to the OS's native
 *  mono font first (SF Mono on macOS, Consolas on Windows via WebView2,
 *  a system mono on Linux), then we list popular OS-specific defaults
 *  as fallbacks so distros without `ui-monospace` support still land on
 *  something sensible. Exported so the Font picker can show what the
 *  "(default)" preset expands to. */
export const DEFAULT_FONT_STACK =
  'ui-monospace, "Cascadia Mono", Menlo, "DejaVu Sans Mono", Consolas, monospace';

/** Normalise a user-provided font-family string into a CSS-safe stack.
 *  A single name with spaces ("Fira Code") gets wrapped in quotes so
 *  xterm doesn't hand CSS a broken family list; a name the user already
 *  quoted or comma-joined passes through untouched. */
export function resolveFontFamily(value: string | undefined | null): string {
  if (!value) return DEFAULT_FONT_STACK;
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_FONT_STACK;
  // Already a quoted stack or a comma-joined list — trust the caller.
  if (trimmed.includes(',') || trimmed.includes('"') || trimmed.includes("'")) {
    return trimmed;
  }
  // Single bare name: quote if it has any whitespace.
  if (/\s/.test(trimmed)) return `"${trimmed}"`;
  return trimmed;
}

/** Build an xterm.js Terminal with our fixed palette (dark, MobaXterm-like).
 *  Theme does NOT change with the chrome theme toggle per spec §4.3.
 *  Per-session overrides (font size, font family, scrollback, cursor
 *  style) come from the sessions row; omitted fields fall back to the
 *  MobaXterm-aligned defaults below. */
export function createTerminal(opts: TerminalOptionsOverride = {}): TerminalBundle {
  const terminal = new Terminal({
    cursorBlink: true,
    cursorStyle: opts.cursorStyle ?? 'block',
    fontFamily: resolveFontFamily(opts.fontFamily),
    fontSize: opts.fontSize ?? 14,
    scrollback: opts.scrollback ?? 5000,
    allowProposedApi: true,
    // xterm.js v6 routes its viewport scrollbar through VSCode's
    // SmoothScrollableElement and sizes it from `overviewRuler.width`
    // (default 14 px). Setting this here both shrinks the slider and
    // tells xterm to reserve the space on the right edge so the
    // scrollbar no longer overlays the rendered cells. We never add
    // any overview-ruler decorations, so it just renders an empty
    // 6 px gutter with the slider on top — borders are hidden via
    // `overviewRulerBorder: transparent` below.
    overviewRuler: { width: 6 },
    theme: {
      background:         '#121214',
      foreground:         '#e5e7eb',
      cursor:             '#e5e7eb',
      cursorAccent:       '#121214',
      selectionBackground:'#2d3748',
      // Overview-ruler always paints a 1 px left border using this
      // colour. We're not using the ruler for anything, so kill it.
      overviewRulerBorder: 'rgba(0, 0, 0, 0)',
      // Slim slider, white-on-dark with subtle hover/active brighten
      // so it picks up on interaction without clashing with content.
      scrollbarSliderBackground:       'rgba(255, 255, 255, 0.18)',
      scrollbarSliderHoverBackground:  'rgba(255, 255, 255, 0.30)',
      scrollbarSliderActiveBackground: 'rgba(255, 255, 255, 0.45)',
      black:   '#2d3748', red:     '#f87171',
      green:   '#34d399', yellow:  '#fbbf24',
      blue:    '#60a5fa', magenta: '#a78bfa',
      cyan:    '#22d3ee', white:   '#e5e7eb',
      brightBlack:   '#475569', brightRed:     '#fca5a5',
      brightGreen:   '#6ee7b7', brightYellow:  '#fcd34d',
      brightBlue:    '#93c5fd', brightMagenta: '#c4b5fd',
      brightCyan:    '#67e8f9', brightWhite:   '#f3f4f6',
    },
  });

  const fit    = new FitAddon();
  const search = new SearchAddon();
  const links  = new WebLinksAddon();

  terminal.loadAddon(fit);
  terminal.loadAddon(search);
  terminal.loadAddon(links);

  return {
    terminal, fit, search, links,
    dispose: () => terminal.dispose(),
  };
}
