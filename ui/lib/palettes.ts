/**
 * Built-in terminal colour palettes (#176).
 *
 * A palette is the 16 ANSI colours plus the surface colours xterm.js
 * needs (background, foreground, cursor, selection). The user picks one
 * app-wide in Settings → Appearance; the choice is stored as the
 * `terminal.palette` key and applied live to every open tab.
 *
 * `ezterm-dark` is byte-for-byte the palette the app shipped with before
 * palettes were selectable, so upgrading users see no change. The other
 * entries use their upstream reference values (Solarized, Dracula, Nord,
 * Gruvbox, One Dark, Monokai, Tango, Campbell). The GNOME, GitHub and
 * Google pairs are the Light / Dark halves of the palettes Ptyxis ships
 * (src/palettes/*.palette). Ptyxis carries no selection colour, so those
 * six use a hand-picked tint of the background.
 *
 * The palette deliberately does NOT follow the window theme toggle
 * (design-system §2.3): users pick terminal colours once and expect them
 * to stay put. Light palettes are available as an explicit choice.
 */
import type { ITheme } from '@xterm/xterm';

export const PALETTE_IDS = [
  'ezterm-dark',
  'ezterm-light',
  'campbell',
  'solarized-dark',
  'solarized-light',
  'dracula',
  'gruvbox-dark',
  'nord',
  'one-dark',
  'monokai',
  'tango',
  'gnome-dark',
  'gnome-light',
  'github-dark',
  'github-light',
  'google-dark',
  'google-light',
] as const;

export type PaletteId = (typeof PALETTE_IDS)[number];

/** 16 ANSI colours in index order: 0–7 normal, 8–15 bright. */
export type Ansi16 = readonly [
  string, string, string, string, string, string, string, string,
  string, string, string, string, string, string, string, string,
];

export interface Palette {
  id: PaletteId;
  /** Shown in the Settings select. */
  label: string;
  /** True for light-background palettes; drives the scrollbar slider
   *  tint and lets the UI group light choices together. */
  light: boolean;
  background: string;
  foreground: string;
  cursor: string;
  /** Text colour under a block cursor. */
  cursorAccent: string;
  selectionBackground: string;
  ansi: Ansi16;
}

export const DEFAULT_PALETTE: PaletteId = 'ezterm-dark';

