// site/src/lib/version.ts
//
// Parse and order semver release-note filenames so v1.10.0 > v1.3.4
// (lexical sort would do the opposite).

export interface Version {
  major: number;
  minor: number;
  patch: number;
  raw: string; // "v1.3.4" or "1.3.4" — exactly what appeared, no .md
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:\.md)?$/;

export function parseVersion(filename: string): Version | null {
  const m = filename.match(SEMVER_RE);
  if (!m) return null;
  const [, major, minor, patch] = m;
  const raw = filename.replace(/\.md$/, '');
  return { major: Number(major), minor: Number(minor), patch: Number(patch), raw };
}

// Sort comparator: newest-first. Unparseable filenames go to the end.
export function compareVersionsDesc(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va && !vb) return 0;
  if (!va) return 1;
  if (!vb) return -1;
  if (va.major !== vb.major) return vb.major - va.major;
  if (va.minor !== vb.minor) return vb.minor - va.minor;
  return vb.patch - va.patch;
}
