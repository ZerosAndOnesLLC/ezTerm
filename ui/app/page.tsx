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

  // Once the app has rendered its first frame, ask Rust to close the
  // splash window and reveal the main window. rAF guarantees a paint
  // has happened, so the user sees either the unlock screen or
  // "Loading…" the instant the splash disappears (no blank flash).
  // Rust enforces a ~600 ms minimum visible duration on its side.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      void invoke('ui_ready').catch(() => {});
    });
    return () => cancelAnimationFrame(id);
  }, []);

  if (status === null)    return <main className="h-full flex items-center justify-center text-muted">Loading…</main>;
  if (status !== 'unlocked')
    return <UnlockScreen status={status} onUnlocked={async () => setStatus(await api.vaultStatus())} />;
  return <MainShell onLock={async () => { await api.vaultLock(); setStatus('locked'); }} />;
}