export const PALETTES: { readonly [K in PaletteId]: Palette } = {
  'ezterm-dark': {
    id: 'ezterm-dark',
    label: 'ezTerm Dark (default)',
    light: false,
    background: '#121214',
    foreground: '#e5e7eb',
    cursor: '#e5e7eb',
    cursorAccent: '#121214',
    selectionBackground: '#2d3748',
    ansi: [
      '#2d3748', '#f87171', '#34d399', '#fbbf24', '#60a5fa', '#a78bfa', '#22d3ee', '#e5e7eb',
      '#475569', '#fca5a5', '#6ee7b7', '#fcd34d', '#93c5fd', '#c4b5fd', '#67e8f9', '#f3f4f6',
    ],
  },
  // design-system.md §8 "light terminal" preset.
  'ezterm-light': {
    id: 'ezterm-light',
    label: 'ezTerm Light',
    light: true,
    background: '#f8f8f8',
    foreground: '#1a1a1a',
    cursor: '#1a1a1a',
    cursorAccent: '#f8f8f8',
    selectionBackground: '#b0cef7',
    ansi: [
      '#0c0c0c', '#a4251f', '#237a3f', '#8a7010', '#1e6ecd', '#8a389a', '#1f7f97', '#555555',
      '#676767', '#c23127', '#31a354', '#b08a1a', '#3b78ff', '#b148c6', '#3aa4c6', '#1a1a1a',
    ],
  },
  // Windows Terminal / conhost default. MobaXterm-adjacent look.
  campbell: {
    id: 'campbell',
    label: 'Campbell (Windows Terminal)',
    light: false,
    background: '#0c0c0c',
    foreground: '#cccccc',
    cursor: '#cccccc',
    cursorAccent: '#0c0c0c',
    selectionBackground: '#3a4b6b',
    ansi: [
      '#0c0c0c', '#c50f1f', '#13a10e', '#c19c00', '#0037da', '#881798', '#3a96dd', '#cccccc',
      '#767676', '#e74856', '#16c60c', '#f9f1a5', '#3b78ff', '#b4009e', '#61d6d6', '#f2f2f2',
    ],
  },
  'solarized-dark': {
    id: 'solarized-dark',
    label: 'Solarized Dark',
    light: false,
    background: '#002b36',
    foreground: '#839496',
    cursor: '#839496',
    cursorAccent: '#002b36',
    selectionBackground: '#073642',
    ansi: [
      '#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5',
      '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3',
    ],
  },
  'solarized-light': {
    id: 'solarized-light',
    label: 'Solarized Light',
    light: true,
    background: '#fdf6e3',
    foreground: '#657b83',
    cursor: '#657b83',
    cursorAccent: '#fdf6e3',
    selectionBackground: '#eee8d5',
    ansi: [
      '#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5',
      '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3',
    ],
  },
  dracula: {
    id: 'dracula',
    label: 'Dracula',
    light: false,
    background: '#282a36',
    foreground: '#f8f8f2',
    cursor: '#f8f8f2',
    cursorAccent: '#282a36',
    selectionBackground: '#44475a',
    ansi: [
      '#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2',
      '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff',
    ],
  },
  'gruvbox-dark': {
    id: 'gruvbox-dark',
    label: 'Gruvbox Dark',
    light: false,
    background: '#282828',
    foreground: '#ebdbb2',
    cursor: '#ebdbb2',
    cursorAccent: '#282828',
    selectionBackground: '#504945',
    ansi: [
      '#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984',
      '#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2',
    ],
  },
  nord: {
    id: 'nord',
    label: 'Nord',
    light: false,
    background: '#2e3440',
    foreground: '#d8dee9',
    cursor: '#d8dee9',
    cursorAccent: '#2e3440',
    selectionBackground: '#434c5e',
    ansi: [
      '#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0',
      '#4c566a', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4',
    ],
  },
  'one-dark': {
    id: 'one-dark',
    label: 'One Dark',
    light: false,
    background: '#282c34',
    foreground: '#abb2bf',
    cursor: '#528bff',
    cursorAccent: '#282c34',
    selectionBackground: '#3e4451',
    ansi: [
      '#282c34', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf',
      '#5c6370', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#ffffff',
    ],
  },
  monokai: {
    id: 'monokai',
    label: 'Monokai',
    light: false,
    background: '#272822',
    foreground: '#f8f8f2',
    cursor: '#f8f8f0',
    cursorAccent: '#272822',
    selectionBackground: '#49483e',
    ansi: [
      '#272822', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f8f8f2',
      '#75715e', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f9f8f5',
    ],
  },
  // GNOME Terminal's classic default.
  tango: {
    id: 'tango',
    label: 'Tango',
    light: false,
    background: '#2e3436',
    foreground: '#d3d7cf',
    cursor: '#d3d7cf',
    cursorAccent: '#2e3436',
    selectionBackground: '#555753',
    ansi: [
      '#2e3436', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf',
      '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec',
    ],
  },
  // Ptyxis "GNOME" palette (gnome.palette), Dark half.
  'gnome-dark': {
    id: 'gnome-dark',
    label: 'GNOME Dark',
    light: false,
    background: '#1c1c1f',
    foreground: '#ffffff',
    cursor: '#ffffff',
    cursorAccent: '#1c1c1f',
    selectionBackground: '#3d3d42',
    ansi: [
      '#241f31', '#c01c28', '#2ec27e', '#f5c211', '#1e78e4', '#9841bb', '#0ab9dc', '#c0bfbc',
      '#5e5c64', '#ed333b', '#57e389', '#f8e45c', '#51a1ff', '#c061cb', '#4fd2fd', '#f6f5f4',
    ],
  },
  // Ptyxis "GNOME" palette (gnome.palette), Light half.
  'gnome-light': {
    id: 'gnome-light',
    label: 'GNOME Light',
    light: true,
    background: '#ffffff',
    foreground: '#1d1d20',
    cursor: '#1d1d20',
    cursorAccent: '#ffffff',
    selectionBackground: '#bfd4f0',
    ansi: [
      '#1d1d20', '#c01c28', '#26a269', '#a2734c', '#12488b', '#a347ba', '#2aa1b3', '#cfcfcf',
      '#5d5d5d', '#f66151', '#33d17a', '#e9ad0c', '#2a7bde', '#c061cb', '#33c7de', '#ffffff',
    ],
  },
  // Ptyxis "Github" palette (Github.palette), Dark half.
  'github-dark': {
    id: 'github-dark',
    label: 'GitHub Dark',
    light: false,
    background: '#101216',
    foreground: '#8b949e',
    cursor: '#c9d1d9',
    cursorAccent: '#101216',
    selectionBackground: '#263c5a',
    ansi: [
      '#000000', '#f78166', '#56d364', '#e3b341', '#6ca4f8', '#db61a2', '#2b7489', '#ffffff',
      '#4d4d4d', '#f78166', '#56d364', '#e3b341', '#6ca4f8', '#db61a2', '#2b7489', '#ffffff',
    ],
  },
  // Ptyxis "Github" palette (Github.palette), Light half.
  'github-light': {
    id: 'github-light',
    label: 'GitHub Light',
    light: true,
    background: '#f4f4f4',
    foreground: '#3e3e3e',
    cursor: '#3e3e3e',
    cursorAccent: '#f4f4f4',
    selectionBackground: '#c8e1ff',
    ansi: [
      '#3e3e3e', '#970b16', '#07962a', '#f8eec7', '#003e8a', '#e94691', '#89d1ec', '#ffffff',
      '#666666', '#de0000', '#87d5a2', '#f1d007', '#2e6cba', '#ffa29f', '#1cfafe', '#ffffff',
    ],
  },
  // Ptyxis "Google" palette (Google.palette), Dark half.
  'google-dark': {
    id: 'google-dark',
    label: 'Google Dark',
    light: false,
    background: '#202124',
    foreground: '#e8eaed',
    cursor: '#e8eaed',
    cursorAccent: '#202124',
    selectionBackground: '#3c4043',
    ansi: [
      '#202124', '#ea4335', '#34a853', '#fbbc04', '#4285f4', '#a142f4', '#24c1e0', '#e8eaed',
      '#5f6368', '#ea4335', '#34a853', '#fbbc05', '#4285f4', '#a142f4', '#24c1e0', '#ffffff',
    ],
  },
  // Ptyxis "Google" palette (Google.palette), Light half.
  'google-light': {
    id: 'google-light',
    label: 'Google Light',
    light: true,
    background: '#ffffff',
    foreground: '#5f6368',
    cursor: '#5f6368',
    cursorAccent: '#ffffff',
    selectionBackground: '#d2e3fc',
    ansi: [
      '#202124', '#ea4335', '#34a853', '#fbbc04', '#4285f4', '#a142f4', '#24c1e0', '#e8eaed',
      '#5f6368', '#ea4335', '#34a853', '#fbbc05', '#4285f4', '#a142f4', '#24c1e0', '#ffffff',
    ],
  },
};

