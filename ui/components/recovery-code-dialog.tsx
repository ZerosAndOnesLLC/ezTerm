'use client';
import { useEffect, useState } from 'react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import {
  AlertCircle, AlertTriangle, Copy, Eye, EyeOff, KeyRound, Loader2, RefreshCcw,
} from 'lucide-react';
import { api, errMessage } from '@/lib/tauri';

interface Props {
  onClose: () => void;
}

type Phase =
  | { kind: 'probing' }
  /** No existing wrap on file. User confirms with master password, no destructive warning. */
  | { kind: 'fresh' }
  /** A recovery code already exists. User must explicitly confirm regenerating will invalidate it. */
  | { kind: 'already-provisioned' }
  | { kind: 'verifying' }
  | { kind: 'shown'; code: string; snapshotPath: string | null }
  | { kind: 'error'; message: string };

/** Recovery-code workflow:
 *  1. On mount, probe `vault_recovery_status` so we know whether
 *     we're creating fresh or replacing an existing wrap. We do NOT
 *     auto-call `vault_generate_recovery_code` — that would silently
 *     overwrite a prior code the user already saved.
 *  2. User must enter the master password to re-authenticate (so a
 *     momentary unattended-laptop scenario can't provision a backdoor).
 *  3. When replacing, an explicit "I understand the old code stops
 *     working" checkbox is required.
 *  4. Only after both gates pass do we hit the server, which takes a
 *     snapshot of the prior wrap before overwriting. */
