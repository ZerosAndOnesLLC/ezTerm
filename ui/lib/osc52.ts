/**
 * OSC 52 — the "manipulate selection data" escape sequence.
 *
 *   ESC ] 52 ; <selection> ; <base64 payload> BEL
 *
 * A program (Claude Code, neovim, tmux, …) sends it to put text on the
 * terminal's clipboard. It is the only clipboard route that works from
 * the far end of an SSH session, which is why TUIs moved to it. xterm.js
 * hands the handler everything after `52;`, i.e. `<selection>;<payload>`.
 *
 * Only the write form is honoured. The read form (`?` payload, "send me
 * the clipboard contents") is refused: answering it would let any remote
 * program read the local clipboard, so terminals ship with reads off.
 */

export type Osc52Request =
  | { kind: 'write'; text: string }
  | { kind: 'read' }
  | { kind: 'ignore'; reason: string };

/** Selection characters we route to the system clipboard. `c` is the
 *  clipboard proper; `p` (primary) and `s` (select) are X11 selections
 *  that have no separate meaning on Windows/macOS, so they get the same
 *  treatment. An empty selector means the default, which we take as `c`.
 *  Cut-buffers `0`–`7` and `q` are ignored. */
const CLIPBOARD_SELECTORS = /[cps]/;

/** Decoded size cap. Larger than any sane copy; stops a hostile host
 *  from making the webview allocate hundreds of MB on one escape. */
export const MAX_OSC52_BYTES = 4 * 1024 * 1024;

export function parseOsc52(data: string): Osc52Request {
  const sep = data.indexOf(';');
  if (sep < 0) return { kind: 'ignore', reason: 'missing selection separator' };
  const selection = data.slice(0, sep);
  const payload = data.slice(sep + 1);

  if (selection !== '' && !CLIPBOARD_SELECTORS.test(selection)) {
    return { kind: 'ignore', reason: `selection "${selection}" is not a clipboard target` };
  }
  if (payload === '?') return { kind: 'read' };
  if (payload === '') return { kind: 'ignore', reason: 'empty payload' };

  // Base64 per RFC 4648 §4. Whitespace is tolerated (some senders wrap
  // long payloads) and so is missing padding (Rust's STANDARD_NO_PAD, Go's
  // RawStdEncoding), which atob also accepts; a length of 1 mod 4 can
  // never be valid. Reject anything else before atob so a malformed
  // sequence can't throw out of the parser callback.
  const stripped = payload.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(stripped) || stripped.length % 4 === 1) {
    return { kind: 'ignore', reason: 'payload is not base64' };
  }
  const clean = stripped.replace(/=+$/, '');
  // 3 decoded bytes per 4 base64 chars; check before decoding.
  if ((clean.length / 4) * 3 > MAX_OSC52_BYTES) {
    return { kind: 'ignore', reason: 'payload exceeds size cap' };
  }

  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  // NUL terminates CF_UNICODETEXT on Windows and is rejected by some
  // Linux clipboard backends; drop it rather than lose everything after it.
  const text = new TextDecoder('utf-8').decode(bytes).replace(/\0/g, '');
  return { kind: 'write', text };
}
