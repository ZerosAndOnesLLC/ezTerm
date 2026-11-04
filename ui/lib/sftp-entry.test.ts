import { describe, expect, it } from 'vitest';
import {
  MAX_TARGET_CHARS, canDownload, canOpen, deleteAction, deleteConfirmBody, displayTarget,
  entryKind, entryTitle, isSafeLocalName,
} from './sftp-entry';
import type { SftpEntry } from './types';

const base: SftpEntry = {
  name: 'x', full_path: '/x', is_dir: false, is_symlink: false, size: 1, mtime_unix: 0, mode: 0o100644,
};
const dir: SftpEntry = { ...base, name: 'd', is_dir: true, mode: 0o40755 };
const dirLink: SftpEntry = { ...base, name: 'current', is_dir: true, is_symlink: true, link_target: 'releases/42', mode: 0o120777 };
const fileLink: SftpEntry = { ...base, name: 'readme', is_symlink: true, link_target: 'README.md', mode: 0o120777 };
const broken: SftpEntry = { ...base, name: 'old', is_symlink: true, link_broken: true, link_target: '/gone', mode: 0o120777 };
const unresolved: SftpEntry = { ...base, name: 'nfs', is_symlink: true, link_unresolved: true, mode: 0o120777 };
const fifo: SftpEntry = { ...base, name: 'pipe', is_special: true, mode: 0o10644 };
const fifoLink: SftpEntry = { ...base, name: 'to-pipe', is_symlink: true, is_special: true, link_target: 'pipe', mode: 0o120777 };

describe('entryKind', () => {
  it('classifies files, dirs, special files and every link flavour', () => {
    expect([base, dir, fifo, dirLink, fileLink, broken, unresolved].map(entryKind))
      .toEqual(['file', 'dir', 'special', 'dir-link', 'file-link', 'broken-link', 'unresolved-link']);
  });
});

describe('deleteAction', () => {
  it('unlinks every symlink, including links to directories', () => {
    for (const e of [dirLink, fileLink, broken, unresolved]) expect(deleteAction(e)).toBe('remove');
  });
  it('uses rmdir only for real directories', () => {
    expect(deleteAction(dir)).toBe('rmdir');
    expect(deleteAction(base)).toBe('remove');
  });
  it('tells the user the target is left alone', () => {
    expect(deleteConfirmBody(dirLink)).toContain('not touched');
    expect(deleteConfirmBody(dirLink)).toContain('releases/42');
    expect(deleteConfirmBody(dir)).toContain('must be empty');
  });
});

describe('canDownload / canOpen', () => {
  it('downloads regular files and links to them only', () => {
    expect(canDownload(base)).toBe(true);
    expect(canDownload(fileLink)).toBe(true);
    for (const e of [dir, dirLink, broken, unresolved, fifo, fifoLink]) expect(canDownload(e)).toBe(false);
  });
  it('opens folders, folder links, and unresolved links (to try)', () => {
    expect([dir, dirLink, unresolved].every(canOpen)).toBe(true);
    expect([base, fileLink, broken, fifo].some(canOpen)).toBe(false);
  });
});

describe('displayTarget', () => {
  it('strips control and bidi characters', () => {
    expect(displayTarget('/etc/\u202Edwssap')).toBe('/etc/dwssap');
    expect(displayTarget('a\nb\u0007c\u2066d')).toBe('abcd');
  });
  it('caps very long targets', () => {
    const t = displayTarget('x'.repeat(5000));
    expect(t.length).toBe(MAX_TARGET_CHARS + 1);
    expect(t.endsWith('…')).toBe(true);
  });
  it('is empty for missing targets', () => {
    expect(displayTarget(null)).toBe('');
    expect(displayTarget(undefined)).toBe('');
  });
});

describe('entryTitle', () => {
  it('shows link targets and flags broken / unresolved links', () => {
    expect(entryTitle(dirLink)).toBe('current → releases/42');
    expect(entryTitle(broken)).toContain('broken link');
    expect(entryTitle(unresolved)).toContain('not resolved');
    expect(entryTitle(base)).toBe('x');
  });
});

describe('isSafeLocalName', () => {
  it('accepts ordinary names', () => {
    for (const n of ['report.txt', '..foo', 'a b', 'COMPANY.txt', 'com0']) expect(isSafeLocalName(n)).toBe(true);
  });
  it('rejects traversal, separators, drives, reserved and rewritten names', () => {
    for (const n of ['..', '.', '', '..\\..\\x.bat', 'a/b', 'C:x', 'CON', 'nul.txt', 'Lpt3.log', 'x.', 'x ', 'a\u0001b']) {
      expect(isSafeLocalName(n)).toBe(false);
    }
  });
});