export function RecoveryCodeDialog({ onClose }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: 'probing' });
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [understand, setUnderstand] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.vaultRecoveryStatus()
      .then((s) => {
        if (cancelled) return;
        setPhase({ kind: s.provisioned ? 'already-provisioned' : 'fresh' });
      })
      .catch((e) => {
        if (!cancelled) setPhase({ kind: 'error', message: errMessage(e) });
      });
    return () => { cancelled = true; };
  }, []);

  // Escape closes the dialog except in the 'shown' phase — losing a
  // freshly-generated code to a reflexive keypress would be a
  // single-event-permanent-data-loss disaster.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (phase.kind === 'verifying' || phase.kind === 'shown') {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase.kind, onClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!password) { setErr('Enter your master password'); return; }
    if (phase.kind === 'already-provisioned' && !understand) {
      setErr('Confirm you understand the existing recovery code will stop working');
      return;
    }
    setPhase({ kind: 'verifying' });
    try {
      const res = await api.vaultGenerateRecoveryCode(password);
      setPassword('');
      setPhase({ kind: 'shown', code: res.code, snapshotPath: res.snapshot_path });
    } catch (e) {
      setErr(errMessage(e));
      setPhase((cur) =>
        cur.kind === 'verifying'
          ? { kind: understand ? 'already-provisioned' : 'already-provisioned' }
          : cur,
      );
    }
  }

  async function copy() {
    if (phase.kind !== 'shown') return;
    try {
      await writeText(phase.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Best-effort: user can still write the code by hand.
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4 overlay-in"
      role="dialog"
      aria-modal="true"
      aria-label="Recovery code"
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (phase.kind === 'verifying' || phase.kind === 'shown') return;
        onClose();
      }}
    >
      <div className="w-[520px] max-w-full bg-surface border border-border rounded-md shadow-dialog overflow-hidden dialog-in">
        <div className="px-4 py-3 border-b border-border bg-surface2/30 flex items-center gap-2">
          <KeyRound size={14} className="text-accent" />
          <h2 className="font-semibold text-sm">Recovery code</h2>
        </div>

        {phase.kind === 'probing' && (
          <div className="h-28 flex items-center justify-center text-muted">
            <Loader2 size={18} className="animate-spin mr-2" /> Checking…
          </div>
        )}

        {phase.kind === 'error' && (
          <div className="p-4 text-danger text-xs">{phase.message}</div>
        )}

        {(phase.kind === 'fresh' || phase.kind === 'already-provisioned' || phase.kind === 'verifying') && (
          <form onSubmit={submit} className="p-4 space-y-3">
            {phase.kind === 'already-provisioned' || (phase.kind === 'verifying') ? (
              <div className="flex items-start gap-2 px-3 py-2 rounded border border-warning/40 bg-warning/10 text-warning text-xs">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                <div>
                  A recovery code already exists. Generating a new one will <strong>invalidate</strong> the old one.
                  A snapshot of the current vault will be saved before the change.
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted">
                The recovery code lets you unlock the vault if you forget your master password.
                You will see it exactly once. Save it somewhere safe.
              </p>
            )}

            <div className="space-y-1">
              <label className="text-[11px] text-muted">Confirm with master password</label>
              <div className="relative">
                <input
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="input pr-9"
                  autoFocus
                  autoComplete="current-password"
                  disabled={phase.kind === 'verifying'}
                />
                <button
                  type="button"
                  onClick={() => setShowPw((s) => !s)}
                  aria-label={showPw ? 'Hide password' : 'Show password'}
                  title={showPw ? 'Hide' : 'Show'}
                  className="icon-btn absolute right-1 top-1/2 -translate-y-1/2 w-7 h-7"
                >
                  {showPw ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </div>
            </div>

            {phase.kind === 'already-provisioned' && (
              <label className="flex items-start gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={understand}
                  onChange={(e) => setUnderstand(e.target.checked)}
                />
                <span>
                  I understand the existing recovery code will stop working as soon as the new one is generated.
                </span>
              </label>
            )}

            {err && (
              <div role="alert" className="flex items-start gap-2 px-2 py-1.5 rounded border border-danger/50 bg-danger/10 text-danger text-xs">
                <AlertCircle size={13} className="mt-0.5 shrink-0" />
                <span>{err}</span>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={phase.kind === 'verifying'}
                className="px-3 py-1.5 border border-border rounded text-sm hover:bg-surface2 focus-ring disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={
                  phase.kind === 'verifying'
                  || !password
                  || (phase.kind === 'already-provisioned' && !understand)
                }
                className="px-3 py-1.5 rounded text-sm font-medium bg-accent text-white hover:brightness-110 disabled:opacity-50 focus-ring"
              >
                {phase.kind === 'verifying' ? 'Generating…' : 'Generate code'}
              </button>
            </div>
          </form>
        )}

        {phase.kind === 'shown' && (
          <div className="p-4 space-y-3">
            <div className="flex items-start gap-2 px-3 py-2 rounded border border-warning/40 bg-warning/10 text-warning text-xs">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <div>
                Save this code somewhere safe (printout, password manager) now &mdash; we will <strong>never show it again</strong>.
                Using it to unlock the vault invalidates it, so plan to set a new master password right after.
              </div>
            </div>

            <div
              className="font-mono text-base tracking-wider text-center select-all bg-surface2/60 border border-border rounded p-3 break-all"
              aria-label="Recovery code"
            >
              {phase.code}
            </div>

            {phase.snapshotPath && (
              <p className="text-[11px] text-muted">
                A snapshot of the previous vault was saved to{' '}
                <code className="font-mono break-all">{phase.snapshotPath}</code>.
              </p>
            )}

            <div className="flex items-center justify-between gap-2 text-xs">
              <button
                type="button"
                onClick={copy}
                className="inline-flex items-center gap-1 px-2 py-1 border border-border rounded hover:bg-surface2 focus-ring"
              >
                <Copy size={12} />
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setPhase({ kind: 'already-provisioned' });
                  setUnderstand(false);
                  setPassword('');
                  setErr(null);
                }}
                className="inline-flex items-center gap-1 px-2 py-1 border border-border rounded hover:bg-surface2 focus-ring"
                title="Generate a different code (invalidates this one)"
              >
                <RefreshCcw size={12} />
                Regenerate
              </button>
            </div>

            <p className="text-[11px] text-muted">
              Hyphens are purely visual &mdash; you can type the code with or without them when unlocking.
            </p>

            <div className="flex justify-end pt-1">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 rounded text-sm font-medium bg-accent text-white hover:brightness-110 focus-ring"
              >
                I&apos;ve saved it
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
