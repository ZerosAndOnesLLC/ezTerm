import { describe, expect, it } from 'vitest';
import { buildXtermTheme, DEFAULT_PALETTE, getPalette, PALETTE_IDS, PALETTES } from './palettes';

const HEX = /^#[0-9a-f]{6}$/;

describe('PALETTES', () => {
  it('has one well-formed entry per id', () => {
    for (const id of PALETTE_IDS) {
      const p = PALETTES[id];
      expect(p.id).toBe(id);
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.ansi).toHaveLength(16);
      for (const c of [p.background, p.foreground, p.cursor, p.cursorAccent, p.selectionBackground, ...p.ansi]) {
        expect(c).toMatch(HEX);
      }
    }
  });

  it('has unique labels', () => {
    const labels = PALETTE_IDS.map((id) => PALETTES[id].label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('keeps the pre-#176 palette as the default so upgrades look the same', () => {
    const p = PALETTES[DEFAULT_PALETTE];
    expect(p.background).toBe('#121214');
    expect(p.foreground).toBe('#e5e7eb');
    expect(p.ansi[1]).toBe('#f87171');
    expect(p.ansi[15]).toBe('#f3f4f6');
  });
});

describe('PALETTES from Ptyxis', () => {
  it('match the upstream .palette files for a spot-check of slots', () => {
    expect(PALETTES['gnome-dark'].ansi[2]).toBe('#2ec27e');
    expect(PALETTES['gnome-light'].ansi[11]).toBe('#e9ad0c');
    expect(PALETTES['github-dark'].cursor).toBe('#c9d1d9');
    expect(PALETTES['github-light'].ansi[4]).toBe('#003e8a');
    expect(PALETTES['google-dark'].ansi[11]).toBe('#fbbc05');
    expect(PALETTES['google-light'].foreground).toBe('#5f6368');
  });

  it('pair each light half with a dark half', () => {
    for (const base of ['gnome', 'github', 'google'] as const) {
      expect(PALETTES[`${base}-dark`].light).toBe(false);
      expect(PALETTES[`${base}-light`].light).toBe(true);
    }
  });
});

describe('getPalette', () => {
  it('resolves known ids and falls back to the default otherwise', () => {
    expect(getPalette('dracula').id).toBe('dracula');
    expect(getPalette('no-such-palette').id).toBe(DEFAULT_PALETTE);
    expect(getPalette(null).id).toBe(DEFAULT_PALETTE);
    expect(getPalette('constructor').id).toBe(DEFAULT_PALETTE);
  });
});

describe('buildXtermTheme', () => {
  it('maps the 16 ANSI slots and surfaces', () => {
    const t = buildXtermTheme(PALETTES['solarized-dark']);
    expect(t.background).toBe('#002b36');
    expect(t.black).toBe('#073642');
    expect(t.brightWhite).toBe('#fdf6e3');
    expect(t.overviewRulerBorder).toBe('rgba(0, 0, 0, 0)');
  });

  it('tints the scrollbar for light palettes', () => {
    expect(buildXtermTheme(PALETTES['ezterm-dark']).scrollbarSliderBackground).toContain('255, 255, 255');
    expect(buildXtermTheme(PALETTES['ezterm-light']).scrollbarSliderBackground).toContain('0, 0, 0');
  });
});
