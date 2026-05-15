'use client';
import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Eye, EyeOff, KeyRound, Lock, ShieldCheck, Trash2 } from 'lucide-react';
import { api, errMessage } from '@/lib/tauri';
import { scorePassword, STRENGTH_COPY, STRENGTH_BAR } from '@/lib/password-strength';
import type { VaultStatus } from '@/lib/types';
import { RecoveryUnlockDialog } from './recovery-unlock-dialog';
import { ResetVaultDialog } from './reset-vault-dialog';

interface Props {
  status: Exclude<VaultStatus, 'unlocked'>;
  onUnlocked: () => void;
  /// Bumped after a destructive vault_reset so the parent re-fetches
  /// status and we transition from 'locked' → 'uninitialized'.
  onStatusChanged?: () => void;
}

export function UnlockScreen({ status, onUnlocked, onStatusChanged }: Props) {
  const firstRun = status === 'uninitialized';
  const [pw, setPw]   = useState('');
  const [pw2, setPw2] = useState('');
  const [show, setShow] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [resetOpen, setResetOpen]       = useState(false);
  const [recoveryAvailable, setRecoveryAvailable] = useState(false);

  // Probe whether the locked vault has a recovery code provisioned so
  // we only show the "Use recovery code" link when it'd actually work.
  // Skipped on first-run (no vault yet) and any other status.
  useEffect(() => {
    if (status !== 'locked') return;
    let cancelled = false;
    api.vaultRecoveryStatus()
      .then((s) => { if (!cancelled) setRecoveryAvailable(s.provisioned); })
      .catch(() => { if (!cancelled) setRecoveryAvailable(false); });
    return () => { cancelled = true; };
  }, [status]);

  const score = useMemo(() => scorePassword(pw), [pw]);

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
    <main className="h-full flex items-center justify-center bg-bg text-fg p-6">
      <form
        onSubmit={submit}
        className="w-[380px] max-w-full space-y-4 p-6 rounded-md bg-surface border border-border shadow-dialog dialog-in"
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-md bg-accent/15 flex items-center justify-center text-accent">
            {firstRun ? <ShieldCheck size={20} /> : <Lock size={20} />}
          </div>
          <div>
            <h1 className="text-base font-semibold leading-tight">
              {firstRun ? 'Set master password' : 'Unlock ezTerm'}
            </h1>
            <p className="text-xs text-muted mt-0.5">
              {firstRun
                ? 'Encrypts your vault. Cannot be recovered.'
                : 'Enter your master password.'}
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <div className="relative">
            <input
              type={show ? 'text' : 'password'}
              autoFocus
              aria-label="Master password"
              className="input pr-9"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              placeholder="Master password"
            />
            <button
              type="button"
              onClick={() => setShow((s) => !s)}
              aria-label={show ? 'Hide password' : 'Show password'}
              title={show ? 'Hide' : 'Show'}
              className="icon-btn absolute right-1 top-1/2 -translate-y-1/2 w-7 h-7"
            >
              {show ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
          </div>

          {firstRun && (
            <>
              <input
                type={show ? 'text' : 'password'}
                aria-label="Confirm master password"
                className="input"
                value={pw2}
                onChange={(e) => setPw2(e.target.value)}
                placeholder="Confirm password"
              />
              {pw && (
                <div className="space-y-1">
                  <div className="flex gap-1" aria-label={`Password strength: ${STRENGTH_COPY[score]}`}>
                    {[0, 1, 2, 3].map((i) => (
                      <span
                        key={i}
                        className={`h-1 flex-1 rounded-sm ${
                          i < score ? STRENGTH_BAR[score] : 'bg-surface2'
                        }`}
                      />
                    ))}
                  </div>
                  <div className="text-[11px] text-muted">{STRENGTH_COPY[score]}</div>
                </div>
              )}
            </>
          )}
        </div>

        {err && (
          <div
            role="alert"
            className="flex items-start gap-2 px-2 py-1.5 rounded border border-danger/50 bg-danger/10 text-danger text-xs"
          >
            <AlertCircle size={13} className="mt-0.5 shrink-0" />
            <span>{err}</span>
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          className="w-full bg-accent text-white rounded py-2 text-sm font-medium hover:brightness-110 disabled:opacity-50 focus-ring"
        >
          {firstRun ? 'Create vault' : 'Unlock'}
        </button>

        {!firstRun && (
          <div className="flex items-center justify-between text-[11px] text-muted pt-1">
            {recoveryAvailable ? (
              <button
                type="button"
                onClick={() => setRecoveryOpen(true)}
                className="inline-flex items-center gap-1 hover:text-fg focus-ring rounded px-1"
              >
                <KeyRound size={11} /> Use recovery code
              </button>
            ) : (
              <span />
            )}
            <button
              type="button"
              onClick={() => setResetOpen(true)}
              className="inline-flex items-center gap-1 hover:text-danger focus-ring rounded px-1"
            >
              <Trash2 size={11} /> Forgot password?
            </button>
          </div>
        )}
      </form>

      {recoveryOpen && (
        <RecoveryUnlockDialog
          onClose={() => setRecoveryOpen(false)}
          onUnlocked={onUnlocked}
        />
      )}
      {resetOpen && (
        <ResetVaultDialog
          onClose={() => setResetOpen(false)}
          onReset={() => {
            setResetOpen(false);
            onStatusChanged?.();
          }}
        />
      )}
    </main>
  );
}
