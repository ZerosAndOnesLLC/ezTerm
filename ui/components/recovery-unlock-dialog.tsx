'use client';
import { useEffect, useRef, useState } from 'react';
import { AlertCircle, KeyRound } from 'lucide-react';
import { api, errMessage } from '@/lib/tauri';

interface Props {
  onClose:    () => void;
  /// Vault is unlocked on success — same callback the password-unlock
  /// path uses, so the parent transitions out of UnlockScreen.
  onUnlocked: () => void;
}

export function RecoveryUnlockDialog({ onClose, onUnlocked }: Props) {
  const [code, setCode] = useState('');
  const [err, setErr]   = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) { e.preventDefault(); onClose(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!code.trim()) { setErr('Enter your recovery code'); return; }
    setBusy(true);
    try {
      await api.vaultUnlockWithRecovery(code.trim());
      onUnlocked();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4 overlay-in"
      role="dialog"
      aria-modal="true"
      aria-label="Use recovery code"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div className="w-[460px] max-w-full bg-surface border border-border rounded-md shadow-dialog overflow-hidden dialog-in">
        <div className="px-4 py-3 border-b border-border bg-surface2/30 flex items-center gap-2">
          <KeyRound size={14} className="text-accent" />
          <h2 className="font-semibold text-sm">Use recovery code</h2>
        </div>

        <form onSubmit={submit} className="p-4 space-y-3">
          <p className="text-xs text-muted">
            Enter the 24-character recovery code you saved. Hyphens, spaces, and case are ignored.
          </p>

          <input
            ref={inputRef}
            type="text"
            inputMode="text"
            spellCheck={false}
            autoCapitalize="characters"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="input font-mono text-base tracking-wider text-center"
            placeholder="ABCD-EFGH-IJKL-MNOP-QRST-UVWX"
            aria-label="Recovery code"
          />

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
              disabled={busy}
              className="px-3 py-1.5 border border-border rounded text-sm hover:bg-surface2 focus-ring disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !code.trim()}
              className="px-3 py-1.5 rounded text-sm font-medium bg-accent text-white hover:brightness-110 disabled:opacity-50 focus-ring"
            >
              {busy ? 'Unlocking…' : 'Unlock'}
            </button>
          </div>

          <p className="text-[11px] text-warning">
            The recovery code is <strong>single-use</strong>: a successful unlock invalidates it.
            Set a new master password (or generate a fresh recovery code) right after.
          </p>
        </form>
      </div>
    </div>
  );
}
