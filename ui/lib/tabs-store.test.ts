import { describe, expect, it } from 'vitest';
import {
  clampSftpColumn, parseSftpColumns,
  SFTP_COL_DEFAULT, SFTP_COL_MAX, SFTP_COL_MIN,
} from './tabs-store';

describe('parseSftpColumns', () => {
  it('returns defaults for missing or malformed storage', () => {
    expect(parseSftpColumns(null)).toEqual(SFTP_COL_DEFAULT);
    expect(parseSftpColumns('')).toEqual(SFTP_COL_DEFAULT);
    expect(parseSftpColumns('not json')).toEqual(SFTP_COL_DEFAULT);
    expect(parseSftpColumns('42')).toEqual(SFTP_COL_DEFAULT);
    expect(parseSftpColumns('null')).toEqual(SFTP_COL_DEFAULT);
  });

  it('keeps in-range widths and rounds them', () => {
    expect(parseSftpColumns('{"name":300.4,"size":90}')).toEqual({ name: 300, size: 90 });
  });

  it('falls back per column for out-of-range or non-numeric values', () => {
    const r = parseSftpColumns(`{"name":${SFTP_COL_MAX.name + 1},"size":"wide"}`);
    expect(r).toEqual(SFTP_COL_DEFAULT);
    const r2 = parseSftpColumns(`{"name":${SFTP_COL_MIN.name - 1},"size":100}`);
    expect(r2).toEqual({ name: SFTP_COL_DEFAULT.name, size: 100 });
  });

  it('ignores unknown keys', () => {
    const r = parseSftpColumns('{"name":200,"size":60,"mode":999}');
    expect(r).toEqual({ name: 200, size: 60 });
    expect('mode' in r).toBe(false);
  });

  it('does not return the shared default object', () => {
    const r = parseSftpColumns(null);
    r.name = 1;
    expect(SFTP_COL_DEFAULT.name).not.toBe(1);
  });
});

describe('clampSftpColumn', () => {
  it('clamps to the per-column bounds', () => {
    expect(clampSftpColumn('name', 10)).toBe(SFTP_COL_MIN.name);
    expect(clampSftpColumn('name', 99999)).toBe(SFTP_COL_MAX.name);
    expect(clampSftpColumn('size', 100.6)).toBe(101);
  });

  it('uses the default for non-finite input', () => {
    expect(clampSftpColumn('size', NaN)).toBe(SFTP_COL_DEFAULT.size);
    expect(clampSftpColumn('name', Infinity)).toBe(SFTP_COL_DEFAULT.name);
  });
});
