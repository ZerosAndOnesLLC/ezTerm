'use client';
import { useEffect, useRef, useState } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Trash2 } from 'lucide-react';
import { api, errMessage } from '@/lib/tauri';

interface Props {
  onClose: () => void;
  onReset: () => void;
}

const CONFIRM_WORD = 'DELETE';

/** Last-resort path when the user has lost both the master password
 *  and any recovery code. Wipes every encrypted blob from the DB and
 *  returns the app to first-run. Requires a typed "DELETE" confirm so
 *  this can't be triggered by an errant double-click. */
export function ResetVaultDialog({ onClose, onReset }: Props) {
  const [typed, setTyped] = useState('');
  const [err, setErr]     = useState<string | null>(null);
  const [busy, setBusy]   = useState(false);
  const [done, setDone]   = useState<{ snapshot: string } | null>(null);
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
    if (typed !== CONFIRM_WORD) {
      setErr(`Type ${CONFIRM_WORD} to confirm`);
      return;
    }
    setBusy(true);
    try {
      const res = await api.vaultReset();
      setDone({ snapshot: res.snapshot_path });
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <DialogShell title="Vault reset">
        <div className="p-4 flex gap-3">
          <div className="shrink-0 text-success"><CheckCircle2 size={22} /></div>
          <div className="min-w-0 flex-1 space-y-2 text-xs text-muted">
            <p>
              All vault-encrypted data has been removed. Your sessions list is still here,
              but each session has been detached from its credential.
            </p>
            <p>
              A snapshot of the vault before reset was saved to{' '}
              <code className="font-mono text-[11px] break-all bg-surface2/60 px-1 py-0.5 rounded">{done.snapshot}</code>.
              If you recover your master password, you can replace the active database
              with this file (close ezTerm first).
            </p>
          </div>
        </div>
        <div className="px-4 py-3 border-t border-border bg-surface2/30 flex justify-end">
          <button
            type="button"
            onClick={onReset}
            className="px-3 py-1.5 rounded text-sm font-medium bg-accent text-white hover:brightness-110 focus-ring"
          >
            Set a new master password
          </button>
        </div>
      </DialogShell>
    );
  }

  return (
    <DialogShell title="Reset vault">
      <form onSubmit={submit} className="p-4 space-y-3">
        <div className="flex items-start gap-2 px-3 py-2 rounded border border-danger/40 bg-danger/10 text-danger text-xs">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <div>
            This wipes every saved credential, sync passphrase, and the vault key itself.
            Sessions are kept but lose their saved auth.
            <strong> There is no undo</strong> &mdash; the only recoverable copy is the snapshot
            we will write to disk before the wipe.
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-[11px] text-muted">
            Type <span className="font-mono font-semibold text-fg">{CONFIRM_WORD}</span> to confirm
          </label>
          <input
            ref={inputRef}
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className="input font-mono"
            placeholder={CONFIRM_WORD}
            aria-label="Confirmation"
          />
        </div>

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
            disabled={busy || typed !== CONFIRM_WORD}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium bg-danger text-white hover:brightness-110 disabled:opacity-50 focus-ring"
          >
            <Trash2 size={13} />
            {busy ? 'Resetting…' : 'Reset vault'}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

function DialogShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4 overlay-in"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="w-[480px] max-w-full bg-surface border border-border rounded-md shadow-dialog overflow-hidden dialog-in">
        <div className="px-4 py-3 border-b border-border bg-surface2/30">
          <h2 className="font-semibold text-sm">{title}</h2>
        </div>
        {children}
      </div>
    </div>
  );
}
