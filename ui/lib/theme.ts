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
