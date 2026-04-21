'use client';
import { useMemo, useState } from 'react';
import { AlertCircle, Eye, EyeOff, Lock, ShieldCheck } from 'lucide-react';
import { api, errMessage } from '@/lib/tauri';
import type { VaultStatus } from '@/lib/types';

interface Props {
  status: Exclude<VaultStatus, 'unlocked'>;
  onUnlocked: () => void;
}

/// Simple strength heuristic: length weight + character-class diversity.
/// Returns 0..4. Not a replacement for zxcvbn, but enough to nudge users
/// away from "password" without pulling in another dep.
function scorePassword(pw: string): number {
  if (!pw) return 0;
  let score = 0;
  if (pw.length >= 8)  score++;
  if (pw.length >= 12) score++;
  if (pw.length >= 16) score++;
  const classes =
    Number(/[a-z]/.test(pw)) +
    Number(/[A-Z]/.test(pw)) +
    Number(/[0-9]/.test(pw)) +
    Number(/[^a-zA-Z0-9]/.test(pw));
  if (classes >= 3) score++;
  return Math.min(score, 4);
}

const STRENGTH_COPY = ['Too short', 'Weak', 'Fair', 'Strong', 'Very strong'];
const STRENGTH_BAR  = ['bg-danger', 'bg-danger', 'bg-warning', 'bg-success', 'bg-success'];

export function UnlockScreen({ status, onUnlocked }: Props) {
  const firstRun = status === 'uninitialized';
  const [pw, setPw]   = useState('');
  const [pw2, setPw2] = useState('');
  const [show, setShow] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      </form>
    </main>
  );
}
