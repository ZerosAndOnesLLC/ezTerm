'use client';
import { useEffect, useState } from 'react';
import {
  AlertTriangle, Check, Cloud, CloudOff, Eye, EyeOff, FolderOpen, Loader2,
  RefreshCw, X,
} from 'lucide-react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { api, errMessage } from '@/lib/tauri';
import type { SyncStatus } from '@/lib/types';

interface Props {
  onClose: () => void;
}

/** Cloud-sync configuration dialog (phase 1 = local folder).
 *
 *  Point at a folder inside Dropbox / OneDrive / iCloud Drive / Google
 *  Drive for Desktop and ezTerm will push an encrypted backup there on
 *  every mutation, debounced ~3s. Phase 2 will add an S3 tab to the
 *  same dialog. */
export function SyncDialog({ onClose }: Props) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [path, setPath] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function refresh() {
    try {
      const s = await api.syncStatus();
      setStatus(s);
      if (s.kind === 'local' && s.local_path) setPath(s.local_path);
    } catch (e) {
      setErr(errMessage(e));
    }
  }

  useEffect(() => { void refresh(); }, []);

  useEffect(() => {
    // Poll lightly so the "Last sync" timestamp updates after a push
    // completes in the background without the user closing and reopening
    // the dialog.
    const h = setInterval(() => { void refresh(); }, 3000);
    return () => clearInterval(h);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) { e.preventDefault(); onClose(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  async function pickFolder() {
    try {
      const picked = await openDialog({
        multiple: false,
        directory: true,
        title: 'Sync folder (Dropbox / OneDrive / iCloud / …)',
      });
      if (typeof picked === 'string' && picked) setPath(picked);
    } catch (e) {
      setErr(errMessage(e));
    }
  }

  async function save() {
    setErr(null); setMsg(null);
    if (!path.trim()) { setErr('Pick a folder first'); return; }
    if (passphrase.length < 8) { setErr('Passphrase must be ≥ 8 characters'); return; }
    if (passphrase !== confirm) { setErr('Passphrases do not match'); return; }
    setBusy(true);
    try {
      await api.syncConfigureLocal(path.trim(), passphrase);
      setPassphrase(''); setConfirm('');
      setMsg('Sync enabled. Initial push queued.');
      await refresh();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setErr(null); setMsg(null);
    setBusy(true);
    try {
      await api.syncDisable();
      setMsg('Sync disabled.');
      setPassphrase(''); setConfirm('');
      await refresh();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function pushNow() {
    setErr(null); setMsg(null);
    setBusy(true);
    try {
      await api.syncPushNow();
      setMsg('Push queued — will write within a few seconds.');
      await refresh();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const enabled = status?.kind === 'local';
  const lastSync = status?.last_success_at
    ? new Date(status.last_success_at).toLocaleString()
    : '—';

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4 overlay-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sync-title"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div className="w-[560px] max-w-full bg-surface border border-border rounded-md shadow-dialog overflow-hidden dialog-in text-sm">
        <header className="px-5 py-3 border-b border-border flex items-center gap-3">
          {enabled ? (
            <Cloud size={16} className="text-accent" />
          ) : (
            <CloudOff size={16} className="text-muted" />
          )}
          <h2 id="sync-title" className="font-semibold flex-1">Cloud sync</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="icon-btn"
          >
            <X size={14} />
          </button>
        </header>

        <div className="p-5 space-y-4">
          <p className="text-muted text-xs">
            Sync your sessions + credentials to a folder — point this at a
            Dropbox, OneDrive, iCloud Drive or Google Drive synced folder
            and your vault follows you across devices. The file is
            encrypted under a passphrase of your choosing; the sync service
            never sees plaintext. S3-compatible direct-push will land in a
            later release.
          </p>

          {status && (
            <div className="border border-border rounded-sm bg-surface2/30 p-3 text-xs space-y-1 font-mono">
              <div className="flex items-center gap-2">
                <span className="text-muted">Status</span>
                {enabled ? (
                  <>
                    <Check size={12} className="text-success" />
                    <span>Enabled — local folder</span>
                  </>
                ) : (
                  <span className="text-muted">Not configured</span>
                )}
              </div>
              {enabled && (
                <>
                  <div><span className="text-muted">Path: </span>{status.local_path}</div>
                  <div>
                    <span className="text-muted">Last sync: </span>{lastSync}
                    {status.pending && (
                      <span className="ml-2 text-accent">(writing…)</span>
                    )}
                  </div>
                  {status.last_error && (
                    <div className="text-danger whitespace-pre-wrap break-all">
                      <span className="text-muted">Last error: </span>{status.last_error}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          <div className="space-y-2">
            <label className="block space-y-1">
              <span className="text-muted text-xs">Sync folder</span>
              <div className="flex gap-2">
                <input
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder={'C:\\Users\\you\\Dropbox\\ezterm'}
                  className="input flex-1 font-mono"
                />
                <button
                  type="button"
                  onClick={pickFolder}
                  className="btn-ghost focus-ring"
                >
                  <FolderOpen size={12} />
                  <span>Browse</span>
                </button>
              </div>
            </label>

            <label className="block space-y-1">
              <span className="text-muted text-xs">
                Sync passphrase (≥ 8 chars — wraps the encrypted bundle; separate from your master password)
              </span>
              <div className="relative">
                <input
                  type={show ? 'text' : 'password'}
                  className="input pr-9"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
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
              />
            </label>
          </div>

          {msg && (
            <div className="text-success text-xs flex items-center gap-1">
              <Check size={12} /> {msg}
            </div>
          )}
          {err && (
            <div role="alert" className="text-danger text-xs flex items-start gap-1">
              <AlertTriangle size={12} className="mt-0.5" /> {err}
            </div>
          )}
        </div>

        <footer className="px-5 py-3 border-t border-border bg-surface2/30 flex items-center justify-between gap-2">
          <div className="flex gap-2">
            {enabled && (
              <button
                type="button"
                onClick={disable}
                disabled={busy}
                className="px-3 py-1.5 border border-danger/40 text-danger rounded text-sm hover:bg-danger/10 focus-ring"
              >
                Disable
              </button>
            )}
          </div>
          <div className="flex gap-2">
            {enabled && (
              <button
                type="button"
                onClick={pushNow}
                disabled={busy}
                className="px-3 py-1.5 border border-border rounded text-sm hover:bg-surface2 disabled:opacity-50 focus-ring inline-flex items-center gap-1.5"
              >
                <RefreshCw size={12} className={busy ? 'animate-spin' : ''} />
                Push now
              </button>
            )}
            <button
              type="button"
              onClick={save}
              disabled={busy || !path || !passphrase || !confirm}
              className="px-4 py-1.5 bg-accent text-white rounded text-sm font-medium disabled:opacity-50 hover:brightness-110 focus-ring inline-flex items-center gap-1.5"
            >
              {busy && <Loader2 size={12} className="animate-spin" />}
              {enabled ? 'Update & push' : 'Enable sync'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
