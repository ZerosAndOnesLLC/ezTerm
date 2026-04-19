'use client';
import { useEffect, useState } from 'react';
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

  if (status === null)    return <main className="h-full flex items-center justify-center text-muted">Loading…</main>;
  if (status !== 'unlocked')
    return <UnlockScreen status={status} onUnlocked={async () => setStatus(await api.vaultStatus())} />;
  return <MainShell onLock={async () => { await api.vaultLock(); setStatus('locked'); }} />;
}
