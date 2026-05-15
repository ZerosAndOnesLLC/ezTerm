'use client';
import { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Eye, EyeOff, KeyRound } from 'lucide-react';
import { api, errMessage } from '@/lib/tauri';
import { scorePassword, STRENGTH_COPY, STRENGTH_BAR } from '@/lib/password-strength';

interface Props {
  onClose:   () => void;
  /// Vault is locked on success; caller should bounce the user back to
  /// the unlock screen so they re-enter the new password.
  onChanged: () => void;
}

export function ChangePasswordDialog({ onClose, onChanged }: Props) {
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ snapshot: string } | null>(null);

  const firstFieldRef = useRef<HTMLInputElement>(null);
  useEffect(() => { firstFieldRef.current?.focus(); }, []);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) { e.preventDefault(); onClose(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const score = useMemo(() => scorePassword(newPw), [newPw]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (newPw.length < 8) { setErr('New password must be at least 8 characters'); return; }
    if (newPw !== confirm) { setErr('New passwords do not match'); return; }
    if (oldPw === newPw) { setErr('New password must differ from old password'); return; }
    setBusy(true);
    try {
      const res = await api.vaultChangePassword(oldPw, newPw);
      setDone({ snapshot: res.snapshot_path });
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <DialogShell title="Master password changed" onClose={onChanged}>
        <div className="p-4 flex gap-3">
          <div className="shrink-0 text-success"><CheckCircle2 size={22} /></div>
          <div className="min-w-0 flex-1 space-y-2">
            <p className="text-xs text-muted">
              All credentials and sync passphrases were re-encrypted under the new key.
              The vault is now locked &mdash; unlock with your new password to continue.
            </p>
            <p className="text-xs text-muted">
              A snapshot of the previous vault was written to{' '}
              <code className="font-mono text-[11px] break-all bg-surface2/60 px-1 py-0.5 rounded">{done.snapshot}</code>.
              The five most-recent snapshots are kept; older ones are removed automatically.
            </p>
            <p className="text-xs text-warning">
              Any previously generated recovery code is now invalid &mdash; generate a new one after unlocking.
            </p>
          </div>
        </div>
        <div className="px-4 py-3 border-t border-border bg-surface2/30 flex justify-end">
          <button
            type="button"
            onClick={onChanged}
            className="px-3 py-1.5 rounded text-sm font-medium bg-accent text-white hover:brightness-110 focus-ring"
          >
            Unlock
          </button>
        </div>
      </DialogShell>
    );
  }

  return (
    <DialogShell title="Change master password" onClose={busy ? () => {} : onClose}>
      <form onSubmit={submit} className="p-4 space-y-3">
        <div className="flex items-center gap-2 text-xs text-muted">
          <KeyRound size={13} />
          Re-encrypts every credential and sync passphrase. A snapshot of the current vault is saved first.
        </div>

        <PasswordField
          ref={firstFieldRef}
          label="Current password"
          value={oldPw}
          onChange={setOldPw}
          show={show}
          onToggleShow={() => setShow((s) => !s)}
          autoComplete="current-password"
        />
        <PasswordField
          label="New password"
          value={newPw}
          onChange={setNewPw}
          show={show}
          autoComplete="new-password"
        />
        {newPw && (
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
        <PasswordField
          label="Confirm new password"
          value={confirm}
          onChange={setConfirm}
          show={show}
          autoComplete="new-password"
        />

        {err && (
          <div role="alert" className="flex items-start gap-2 px-2 py-1.5 rounded border border-danger/50 bg-danger/10 text-danger text-xs">
            <AlertCircle size={13} className="mt-0.5 shrink-0" />
            <span>{err}</span>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 border border-border rounded text-sm hover:bg-surface2 focus-ring disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !oldPw || !newPw || !confirm}
            className="px-3 py-1.5 rounded text-sm font-medium bg-accent text-white hover:brightness-110 disabled:opacity-50 focus-ring"
          >
            {busy ? 'Changing…' : 'Change password'}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

function DialogShell({
  title, children, onClose,
}: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4 overlay-in"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-[460px] max-w-full bg-surface border border-border rounded-md shadow-dialog overflow-hidden dialog-in">
        <div className="px-4 py-3 border-b border-border bg-surface2/30">
          <h2 className="font-semibold text-sm">{title}</h2>
        </div>
        {children}
      </div>
    </div>
  );
}

interface PasswordFieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  show: boolean;
  onToggleShow?: () => void;
  autoComplete?: string;
}

const PasswordField = forwardRef<HTMLInputElement, PasswordFieldProps>(
  ({ label, value, onChange, show, onToggleShow, autoComplete }, ref) => (
    <div className="space-y-1">
      <label className="text-[11px] text-muted">{label}</label>
      <div className="relative">
        <input
          ref={ref}
          type={show ? 'text' : 'password'}
          className="input pr-9"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
        />
        {onToggleShow && (
          <button
            type="button"
            onClick={onToggleShow}
            aria-label={show ? 'Hide password' : 'Show password'}
            title={show ? 'Hide' : 'Show'}
            className="icon-btn absolute right-1 top-1/2 -translate-y-1/2 w-7 h-7"
          >
            {show ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
        )}
      </div>
    </div>
  ),
);
PasswordField.displayName = 'PasswordField';
