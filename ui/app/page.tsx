'use client';
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { api } from '@/lib/tauri';
import type { VaultStatus } from '@/lib/types';
import { applyTheme, loadTheme } from '@/lib/theme';
import { UnlockScreen } from '@/components/unlock-screen';
import { MainShell } from '@/components/main-shell';

export default function Page() {
  const [status, setStatus] = useState<VaultStatus | null>(null);

  useEffect(() => {
    (async () => {
      applyTheme(await loadTheme());
      setStatus(await api.vaultStatus());
    })();
  }, []);

  // Ask Rust to close the splash and show the main window as soon as
  // React has mounted. We deliberately don't gate this on rAF: on
  // Linux/WebKitGTK, a window that starts `visible: false` has
  // `document.hidden === true`, and rAF callbacks don't run on hidden
  // documents — so the ui_ready invoke would never fire and the splash
  // would hang forever. Windows Edge WebView2 doesn't share that
  // behavior, which is why this only manifests on Linux. Rust enforces
  // a 2 s minimum visible duration on the splash, which gives React
  // plenty of time to finish its first render into the hidden main
  // window before the transition, so dropping rAF doesn't introduce a
  // blank flash on any platform.
  useEffect(() => {
    void invoke('ui_ready').catch(() => {});
  }, []);

  if (status === null)    return <main className="h-full flex items-center justify-center text-muted">Loading…</main>;
  if (status !== 'unlocked')
    return (
      <UnlockScreen
        status={status}
        onUnlocked={async () => setStatus(await api.vaultStatus())}
        onStatusChanged={async () => setStatus(await api.vaultStatus())}
      />
    );
  return <MainShell onLock={async () => { await api.vaultLock(); setStatus('locked'); }} />;
}
