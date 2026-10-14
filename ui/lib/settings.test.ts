import { describe, expect, it } from 'vitest';
import { DEFAULTS, normalizeSetting, parseSetting, SPEC } from './settings';

describe('parseSetting', () => {
  it('falls back to the default for missing values', () => {
    expect(parseSetting('terminal.scrollback', null)).toBe(5000);
    expect(parseSetting('terminal.bell', undefined)).toBe('none');
  });

  it('parses booleans strictly', () => {
    expect(parseSetting('terminal.copyOnSelect', 'true')).toBe(true);
    expect(parseSetting('terminal.copyOnSelect', 'false')).toBe(false);
    expect(parseSetting('terminal.copyOnSelect', 'yes')).toBe(false);
    expect(parseSetting('terminal.osc52Clipboard', '0')).toBe(true); // default on
  });

  it('rejects out-of-range or non-integer numbers', () => {
    expect(parseSetting('terminal.fontSize', '14')).toBe(14);
    expect(parseSetting('terminal.fontSize', '4')).toBe(13);
    expect(parseSetting('terminal.fontSize', '14.5')).toBe(13);
    expect(parseSetting('terminal.fontSize', 'big')).toBe(13);
  });

  it('rejects unknown enum values', () => {
    expect(parseSetting('terminal.rightClick', 'paste')).toBe('paste');
    expect(parseSetting('terminal.rightClick', 'middle')).toBe('menu');
  });
});

describe('normalizeSetting', () => {
  it('clamps and rounds integers', () => {
    expect(normalizeSetting('security.idleLockMinutes', 99_999)).toBe(1440);
    expect(normalizeSetting('security.idleLockMinutes', -3)).toBe(0);
    expect(normalizeSetting('terminal.fontSize', 13.6)).toBe(14);
  });

  it('returns null for unrepresentable input', () => {
    expect(normalizeSetting('terminal.fontSize', Number.NaN)).toBeNull();
    expect(normalizeSetting('terminal.bell', 'loud' as never)).toBeNull();
  });

  it('truncates over-long strings', () => {
    const long = 'x'.repeat(500);
    expect(normalizeSetting('terminal.fontFamily', long)).toHaveLength(200);
  });
});

describe('SPEC', () => {
  it('has a default for every key and DEFAULTS mirrors it', () => {
    for (const key of Object.keys(SPEC) as (keyof typeof SPEC)[]) {
      expect(DEFAULTS[key]).toBe(SPEC[key].default);
    }
  });
});
