import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import type { CursorStyle } from './types';
import { parseOsc52 } from './osc52';
import { buildXtermTheme, getPalette, type PaletteId } from './palettes';

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
  /** Colour palette id (lib/palettes.ts). Unknown / omitted falls back
   *  to the default. Switch later via `terminal.options.theme`. */
  palette?: PaletteId;
  /** Sink for OSC 52 clipboard writes (see lib/osc52.ts). Programs on
   *  the far end of an SSH session — Claude Code, neovim, tmux — copy
   *  through this. Omit to leave OSC 52 unhandled. The caller supplies
   *  the Tauri clipboard plugin's writer; navigator.clipboard is not
   *  usable from the webview on every platform. Rejections are reported
   *  through `onClipboardError` (if given) and never propagate. */
  onClipboardWrite?: (text: string) => Promise<void>;
  /** Consulted per OSC 52 sequence, so the Settings switch applies to
   *  open tabs immediately. Defaults to allowed. */
  allowClipboardWrite?: () => boolean;
  /** BEL (0x07) received. */
  onBell?: () => void;
  cursorBlink?: boolean;
  /** Called when an OSC 52 write fails, e.g. no xclip / wl-clipboard on
   *  Linux, so the user learns the copy did not land. */
  onClipboardError?: (error: unknown) => void;
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

/** Build an xterm.js Terminal with the chosen colour palette (default:
 *  dark, MobaXterm-like). The palette does NOT change with the chrome
 *  theme toggle per spec §4.3 — it is its own setting (#176).
 *  Per-session overrides (font size, font family, scrollback, cursor
 *  style) come from the sessions row; omitted fields fall back to the
 *  MobaXterm-aligned defaults below. */
export function createTerminal(opts: TerminalOptionsOverride = {}): TerminalBundle {
  const terminal = new Terminal({
    cursorBlink: opts.cursorBlink ?? true,
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
    theme: buildXtermTheme(getPalette(opts.palette)),
  });

  const fit    = new FitAddon();
  const search = new SearchAddon();
  const links  = new WebLinksAddon();

  terminal.loadAddon(fit);
  terminal.loadAddon(search);
  terminal.loadAddon(links);

  // OSC 52 clipboard writes. Registered per terminal, so output from any
  // tab — visible or not — can set the clipboard, the same as Windows
  // Terminal or tmux. Reads (`?`) are consumed but never answered.
  // Returning true tells the parser the sequence was handled either way.
  // The handler is disposed along with the terminal.
  //
  // A hand-rolled handler rather than @xterm/addon-clipboard: that addon
  // does accept a custom provider, but it answers `?` reads from the
  // provider and lets a rejected write surface as an unhandled rejection
  // inside the parser. Owning the 50 lines keeps both rules enforceable.
  const write = opts.onClipboardWrite;
  const onError = opts.onClipboardError;
  if (write) {
    terminal.parser.registerOscHandler(52, (data) => {
      const req = parseOsc52(data);
      if (req.kind === 'write' && (opts.allowClipboardWrite?.() ?? true)) {
        // Promise.resolve().then(...) also catches a synchronous throw
        // from the sink; nothing may escape into xterm's parse loop.
        void Promise.resolve()
          .then(() => write(req.text))
          .catch((e: unknown) => onError?.(e));
      }
      return true;
    });
  }

  if (opts.onBell) terminal.onBell(opts.onBell);

  return {
    terminal, fit, search, links,
    dispose: () => terminal.dispose(),
  };
}
