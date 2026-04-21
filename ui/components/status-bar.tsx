'use client';
import { useEffect, useState } from 'react';
import { Lock, Monitor, Moon, Sparkles, Sun } from 'lucide-react';
import { applyTheme, loadTheme, saveTheme, type Theme } from '@/lib/theme';
import { api } from '@/lib/tauri';
import { useTabs } from '@/lib/tabs-store';
import type { XServerStatus } from '@/lib/types';

type StatusBarProps = { onLock: () => void; onOpenUpdater: () => void };

export function StatusBar({ onLock, onOpenUpdater }: StatusBarProps) {
  const [theme, setTheme] = useState<Theme>(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('light')
      ? 'light'
      : 'dark',
  );
  const tabs     = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const active   = tabs.find((t) => t.tabId === activeId) ?? null;

  useEffect(() => { loadTheme().then(setTheme); }, []);

  // X server state — polled lightly so the pill reflects VcXsrv coming up
  // or going away as sessions toggle X11 forwarding. Hidden entirely when
  // VcXsrv isn't installed AND no display is running, so users who don't
  // use X11 forwarding never see the pill.
  const [xstatus, setXstatus] = useState<XServerStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const s = await api.xserverStatus();
        if (!cancelled) setXstatus(s);
      } catch { /* vault locked / not ready */ }
    }
    refresh();
    const h = setInterval(refresh, 5000);
    return () => { cancelled = true; clearInterval(h); };
  }, []);

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
      {xstatus && (xstatus.running_displays.length > 0 || xstatus.installed) && (
        <>
          <XServerPill status={xstatus} />
          <span className="opacity-40" aria-hidden>·</span>
        </>
      )}
      <span className="opacity-60 tabular-nums">ezTerm v0.11</span>
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
        onClick={onOpenUpdater}
        aria-label="Check for updates"
        title="Check for updates"
        className="icon-btn w-5 h-5"
      >
        <Sparkles size={12} />
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

function XServerPill({ status }: { status: XServerStatus }) {
  const running = status.running_displays.length > 0;
  const tone = running
    ? 'text-success'
    : status.installed
      ? 'text-muted'
      : 'text-warning';
  const title = running
    ? `VcXsrv running on :${status.running_displays.join(', :')}`
    : status.installed
      ? `VcXsrv installed at ${status.install_path} — starts when an SSH session forwards X11`
      : 'VcXsrv not installed — required for X11 forwarding';
  const label = running
    ? `X:${status.running_displays[0]}`
    : status.installed
      ? 'X idle'
      : 'X off';
  return (
    <span
      className={`inline-flex items-center gap-1 ${tone}`}
      title={title}
    >
      <Monitor size={11} />
      <span className="tabular-nums">{label}</span>
    </span>
  );
}
