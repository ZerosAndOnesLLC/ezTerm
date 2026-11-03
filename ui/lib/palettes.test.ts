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

  it('keeps the pre-#176 theme as the default so upgrades look the same', () => {
    // The exact theme object ui/lib/xterm.ts hard-coded before #176.
    const pre176 = {
      background:          '#121214',
      foreground:          '#e5e7eb',
      cursor:              '#e5e7eb',
      cursorAccent:        '#121214',
      selectionBackground: '#2d3748',
      overviewRulerBorder: 'rgba(0, 0, 0, 0)',
      scrollbarSliderBackground:       'rgba(255, 255, 255, 0.18)',
      scrollbarSliderHoverBackground:  'rgba(255, 255, 255, 0.30)',
      scrollbarSliderActiveBackground: 'rgba(255, 255, 255, 0.45)',
      black:   '#2d3748', red:     '#f87171',
      green:   '#34d399', yellow:  '#fbbf24',
      blue:    '#60a5fa', magenta: '#a78bfa',
      cyan:    '#22d3ee', white:   '#e5e7eb',
      brightBlack:   '#475569', brightRed:     '#fca5a5',
      brightGreen:   '#6ee7b7', brightYellow:  '#fcd34d',
      brightBlue:    '#93c5fd', brightMagenta: '#c4b5fd',
      brightCyan:    '#67e8f9', brightWhite:   '#f3f4f6',
    };
    expect(buildXtermTheme(PALETTES[DEFAULT_PALETTE])).toEqual(pre176);
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

  it('tints the scrollbar white on dark palettes and black on light ones', () => {
    const slider = (id: keyof typeof PALETTES) => {
      const t = buildXtermTheme(PALETTES[id]);
      return [t.scrollbarSliderBackground, t.scrollbarSliderHoverBackground, t.scrollbarSliderActiveBackground];
    };
    expect(slider('ezterm-dark')).toEqual([
      'rgba(255, 255, 255, 0.18)', 'rgba(255, 255, 255, 0.30)', 'rgba(255, 255, 255, 0.45)',
    ]);
    expect(slider('ezterm-light')).toEqual([
      'rgba(0, 0, 0, 0.18)', 'rgba(0, 0, 0, 0.30)', 'rgba(0, 0, 0, 0.45)',
    ]);
  });
});
