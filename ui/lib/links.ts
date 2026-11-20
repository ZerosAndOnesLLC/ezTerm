/** What a mouse-up on a terminal link should do. */
export type LinkClickAction = 'menu' | 'open' | null;

/** The modifier and button state of the mouse-up that xterm.js reports as a
 *  link activation. */
export interface LinkClickEvent {
  button: number;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** Decide how to treat a link activation. xterm.js fires one for any mouse
 *  button that goes down and up on the same link, so the filtering lives
 *  here:
 *
 *  - Only the primary (left) button counts. Right-click must keep reaching
 *    the terminal's Copy / Paste menu, and middle-click its paste.
 *  - A mouse-up that ends a drag-selection is a copy gesture, not a click.
 *  - Shift / Alt clicks belong to selection (extend, column select).
 *  - The platform's "open link" modifier opens straight away, like VS Code
 *    and Windows Terminal: Cmd on macOS, Ctrl elsewhere. A plain click
 *    offers a menu so a stray click never launches a browser.
 *  - On macOS, Ctrl+click is the system secondary click and already raises
 *    the context menu, so it must not also act on the link. */
export function linkClickAction(
  e: LinkClickEvent,
  hasSelection: boolean,
  isMac: boolean,
): LinkClickAction {
  if (e.button !== 0) return null;
  if (hasSelection) return null;
  if (e.shiftKey || e.altKey) return null;
  const openKey = isMac ? e.metaKey : e.ctrlKey;
  const otherKey = isMac ? e.ctrlKey : e.metaKey;
  if (otherKey) return null;
  return openKey ? 'open' : 'menu';
}

/** Label for the "open directly" gesture, for menus and tooltips. */
export function openLinkShortcut(isMac: boolean): string {
  return isMac ? 'Cmd+Click' : 'Ctrl+Click';
}

/** True for absolute http(s) URLs with a host. Terminal output is untrusted
 *  (any remote host can print an OSC 8 hyperlink), so other schemes are
 *  ignored. The backend's `open_url` enforces the same rule. */
export function isWebUrl(uri: string): boolean {
  try {
    const u = new URL(uri);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== '';
  } catch {
    return false;
  }
}
