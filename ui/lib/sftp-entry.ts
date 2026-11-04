import type { SftpEntry } from './types';

/** What kind of row an entry is, for icon and behaviour. */
export type EntryKind =
  | 'dir' | 'file' | 'special'
  | 'dir-link' | 'file-link' | 'broken-link' | 'unresolved-link';

export function entryKind(e: SftpEntry): EntryKind {
  if (e.is_symlink) {
    if (e.link_broken) return 'broken-link';
    if (e.link_unresolved) return 'unresolved-link';
    return e.is_dir ? 'dir-link' : 'file-link';
  }
  if (e.is_dir) return 'dir';
  return e.is_special ? 'special' : 'file';
}

/** How Delete must remove an entry. A symlink is always unlinked, even
 *  when it points at a directory: that removes the link and never touches
 *  the target (rmdir on a link fails, and following it would be wrong). */
export function deleteAction(e: SftpEntry): 'remove' | 'rmdir' {
  if (e.is_symlink) return 'remove';
  return e.is_dir ? 'rmdir' : 'remove';
}

/** Body text for the delete confirmation. */
export function deleteConfirmBody(e: SftpEntry): string {
  if (e.is_symlink) {
    const t = displayTarget(e.link_target);
    const to = t ? ` (→ ${t})` : '';
    return `Removes the link only${to}. The file or folder it points to is not touched.`;
  }
  return e.is_dir ? 'The directory must be empty on the remote server.' : 'This cannot be undone.';
}

/** Regular files and links to regular files can be downloaded (the link
 *  is followed). Folders, broken / unresolved links, and FIFOs, sockets or
 *  devices (reading one can block forever or never end) can't. */
export function canDownload(e: SftpEntry): boolean {
  const k = entryKind(e);
  return (k === 'file' || k === 'file-link') && !e.is_special;
}

/** Try opening as a folder: real folders and folder links, plus links we
 *  couldn't resolve in time (the listing will say if it isn't a folder). */
export function canOpen(e: SftpEntry): boolean {
  const k = entryKind(e);
  return k === 'dir' || k === 'dir-link' || k === 'unresolved-link';
}

/** Longest link target shown in the UI. */
export const MAX_TARGET_CHARS = 256;

/** C0/C1 control characters, and the bidi marks, embeddings, overrides
 *  and isolates that can make text render in a misleading order. */
function isHiddenOrBidi(cp: number): boolean {
  return cp <= 0x1f
    || (cp >= 0x7f && cp <= 0x9f)
    || cp === 0x061c || cp === 0x200e || cp === 0x200f
    || (cp >= 0x202a && cp <= 0x202e)
    || (cp >= 0x2066 && cp <= 0x2069);
}

/** A link target as it may be shown: control and bidi characters removed
 *  (a server could otherwise make a link look like it points somewhere
 *  else), and capped in length. */
export function displayTarget(t: string | null | undefined): string {
  if (!t) return '';
  let cleaned = '';
  for (const ch of t) {
    if (!isHiddenOrBidi(ch.codePointAt(0) ?? 0)) cleaned += ch;
  }
  return cleaned.length > MAX_TARGET_CHARS ? `${cleaned.slice(0, MAX_TARGET_CHARS)}…` : cleaned;
}

/** Tooltip for a row: links show where they point. */
export function entryTitle(e: SftpEntry): string {
  const t = displayTarget(e.link_target) || '?';
  switch (entryKind(e)) {
    case 'broken-link': return `${e.name} → ${t} (broken link: target not found)`;
    case 'unresolved-link': return `${e.name} → ${t} (not resolved yet: the server was slow)`;
    case 'dir-link':
    case 'file-link': return `${e.name} → ${t}`;
    case 'special': return `${e.name} (special file: FIFO, socket or device)`;
    default: return e.name;
  }
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Is a server-supplied file name safe to use as a local file name inside
 *  a folder the user picked? Rejects path separators, `..`, drive or
 *  stream syntax (`:`), Windows-reserved device names, and names Windows
 *  silently rewrites (trailing dot or space). The backend checks the full
 *  path again before writing. */
export function isSafeLocalName(name: string): boolean {
  if (!name || name === '.' || name === '..') return false;
  if (/[\\/:*?"<>|]/.test(name)) return false;
  for (const ch of name) if ((ch.codePointAt(0) ?? 0) <= 0x1f) return false;
  if (/[. ]$/.test(name)) return false;
  return !WINDOWS_RESERVED.test(name);
}
