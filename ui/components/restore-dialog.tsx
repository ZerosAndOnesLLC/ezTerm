'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, Eye, EyeOff, Folder as FolderIcon, Key, KeyRound, Loader2,
  PackageCheck, Server, Shield, X,
} from 'lucide-react';
import { api, errMessage } from '@/lib/tauri';
import type {
  BackupPreview, BackupSelection, RestoreSummary,
} from '@/lib/types';

interface Props {
  filePath: string;
  onCancel: () => void;
  onDone:   (summary: RestoreSummary) => void;
}

type Step = 'passphrase' | 'select';

/** Restore flow:
 *   1. Prompt for the backup passphrase, call backup_preview.
 *   2. Show the decrypted tree with checkboxes per folder / session /
 *      credential / known-host.
 *   3. Import → backup_restore with the computed SelectionSpec.
 */
export function RestoreDialog({ filePath, onCancel, onDone }: Props) {
  const [step, setStep] = useState<Step>('passphrase');
  const [passphrase, setPassphrase] = useState('');
  const [show, setShow] = useState(false);
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Selection state — everything checked by default.
  const [selFolders, setSelFolders] = useState<Set<number>>(new Set());
  const [selSessions, setSelSessions] = useState<Set<number>>(new Set());
  const [selCreds, setSelCreds] = useState<Set<number>>(new Set());
  const [selHosts, setSelHosts] = useState<Set<string>>(new Set());
  const [includeSettings, setIncludeSettings] = useState(true);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) { e.preventDefault(); onCancel(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  async function loadPreview() {
    if (!passphrase) { setErr('Enter the backup passphrase'); return; }
    setErr(null); setBusy(true);
    try {
      const p = await api.backupPreview(filePath, passphrase);
      setPreview(p);
      setSelFolders(new Set(p.folders.map((f) => f.id)));
      setSelSessions(new Set(p.sessions.map((s) => s.id)));
      setSelCreds(new Set(p.credentials.map((c) => c.id)));
      setSelHosts(new Set(p.known_hosts.map((k) => hostKey(k.host, k.port))));
      setStep('select');
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleImport() {
    if (!preview) return;
    const sel: BackupSelection = {
      folder_ids:     Array.from(selFolders),
      session_ids:    Array.from(selSessions),
      credential_ids: Array.from(selCreds),
      known_hosts: preview.known_hosts
        .filter((k) => selHosts.has(hostKey(k.host, k.port)))
        .map((k) => [k.host, k.port] as [string, number]),
      include_settings: includeSettings,
    };
    setBusy(true); setErr(null);
    try {
      const summary = await api.backupRestore(filePath, passphrase, sel);
      onDone(summary);
    } catch (e) {
      setErr(errMessage(e));
      setBusy(false);
    }
  }

  const totalChecked = useMemo(() =>
    selFolders.size + selSessions.size + selCreds.size + selHosts.size + (includeSettings ? 1 : 0),
    [selFolders, selSessions, selCreds, selHosts, includeSettings]);

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4 overlay-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="restore-title"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}
    >
      <div className="w-[620px] max-w-full max-h-[90vh] flex flex-col bg-surface border border-border rounded-md shadow-dialog overflow-hidden dialog-in text-sm">
        <header className="px-5 py-3 border-b border-border flex items-center gap-3">
          <PackageCheck size={16} className="text-accent" />
          <div className="min-w-0 flex-1">
            <h2 id="restore-title" className="font-semibold">Restore from backup</h2>
            <div className="text-muted text-xs truncate font-mono">{filePath}</div>
          </div>
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

        {step === 'passphrase' && (
          <div className="p-5 space-y-4">
            <label className="block space-y-1">
              <span className="text-muted text-xs">Backup passphrase</span>
              <div className="relative">
                <input
                  type={show ? 'text' : 'password'}
                  className="input pr-9"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void loadPreview(); }}
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
                onClick={loadPreview}
                disabled={busy || !passphrase}
                className="px-4 py-1.5 bg-accent text-white rounded text-sm font-medium disabled:opacity-50 hover:brightness-110 focus-ring inline-flex items-center gap-1.5"
              >
                {busy && <Loader2 size={12} className="animate-spin" />}
                Unlock backup
              </button>
            </footer>
          </div>
        )}

        {step === 'select' && preview && (
          <>
            <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
              <div className="text-xs text-muted">
                Created <span className="font-mono">{preview.created_at}</span>
                {' '}· ezTerm <span className="font-mono">v{preview.app_version}</span>
              </div>

              <Section
                title={`Folders (${selFolders.size}/${preview.folders.length})`}
                icon={<FolderIcon size={13} className="text-muted" />}
                all={preview.folders.length > 0 && selFolders.size === preview.folders.length}
                onToggleAll={(v) => setSelFolders(v ? new Set(preview.folders.map((f) => f.id)) : new Set())}
                empty={preview.folders.length === 0}
              >
                {preview.folders.map((f) => (
                  <Row
                    key={f.id}
                    checked={selFolders.has(f.id)}
                    onChange={(v) => setSelFolders((cur) => toggle(cur, f.id, v))}
                    label={f.name}
                  />
                ))}
              </Section>

              <Section
                title={`Sessions (${selSessions.size}/${preview.sessions.length})`}
                icon={<Server size={13} className="text-muted" />}
                all={preview.sessions.length > 0 && selSessions.size === preview.sessions.length}
                onToggleAll={(v) => setSelSessions(v ? new Set(preview.sessions.map((s) => s.id)) : new Set())}
                empty={preview.sessions.length === 0}
              >
                {preview.sessions.map((s) => (
                  <Row
                    key={s.id}
                    checked={selSessions.has(s.id)}
                    onChange={(v) => setSelSessions((cur) => toggle(cur, s.id, v))}
                    label={`${s.name}`}
                    sub={`${s.session_kind} · ${s.username}@${s.host}${s.port !== 22 ? `:${s.port}` : ''}`}
                  />
                ))}
              </Section>

              <Section
                title={`Credentials (${selCreds.size}/${preview.credentials.length})`}
                icon={<KeyRound size={13} className="text-muted" />}
                all={preview.credentials.length > 0 && selCreds.size === preview.credentials.length}
                onToggleAll={(v) => setSelCreds(v ? new Set(preview.credentials.map((c) => c.id)) : new Set())}
                empty={preview.credentials.length === 0}
              >
                {preview.credentials.map((c) => (
                  <Row
                    key={c.id}
                    checked={selCreds.has(c.id)}
                    onChange={(v) => setSelCreds((cur) => toggle(cur, c.id, v))}
                    label={c.label}
                    sub={c.kind}
                  />
                ))}
              </Section>

              <Section
                title={`Known hosts (${selHosts.size}/${preview.known_hosts.length})`}
                icon={<Shield size={13} className="text-muted" />}
                all={preview.known_hosts.length > 0 && selHosts.size === preview.known_hosts.length}
                onToggleAll={(v) =>
                  setSelHosts(v
                    ? new Set(preview.known_hosts.map((k) => hostKey(k.host, k.port)))
                    : new Set())
                }
                empty={preview.known_hosts.length === 0}
              >
                {preview.known_hosts.map((k) => (
                  <Row
                    key={hostKey(k.host, k.port)}
                    checked={selHosts.has(hostKey(k.host, k.port))}
                    onChange={(v) => setSelHosts((cur) => toggleStr(cur, hostKey(k.host, k.port), v))}
                    label={`${k.host}:${k.port}`}
                    sub={k.fingerprint_sha256}
                  />
                ))}
              </Section>

              {preview.setting_count > 0 && (
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeSettings}
                    onChange={(e) => setIncludeSettings(e.target.checked)}
                    className="accent-accent"
                  />
                  <Key size={13} className="text-muted" />
                  <span>Apply {preview.setting_count} app setting{preview.setting_count === 1 ? '' : 's'}</span>
                </label>
              )}

              <p className="text-muted text-xs">
                Name collisions in folders, sessions, and credential labels are
                resolved by appending <span className="font-mono">(2)</span>,
                <span className="font-mono"> (3)</span>, … Known hosts upsert
                by <span className="font-mono">(host, port)</span> key.
              </p>

              {err && (
                <div role="alert" className="text-danger text-xs">
                  <AlertTriangle size={11} className="inline mr-1" />
                  {err}
                </div>
              )}
            </div>
            <footer className="px-5 py-3 border-t border-border bg-surface2/30 flex items-center justify-between gap-2">
              <span className="text-muted text-xs">{totalChecked} items selected</span>
              <div className="flex gap-2">
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
                  onClick={handleImport}
                  disabled={busy || totalChecked === 0}
                  className="px-4 py-1.5 bg-accent text-white rounded text-sm font-medium disabled:opacity-50 hover:brightness-110 focus-ring inline-flex items-center gap-1.5"
                >
                  {busy && <Loader2 size={12} className="animate-spin" />}
                  Import selected
                </button>
              </div>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

function Section({
  title, icon, all, onToggleAll, empty, children,
}: {
  title: string;
  icon: React.ReactNode;
  all: boolean;
  onToggleAll: (v: boolean) => void;
  empty: boolean;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-1.5">
        {icon}
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted flex-1">{title}</h3>
        {!empty && (
          <button
            type="button"
            onClick={() => onToggleAll(!all)}
            className="text-[11px] text-accent hover:underline"
          >
            {all ? 'None' : 'All'}
          </button>
        )}
      </div>
      {empty ? (
        <div className="text-muted text-xs italic">none in backup</div>
      ) : (
        <div className="space-y-0.5 max-h-40 overflow-y-auto">{children}</div>
      )}
    </section>
  );
}

function Row({
  checked, onChange, label, sub,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  sub?:   string;
}) {
  return (
    <label className="flex items-center gap-2 text-xs cursor-pointer px-1 py-0.5 rounded hover:bg-surface2/60">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-accent"
      />
      <span className="flex-1 truncate">{label}</span>
      {sub && <span className="text-muted font-mono truncate max-w-[220px]">{sub}</span>}
    </label>
  );
}

function hostKey(host: string, port: number): string {
  return `${host}:${port}`;
}

function toggle(cur: Set<number>, id: number, v: boolean): Set<number> {
  const next = new Set(cur);
  if (v) next.add(id); else next.delete(id);
  return next;
}

function toggleStr(cur: Set<string>, id: string, v: boolean): Set<string> {
  const next = new Set(cur);
  if (v) next.add(id); else next.delete(id);
  return next;
}
