'use client';
import { useEffect, useState } from 'react';
import {
  AlertTriangle, Check, Cloud, CloudOff, Eye, EyeOff, FolderOpen,
  Loader2, RefreshCw, Server, Download, X,
} from 'lucide-react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { api, errMessage } from '@/lib/tauri';
import type { S3ConfigInput, SyncKind, SyncStatus } from '@/lib/types';

interface Props {
  /** Parent (sessions-sidebar) owns the RestoreDialog — we hand back the
   *  temp-file path after a successful pull and it pops the dialog there. */
  onClose: () => void;
  onPullToRestore: (tempPath: string) => void;
}

/** Unified Cloud-sync dialog. Kind radio at top flips between local-folder
 *  (phase 1) and S3-compatible (phase 2). Phase 2 adds ETag-based
 *  optimistic conflict detection on push + a "Pull from cloud" button
 *  that downloads the remote bundle into the standard Restore flow. */
export function SyncDialog({ onClose, onPullToRestore }: Props) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [kind, setKind] = useState<SyncKind>('local');

  // Local folder form.
  const [path, setPath] = useState('');
  const [localPass, setLocalPass] = useState('');
  const [localPass2, setLocalPass2] = useState('');

  // S3 form.
  const [s3Endpoint, setS3Endpoint] = useState('');
  const [s3Region, setS3Region] = useState('auto');
  const [s3Bucket, setS3Bucket] = useState('');
  const [s3Prefix, setS3Prefix] = useState('');
  const [s3AccessKeyId, setS3AccessKeyId] = useState('');
  const [s3Secret, setS3Secret] = useState('');
  const [s3Pass, setS3Pass] = useState('');
  const [s3Pass2, setS3Pass2] = useState('');

  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function refresh() {
    try {
      const s = await api.syncStatus();
      setStatus(s);
      if (s.kind !== 'none') setKind(s.kind);
      if (s.local_path) setPath(s.local_path);
      if (s.s3_endpoint)      setS3Endpoint(s.s3_endpoint);
      if (s.s3_region)        setS3Region(s.s3_region);
      if (s.s3_bucket)        setS3Bucket(s.s3_bucket);
      if (s.s3_prefix)        setS3Prefix(s.s3_prefix);
      if (s.s3_access_key_id) setS3AccessKeyId(s.s3_access_key_id);
    } catch (e) {
      setErr(errMessage(e));
    }
  }

  useEffect(() => { void refresh(); }, []);

  useEffect(() => {
    // Polls are cheap — just a settings read — and keep the last-sync
    // timestamp fresh while the dialog stays open.
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

  async function saveLocal() {
    setErr(null); setMsg(null);
    if (!path.trim()) { setErr('Pick a folder first'); return; }
    if (localPass.length < 8) { setErr('Passphrase must be ≥ 8 characters'); return; }
    if (localPass !== localPass2) { setErr('Passphrases do not match'); return; }
    setBusy(true);
    try {
      await api.syncConfigureLocal(path.trim(), localPass);
      setLocalPass(''); setLocalPass2('');
      setMsg('Local-folder sync enabled. Initial push queued.');
      await refresh();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveS3() {
    setErr(null); setMsg(null);
    if (!s3Endpoint.trim())    { setErr('Endpoint required');       return; }
    if (!s3Bucket.trim())      { setErr('Bucket required');         return; }
    if (!s3AccessKeyId.trim()) { setErr('Access key ID required');  return; }
    if (!s3Secret)             { setErr('Secret access key required'); return; }
    if (s3Pass.length < 8)     { setErr('Passphrase must be ≥ 8 characters'); return; }
    if (s3Pass !== s3Pass2)    { setErr('Passphrases do not match'); return; }
    setBusy(true);
    try {
      const cfg: S3ConfigInput = {
        endpoint:          s3Endpoint.trim(),
        region:            s3Region.trim() || 'auto',
        bucket:            s3Bucket.trim(),
        prefix:            s3Prefix.trim(),
        access_key_id:     s3AccessKeyId.trim(),
        secret_access_key: s3Secret,
        passphrase:        s3Pass,
      };
      await api.syncConfigureS3(cfg);
      setS3Secret(''); setS3Pass(''); setS3Pass2('');
      setMsg('S3 sync enabled. Initial push queued.');
      await refresh();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setErr(null); setMsg(null); setBusy(true);
    try {
      await api.syncDisable();
      setMsg('Sync disabled.');
      setLocalPass(''); setLocalPass2(''); setS3Secret(''); setS3Pass(''); setS3Pass2('');
      await refresh();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function pushNow() {
    setErr(null); setMsg(null); setBusy(true);
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

  async function pullNow() {
    setErr(null); setMsg(null); setBusy(true);
    try {
      const tempPath = await api.syncPullToTemp();
      onClose();
      // Hand off to RestoreDialog — parent owns that component.
      onPullToRestore(tempPath);
    } catch (e) {
      setErr(errMessage(e));
      setBusy(false);
    }
  }

  const enabled = status && status.kind !== 'none';
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
      <div className="w-[620px] max-w-full max-h-[90vh] flex flex-col bg-surface border border-border rounded-md shadow-dialog overflow-hidden dialog-in text-sm">
        <header className="px-5 py-3 border-b border-border flex items-center gap-3">
          {enabled ? <Cloud size={16} className="text-accent" /> : <CloudOff size={16} className="text-muted" />}
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

        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
          <p className="text-muted text-xs">
            Encrypted backup syncs to one of two backends. Either way, the
            passphrase wraps the archive on-device — the sync service
            never sees plaintext.
          </p>

          {/* Kind picker */}
          <div>
            <div className="text-muted text-xs uppercase tracking-wider mb-1.5">Target</div>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Sync target">
              <KindOption
                value="local" current={kind} onSelect={setKind}
                Icon={FolderOpen} title="Local folder"
                hint="Dropbox / OneDrive / iCloud / Google Drive sync folder"
              />
              <KindOption
                value="s3" current={kind} onSelect={setKind}
                Icon={Server} title="S3-compatible"
                hint="AWS, Cloudflare R2, Backblaze B2, Wasabi, MinIO, …"
              />
            </div>
          </div>

          {/* Status strip — always present, reflects active target. */}
          {status && (
            <div className="border border-border rounded-sm bg-surface2/30 p-3 text-xs space-y-1 font-mono">
              <div className="flex items-center gap-2">
                <span className="text-muted">Status</span>
                {enabled ? (
                  <>
                    <Check size={12} className="text-success" />
                    <span>Enabled — {status.kind}</span>
                  </>
                ) : (
                  <span className="text-muted">Not configured</span>
                )}
              </div>
              {status.kind === 'local' && status.local_path && (
                <div><span className="text-muted">Path: </span>{status.local_path}</div>
              )}
              {status.kind === 's3' && status.s3_endpoint && (
                <>
                  <div><span className="text-muted">Bucket: </span>{status.s3_bucket}<span className="text-muted">@</span>{status.s3_endpoint}</div>
                  {status.s3_prefix && <div><span className="text-muted">Prefix: </span>{status.s3_prefix}</div>}
                  {status.s3_last_etag && <div><span className="text-muted">Last ETag: </span>{status.s3_last_etag}</div>}
                </>
              )}
              {enabled && (
                <div>
                  <span className="text-muted">Last sync: </span>{lastSync}
                  {status.pending && <span className="ml-2 text-accent">(writing…)</span>}
                </div>
              )}
              {status.last_error && (
                <div className="text-danger whitespace-pre-wrap break-all">
                  <span className="text-muted">Last error: </span>{status.last_error}
                </div>
              )}
            </div>
          )}

          {/* Local-folder form */}
          {kind === 'local' && (
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
                  <button type="button" onClick={pickFolder} className="btn-ghost focus-ring">
                    <FolderOpen size={12} /><span>Browse</span>
                  </button>
                </div>
              </label>

              <PassphraseFields
                label="Sync passphrase (≥ 8 chars — wraps the bundle; distinct from master password)"
                value={localPass}  onValue={setLocalPass}
                confirm={localPass2} onConfirm={setLocalPass2}
                show={show} onShow={setShow}
              />
            </div>
          )}

          {/* S3 form */}
          {kind === 's3' && (
            <div className="space-y-2">
              <label className="block space-y-1">
                <span className="text-muted text-xs">Endpoint URL</span>
                <input
                  value={s3Endpoint}
                  onChange={(e) => setS3Endpoint(e.target.value)}
                  placeholder="https://s3.us-east-005.backblazeb2.com"
                  className="input font-mono"
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block space-y-1">
                  <span className="text-muted text-xs">Bucket</span>
                  <input
                    value={s3Bucket}
                    onChange={(e) => setS3Bucket(e.target.value)}
                    placeholder="ezterm-sync"
                    className="input font-mono"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-muted text-xs">Region</span>
                  <input
                    value={s3Region}
                    onChange={(e) => setS3Region(e.target.value)}
                    placeholder="auto"
                    className="input font-mono"
                  />
                </label>
              </div>
              <label className="block space-y-1">
                <span className="text-muted text-xs">Key prefix (optional)</span>
                <input
                  value={s3Prefix}
                  onChange={(e) => setS3Prefix(e.target.value)}
                  placeholder="ezterm/"
                  className="input font-mono"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-muted text-xs">Access key ID</span>
                <input
                  value={s3AccessKeyId}
                  onChange={(e) => setS3AccessKeyId(e.target.value)}
                  className="input font-mono"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-muted text-xs">Secret access key</span>
                <div className="relative">
                  <input
                    type={show ? 'text' : 'password'}
                    className="input pr-9 font-mono"
                    value={s3Secret}
                    onChange={(e) => setS3Secret(e.target.value)}
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

              <PassphraseFields
                label="Sync passphrase (≥ 8 chars — wraps the bundle; distinct from master password)"
                value={s3Pass}  onValue={setS3Pass}
                confirm={s3Pass2} onConfirm={setS3Pass2}
                show={show} onShow={setShow}
              />

              <p className="text-muted text-xs">
                Saving tests connectivity by HEAD-ing the sync object —
                a bad endpoint or wrong secret fails here rather than
                later when the auto-pusher fires.
              </p>
            </div>
          )}

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
            {enabled && status?.kind === 's3' && (
              <button
                type="button"
                onClick={pullNow}
                disabled={busy}
                className="px-3 py-1.5 border border-border rounded text-sm hover:bg-surface2 disabled:opacity-50 focus-ring inline-flex items-center gap-1.5"
                title="Download the remote bundle and open the Restore dialog"
              >
                <Download size={12} /> Pull from cloud
              </button>
            )}
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
              onClick={kind === 'local' ? saveLocal : saveS3}
              disabled={busy}
              className="px-4 py-1.5 bg-accent text-white rounded text-sm font-medium disabled:opacity-50 hover:brightness-110 focus-ring inline-flex items-center gap-1.5"
            >
              {busy && <Loader2 size={12} className="animate-spin" />}
              {enabled && status?.kind === kind ? 'Update & push' : 'Enable sync'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function KindOption({
  value, current, onSelect, title, hint, Icon,
}: {
  value:   SyncKind;
  current: SyncKind;
  onSelect: (k: SyncKind) => void;
  title:   string;
  hint:    string;
  Icon:    typeof Server;
}) {
  const on = value === current;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={() => onSelect(value)}
      className={`flex flex-col items-start gap-1 text-left p-3 rounded border transition ${
        on ? 'border-accent bg-accent/10 text-fg' : 'border-border hover:border-muted text-muted hover:text-fg'
      }`}
    >
      <Icon size={14} className={on ? 'text-accent' : ''} />
      <div className="font-medium text-sm">{title}</div>
      <div className="text-[11px] text-muted">{hint}</div>
    </button>
  );
}

function PassphraseFields({
  label, value, onValue, confirm, onConfirm, show, onShow,
}: {
  label:    string;
  value:    string;
  onValue:  (v: string) => void;
  confirm:  string;
  onConfirm: (v: string) => void;
  show:     boolean;
  onShow:   (v: boolean) => void;
}) {
  return (
    <>
      <label className="block space-y-1">
        <span className="text-muted text-xs">{label}</span>
        <div className="relative">
          <input
            type={show ? 'text' : 'password'}
            className="input pr-9"
            value={value}
            onChange={(e) => onValue(e.target.value)}
          />
          <button
            type="button"
            onClick={() => onShow(!show)}
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
          onChange={(e) => onConfirm(e.target.value)}
        />
      </label>
    </>
  );
}
