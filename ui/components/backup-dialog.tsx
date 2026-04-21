'use client';
import { useEffect, useState } from 'react';
import { AlertTriangle, Eye, EyeOff, Loader2, Lock, PackageOpen, X } from 'lucide-react';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { api, errMessage } from '@/lib/tauri';
import type { BackupSummary } from '@/lib/types';

interface Props {
  onCancel: () => void;
  onDone:   (summary: BackupSummary) => void;
}

type Step = 'reauth' | 'passphrase';

/** Export flow:
 *   1. Master-password reauth (defeats unlocked-laptop walkup exfiltration).
 *   2. Backup passphrase + confirm (wraps the archive AEAD).
 *   3. Save-as dialog → backup_create command → close.
 */
export function BackupDialog({ onCancel, onDone }: Props) {
  const [step, setStep] = useState<Step>('reauth');
  const [masterPw, setMasterPw] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) { e.preventDefault(); onCancel(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  async function handleReauth() {
    if (!masterPw) { setErr('Enter your master password'); return; }
    setErr(null); setBusy(true);
    try {
      const ok = await api.vaultVerifyPassword(masterPw);
      if (!ok) { setErr('Incorrect master password'); return; }
      setStep('passphrase');
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleSave() {
    if (passphrase.length < 8) { setErr('Passphrase must be at least 8 characters'); return; }
    if (passphrase !== confirm) { setErr('Passphrases do not match'); return; }
    setErr(null);

    const today = new Date().toISOString().slice(0, 10);
    const defaultName = `ezterm-backup-${today}.json`;
    let path: string | null = null;
    try {
      path = await saveDialog({
        defaultPath: defaultName,
        title: 'Save encrypted ezTerm backup',
        filters: [{ name: 'ezTerm backup', extensions: ['json'] }],
      });
    } catch (e) {
      setErr(errMessage(e));
      return;
    }
    if (!path) return; // user cancelled the save dialog

    setBusy(true);
    try {
      const summary = await api.backupCreate(path, masterPw, passphrase);
      onDone(summary);
    } catch (e) {
      setErr(errMessage(e));
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4 overlay-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="backup-title"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}
    >
      <div className="w-[460px] max-w-full bg-surface border border-border rounded-md shadow-dialog overflow-hidden dialog-in text-sm">
        <header className="px-5 py-3 border-b border-border flex items-center gap-3">
          <PackageOpen size={16} className="text-accent" />
          <h2 id="backup-title" className="font-semibold flex-1">Export encrypted backup</h2>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            aria-label="Close"
            className="icon-btn"
          >
            <X size={14} />
          </button>
        </header>

        {step === 'reauth' && (
          <div className="p-5 space-y-4">
            <div className="flex items-start gap-2 p-3 rounded border border-warning/40 bg-warning/10 text-warning text-xs">
              <Lock size={14} className="shrink-0 mt-0.5" />
              <span>
                Re-enter your master password. Exporting decrypts every
                credential in memory — this gate blocks walk-up exfiltration
                from an unlocked session.
              </span>
            </div>
            <label className="block space-y-1">
              <span className="text-muted text-xs">Master password</span>
              <div className="relative">
                <input
                  type={show ? 'text' : 'password'}
                  className="input pr-9"
                  value={masterPw}
                  onChange={(e) => setMasterPw(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void handleReauth(); }}
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => setShow((s) => !s)}
                  aria-label={show ? 'Hide' : 'Show'}
                  className="icon-btn absolute right-1 top-1/2 -translate-y-1/2 w-7 h-7"
                >
                  {show ? <EyeOff size={12} /> : <Eye size={12} />}
                </button>
              </div>
            </label>
            {err && (
              <div role="alert" className="text-danger text-xs">
                <AlertTriangle size={11} className="inline mr-1" />
                {err}
              </div>
            )}
            <footer className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onCancel}
                disabled={busy}
                className="px-3 py-1.5 border border-border rounded text-sm hover:bg-surface2 focus-ring"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleReauth}
                disabled={busy || !masterPw}
                className="px-4 py-1.5 bg-accent text-white rounded text-sm font-medium disabled:opacity-50 hover:brightness-110 focus-ring inline-flex items-center gap-1.5"
              >
                {busy && <Loader2 size={12} className="animate-spin" />}
                Continue
              </button>
            </footer>
          </div>
        )}

        {step === 'passphrase' && (
          <div className="p-5 space-y-4">
            <p className="text-muted text-xs">
              The backup is wrapped under a <strong>separate</strong> passphrase
              (not your master password) so you can hand the file to someone
              else without sharing your vault password.
              <br /><br />
              <strong>If you forget this passphrase, the backup is unrecoverable.</strong>
            </p>
            <label className="block space-y-1">
              <span className="text-muted text-xs">Backup passphrase (≥ 8 chars)</span>
              <div className="relative">
                <input
                  type={show ? 'text' : 'password'}
                  className="input pr-9"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => setShow((s) => !s)}
                  aria-label={show ? 'Hide' : 'Show'}
                  className="icon-btn absolute right-1 top-1/2 -translate-y-1/2 w-7 h-7"
                >
                  {show ? <EyeOff size={12} /> : <Eye size={12} />}
                </button>
              </div>
            </label>
            <label className="block space-y-1">
              <span className="text-muted text-xs">Confirm passphrase</span>
              <input
                type={show ? 'text' : 'password'}
                className="input"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleSave(); }}
              />
            </label>
            {err && (
              <div role="alert" className="text-danger text-xs">
                <AlertTriangle size={11} className="inline mr-1" />
                {err}
              </div>
            )}
            <footer className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onCancel}
                disabled={busy}
                className="px-3 py-1.5 border border-border rounded text-sm hover:bg-surface2 focus-ring"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={busy || !passphrase || !confirm}
                className="px-4 py-1.5 bg-accent text-white rounded text-sm font-medium disabled:opacity-50 hover:brightness-110 focus-ring inline-flex items-center gap-1.5"
              >
                {busy && <Loader2 size={12} className="animate-spin" />}
                Save backup…
              </button>
            </footer>
          </div>
        )}
      </div>
    </div>
  );
}
