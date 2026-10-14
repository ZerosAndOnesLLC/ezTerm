import { create } from 'zustand';
import { api } from './tauri';

export type Theme = 'dark' | 'light';

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.remove('dark', 'light');
  root.classList.add(theme);
}

export async function loadTheme(): Promise<Theme> {
  try {
    const saved = await api.settingsGet('theme');
    return saved === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export async function saveTheme(theme: Theme) {
  await api.settingsSet('theme', theme);
}

interface ThemeState {
  theme: Theme;
  /** Apply to the document, persist, and notify every subscriber (status
   *  bar toggle and the Settings panel both show the current theme). */
  setTheme: (t: Theme) => Promise<void>;
}

/** `theme` is the one setting read before unlock (the unlock screen
 *  needs it), so it is not part of lib/settings.ts; it has its own key
 *  on the public settings allow-list in Rust. */
export const useTheme = create<ThemeState>((set) => ({
  theme: typeof document !== 'undefined' && document.documentElement.classList.contains('light')
    ? 'light'
    : 'dark',
  setTheme: async (t) => {
    set({ theme: t });
    applyTheme(t);
    await saveTheme(t);
  },
}));
