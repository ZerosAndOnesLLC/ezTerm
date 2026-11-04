import { describe, expect, it } from 'vitest';
import { canDownload, deleteAction, deleteConfirmBody, entryKind, entryTitle } from './sftp-entry';
import type { SftpEntry } from './types';

const base: SftpEntry = {
  name: 'x', full_path: '/x', is_dir: false, is_symlink: false, size: 1, mtime_unix: 0, mode: 0o100644,
};
const dir: SftpEntry = { ...base, name: 'd', is_dir: true, mode: 0o40755 };
const dirLink: SftpEntry = { ...base, name: 'current', is_dir: true, is_symlink: true, link_target: 'releases/42', mode: 0o120777 };
const fileLink: SftpEntry = { ...base, name: 'readme', is_symlink: true, link_target: 'README.md', mode: 0o120777 };
const broken: SftpEntry = { ...base, name: 'old', is_symlink: true, link_broken: true, link_target: '/gone', mode: 0o120777 };

describe('entryKind', () => {
  it('classifies files, dirs and the three link flavours', () => {
    expect([base, dir, dirLink, fileLink, broken].map(entryKind))
      .toEqual(['file', 'dir', 'dir-link', 'file-link', 'broken-link']);
  });
});

describe('deleteAction', () => {
  it('unlinks every symlink, including links to directories', () => {
    expect(deleteAction(dirLink)).toBe('remove');
    expect(deleteAction(fileLink)).toBe('remove');
    expect(deleteAction(broken)).toBe('remove');
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

describe('canDownload', () => {
  it('allows files and links to files only', () => {
    expect(canDownload(base)).toBe(true);
    expect(canDownload(fileLink)).toBe(true);
    expect(canDownload(dir)).toBe(false);
    expect(canDownload(dirLink)).toBe(false);
    expect(canDownload(broken)).toBe(false);
  });
});

describe('entryTitle', () => {
  it('shows link targets and flags broken links', () => {
    expect(entryTitle(dirLink)).toBe('current → releases/42');
    expect(entryTitle(broken)).toContain('broken link');
    expect(entryTitle(base)).toBe('x');
  });
});
