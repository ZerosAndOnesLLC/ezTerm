'use client';
import { useEffect, useState } from 'react';
import { applyTheme, loadTheme, saveTheme, type Theme } from '@/lib/theme';

export function StatusBar({ onLock }: { onLock: () => void }) {
  const [theme, setTheme] = useState<Theme>(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('light')
      ? 'light'
      : 'dark',
  );

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
      <button
        onClick={toggle}
        className="hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent rounded px-1"
      >
        {theme === 'dark' ? 'Light theme' : 'Dark theme'}
      </button>
      <button
        onClick={onLock}
        className="hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent rounded px-1"
      >
        Lock
      </button>
    </footer>
  );
}
