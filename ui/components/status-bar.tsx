'use client';
import { useEffect, useState } from 'react';
import { applyTheme, loadTheme, saveTheme, type Theme } from '@/lib/theme';

export function StatusBar({ onLock }: { onLock: () => void }) {
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => { loadTheme().then(setTheme); }, []);

  async function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    applyTheme(next);
    await saveTheme(next);
  }

  return (
    <footer className="h-8 border-t border-border bg-surface text-muted text-xs flex items-center px-3 gap-3">
      <span>ezTerm v0.1</span>
      <span className="flex-1" />
      <button onClick={toggle} className="hover:text-fg">
        {theme === 'dark' ? 'Light theme' : 'Dark theme'}
      </button>
      <button onClick={onLock} className="hover:text-fg">Lock</button>
    </footer>
  );
}
