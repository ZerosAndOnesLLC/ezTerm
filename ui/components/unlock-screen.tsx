'use client';
import { useState } from 'react';
import { api, errMessage } from '@/lib/tauri';
import type { VaultStatus } from '@/lib/types';

interface Props {
  status: Exclude<VaultStatus, 'unlocked'>;
  onUnlocked: () => void;
}

export function UnlockScreen({ status, onUnlocked }: Props) {
  const firstRun = status === 'uninitialized';
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (firstRun && pw !== pw2) { setErr('Passwords do not match'); return; }
    if (firstRun && pw.length < 8) { setErr('Minimum 8 characters'); return; }
    setBusy(true);
    try {
      if (firstRun) await api.vaultInit(pw);
      else          await api.vaultUnlock(pw);
      onUnlocked();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="h-full flex items-center justify-center bg-bg text-fg">
      <form onSubmit={submit} className="w-80 space-y-3 p-6 rounded-lg bg-surface border border-border">
        <h1 className="text-xl font-semibold">
          {firstRun ? 'Set master password' : 'Unlock ezTerm'}
        </h1>
        <p className="text-sm text-muted">
          {firstRun
            ? 'This password encrypts your saved credentials. It cannot be recovered.'
            : 'Enter your master password to unlock the credential vault.'}
        </p>
        <input
          type="password" autoFocus
          aria-label="Master password"
          className="w-full bg-surface2 border border-border rounded px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:border-accent"
          value={pw} onChange={e => setPw(e.target.value)}
          placeholder="Master password"
        />
        {firstRun && (
          <input
            type="password"
            aria-label="Confirm master password"
            className="w-full bg-surface2 border border-border rounded px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:border-accent"
            value={pw2} onChange={e => setPw2(e.target.value)}
            placeholder="Confirm password"
          />
        )}
        {err && <div role="alert" className="text-sm text-red-400">{err}</div>}
        <button
          type="submit" disabled={busy}
          className="w-full bg-accent text-white rounded py-2 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
        >
          {firstRun ? 'Create vault' : 'Unlock'}
        </button>
      </form>
    </main>
  );
}