/** Resolve an id to its palette, falling back to the default for
 *  anything unknown (settings rows are user-editable). */
export function getPalette(id: string | null | undefined): Palette {
  return (id && Object.prototype.hasOwnProperty.call(PALETTES, id) ? PALETTES[id as PaletteId] : PALETTES[DEFAULT_PALETTE]);
}

/** Build the xterm.js `theme` option for a palette. The scrollbar and
 *  overview-ruler entries are chrome, not palette: they are derived here
 *  so a light palette gets a dark slider and vice versa. */
export function buildXtermTheme(palette: Palette): ITheme {
  const slider = palette.light ? '0, 0, 0' : '255, 255, 255';
  const [
    black, red, green, yellow, blue, magenta, cyan, white,
    brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite,
  ] = palette.ansi;
  return {
    background:          palette.background,
    foreground:          palette.foreground,
    cursor:              palette.cursor,
    cursorAccent:        palette.cursorAccent,
    selectionBackground: palette.selectionBackground,
    // Overview-ruler always paints a 1 px left border using this
    // colour. We're not using the ruler for anything, so kill it.
    overviewRulerBorder: 'rgba(0, 0, 0, 0)',
    // Slim slider with subtle hover/active brighten so it picks up on
    // interaction without clashing with content.
    scrollbarSliderBackground:       `rgba(${slider}, 0.18)`,
    scrollbarSliderHoverBackground:  `rgba(${slider}, 0.30)`,
    scrollbarSliderActiveBackground: `rgba(${slider}, 0.45)`,
    black, red, green, yellow, blue, magenta, cyan, white,
    brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite,
  };
}
