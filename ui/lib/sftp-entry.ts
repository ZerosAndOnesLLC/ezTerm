import type { SftpEntry } from './types';

/** What kind of row an entry is, for icon and behaviour. */
export type EntryKind = 'dir' | 'file' | 'dir-link' | 'file-link' | 'broken-link';

export function entryKind(e: SftpEntry): EntryKind {
  if (e.is_symlink) {
    if (e.link_broken) return 'broken-link';
    return e.is_dir ? 'dir-link' : 'file-link';
  }
  return e.is_dir ? 'dir' : 'file';
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
    const to = e.link_target ? ` (→ ${e.link_target})` : '';
    return `Removes the link only${to}. The file or folder it points to is not touched.`;
  }
  return e.is_dir ? 'The directory must be empty on the remote server.' : 'This cannot be undone.';
}

/** Files and links to files can be downloaded (the link is followed);
 *  folders and broken links can't. */
export function canDownload(e: SftpEntry): boolean {
  const k = entryKind(e);
  return k === 'file' || k === 'file-link';
}

/** Tooltip for a row: links show where they point. */
export function entryTitle(e: SftpEntry): string {
  const k = entryKind(e);
  if (k === 'broken-link') return `${e.name} → ${e.link_target ?? '?'} (broken link: target not found)`;
  if (k === 'dir-link' || k === 'file-link') return `${e.name} → ${e.link_target ?? '?'}`;
  return e.name;
}
