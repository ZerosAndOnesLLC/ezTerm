/** OS-aware terminal font presets. Shared by the session dialog (full
 *  settings form) and the Font… popover (right-click in terminal).
 *
 *  We keep the lists short and conservative — each entry is a font
 *  that ships with the target OS by default or is widely installed
 *  (Fira Code, JetBrains Mono). Users can still type a custom family
 *  in the session dialog; the popover is a quick-picker and shows
 *  "(custom)" for non-preset values without overwriting them. */
export type OS = 'windows' | 'macos' | 'linux';

export interface FontChoice {
  value: string;
  label: string;
}

/** Detect the current OS via browser APIs. Runs once per module load.
 *  Tauri's webview exposes the usual `navigator.platform` / userAgent,
 *  so we don't need to reach into `@tauri-apps/api/os` for this. */
export function detectOS(): OS {
  if (typeof navigator === 'undefined') return 'windows';
  const platform = (navigator.platform || '').toLowerCase();
  if (platform.startsWith('mac')) return 'macos';
  if (platform.startsWith('win')) return 'windows';
  if (platform.startsWith('linux')) return 'linux';
  const ua = (navigator.userAgent || '').toLowerCase();
  if (ua.includes('mac os x') || ua.includes('macintosh')) return 'macos';
  if (ua.includes('windows')) return 'windows';
  if (ua.includes('linux')) return 'linux';
  return 'windows';
}

const FONT_CHOICES_BY_OS: Record<OS, ReadonlyArray<FontChoice>> = {
  windows: [
    { value: '',                label: '(default)' },
    { value: 'Cascadia Mono',   label: 'Cascadia Mono' },
    { value: 'Cascadia Code',   label: 'Cascadia Code' },
    { value: 'Consolas',        label: 'Consolas' },
    { value: 'Courier New',     label: 'Courier New' },
    { value: 'Lucida Console',  label: 'Lucida Console' },
    { value: 'Fira Code',       label: 'Fira Code' },
    { value: 'JetBrains Mono',  label: 'JetBrains Mono' },
    { value: 'MS Gothic',       label: 'MS Gothic' },
  ],
  macos: [
    { value: '',                label: '(default)' },
    { value: 'SF Mono',         label: 'SF Mono' },
    { value: 'Menlo',           label: 'Menlo' },
    { value: 'Monaco',          label: 'Monaco' },
    { value: 'Andale Mono',     label: 'Andale Mono' },
    { value: 'Courier New',     label: 'Courier New' },
    { value: 'Fira Code',       label: 'Fira Code' },
    { value: 'JetBrains Mono',  label: 'JetBrains Mono' },
  ],
  linux: [
    { value: '',                label: '(default)' },
    { value: 'DejaVu Sans Mono',label: 'DejaVu Sans Mono' },
    { value: 'Liberation Mono', label: 'Liberation Mono' },
    { value: 'Ubuntu Mono',     label: 'Ubuntu Mono' },
    { value: 'Noto Sans Mono',  label: 'Noto Sans Mono' },
    { value: 'Source Code Pro', label: 'Source Code Pro' },
    { value: 'Courier 10 Pitch',label: 'Courier 10 Pitch' },
    { value: 'Fira Code',       label: 'Fira Code' },
    { value: 'JetBrains Mono',  label: 'JetBrains Mono' },
  ],
};

/** Font presets for the running OS. Returns a *new* reference each
 *  call so callers can freely spread/sort without mutating state. */
export function fontChoicesForOS(os: OS = detectOS()): FontChoice[] {
  return [...FONT_CHOICES_BY_OS[os]];
}

export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 48;
