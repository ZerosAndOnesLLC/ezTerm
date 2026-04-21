'use client';
import { useEffect, useState } from 'react';
import { Lock, Moon, Sun } from 'lucide-react';
import { applyTheme, loadTheme, saveTheme, type Theme } from '@/lib/theme';
import { useTabs } from '@/lib/tabs-store';

type StatusBarProps = { onLock: () => void };

export function StatusBar({ onLock }: StatusBarProps) {
  const [theme, setTheme] = useState<Theme>(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('light')
      ? 'light'
      : 'dark',
  );
  const tabs     = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const active   = tabs.find((t) => t.tabId === activeId) ?? null;

  useEffect(() => { loadTheme().then(setTheme); }, []);

  async function toggleTheme() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    applyTheme(next);
    await saveTheme(next);
  }

  // Status dot colour tracks connection state. Animate pulse on
  // connecting / error-with-retry so the bar shows "something is happening".
  let dotCls = 'bg-muted';
  let dotLabel = 'idle';
  if (active) {
    if (active.status === 'connected') { dotCls = 'bg-success'; dotLabel = 'connected'; }
    else if (active.status === 'connecting') { dotCls = 'bg-warning animate-pulse'; dotLabel = 'connecting'; }
    else if (active.status === 'error') { dotCls = 'bg-danger'; dotLabel = 'error'; }
    else if (active.status === 'closed') { dotCls = 'bg-muted'; dotLabel = 'closed'; }
  }

  const sessionSummary = active
    ? `${active.session.username}@${active.session.host}${active.session.port !== 22 ? `:${active.session.port}` : ''}`
    : 'No active session';

  return (
    <footer className="h-6 border-t border-border bg-surface text-muted text-[11px] flex items-center px-2 gap-2 shrink-0">
      <span
        className={`w-1.5 h-1.5 rounded-full ${dotCls} shrink-0`}
        aria-label={dotLabel}
        title={dotLabel}
      />
      <span className="truncate font-mono" title={sessionSummary}>{sessionSummary}</span>
      {active?.sftpOpen && (
        <>
          <span className="opacity-40" aria-hidden>·</span>
          <span className="truncate font-mono" title={`SFTP: ${active.cwd}`}>
            SFTP {active.cwd}
          </span>
        </>
      )}
      <span className="flex-1" />
      <span className="opacity-60 tabular-nums">ezTerm v0.6</span>
      <span className="opacity-40" aria-hidden>·</span>
      <button
        type="button"
        onClick={toggleTheme}
        aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
        className="icon-btn w-5 h-5"
      >
        {theme === 'dark' ? <Sun size={12} /> : <Moon size={12} />}
      </button>
      <button
        type="button"
        onClick={onLock}
        aria-label="Lock vault"
        title="Lock vault"
        className="icon-btn w-5 h-5"
      >
        <Lock size={12} />
      </button>
    </footer>
  );
}
