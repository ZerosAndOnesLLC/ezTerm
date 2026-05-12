// site/src/lib/version.test.ts
import { describe, it, expect } from 'vitest';
import { parseVersion, compareVersionsDesc } from './version';

describe('parseVersion', () => {
  it('parses a plain semver filename', () => {
    expect(parseVersion('v1.3.4.md')).toEqual({ major: 1, minor: 3, patch: 4, raw: 'v1.3.4' });
  });
  it('parses without leading v', () => {
    expect(parseVersion('1.0.0.md')).toEqual({ major: 1, minor: 0, patch: 0, raw: '1.0.0' });
  });
  it('parses a two-digit minor', () => {
    expect(parseVersion('v1.10.0.md')).toEqual({ major: 1, minor: 10, patch: 0, raw: 'v1.10.0' });
  });
  it('returns null for an unparseable name', () => {
    expect(parseVersion('not-a-version.md')).toBeNull();
  });
});

describe('compareVersionsDesc', () => {
  it('puts higher major first', () => {
    expect(compareVersionsDesc('v2.0.0.md', 'v1.9.9.md')).toBeLessThan(0);
  });
  it('compares minor numerically, not lexically', () => {
    // The whole point of this module: v1.10 > v1.3, not the other way.
    expect(compareVersionsDesc('v1.10.0.md', 'v1.3.4.md')).toBeLessThan(0);
  });
  it('compares patch when major/minor tie', () => {
    expect(compareVersionsDesc('v1.3.5.md', 'v1.3.4.md')).toBeLessThan(0);
  });
  it('sorts an array of release-note filenames newest-first', () => {
    const files = ['v0.12.0.md', 'v1.10.0.md', 'v1.3.4.md', 'v0.18.2.md', 'v1.0.0.md'];
    const sorted = [...files].sort(compareVersionsDesc);
    expect(sorted).toEqual(['v1.10.0.md', 'v1.3.4.md', 'v1.0.0.md', 'v0.18.2.md', 'v0.12.0.md']);
  });
  it('puts unparseable names at the end (stable)', () => {
    const files = ['weird.md', 'v1.0.0.md'];
    expect([...files].sort(compareVersionsDesc)).toEqual(['v1.0.0.md', 'weird.md']);
  });
});
