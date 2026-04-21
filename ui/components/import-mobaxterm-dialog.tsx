'use client';
import { useEffect, useState } from 'react';
import { AlertTriangle, FolderPlus, Loader2, Upload, X } from 'lucide-react';
import { api, errMessage } from '@/lib/tauri';
import type {
  MobaDuplicateStrategy,
  MobaImportPreview,
  MobaImportResult,
} from '@/lib/types';

interface Props {
  filePath: string;
  onCancel: () => void;
  onDone:   (result: MobaImportResult) => void;
}

export function ImportMobaxtermDialog({ filePath, onCancel, onDone }: Props) {
  const [preview,  setPreview]  = useState<MobaImportPreview | null>(null);
  const [error,    setError]    = useState<string | null>(null);
  const [strategy, setStrategy] = useState<MobaDuplicateStrategy>('skip');
  const [busy,     setBusy]     = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.mobaxtermPreview(filePath)
      .then((p) => { if (!cancelled) setPreview(p); })
      .catch((e) => { if (!cancelled) setError(errMessage(e)); });
    return () => { cancelled = true; };
  }, [filePath]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) { e.preventDefault(); onCancel(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  async function runImport() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.mobaxtermCommit(preview.sessions, strategy);
      onDone(result);
    } catch (e) {
      setError(errMessage(e));
      setBusy(false);
    }
  }

  const dupCount = preview?.duplicate_indices.length ?? 0;
  const sessionCount = preview?.sessions.length ?? 0;
  const folderCount  = preview?.new_folder_paths.length ?? 0;
  const keyPaths = Array.from(new Set(
    preview?.sessions.map((s) => s.private_key_path).filter((p): p is string => !!p) ?? [],
  ));
  const canImport = !!preview && sessionCount > 0 && !busy;

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4 overlay-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-moba-title"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}
    >
      <div className="w-[620px] max-w-full max-h-[90vh] flex flex-col bg-surface border border-border rounded-md shadow-dialog overflow-hidden dialog-in text-sm">
        <header className="px-5 py-3 border-b border-border flex items-center gap-3">
          <Upload size={16} className="text-accent" />
          <div className="min-w-0 flex-1">
            <h2 id="import-moba-title" className="font-semibold">Import from MobaXterm</h2>
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

        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
          {!preview && !error && (
            <div className="flex items-center gap-2 text-muted">
              <Loader2 size={14} className="animate-spin" />
              <span>Reading session file…</span>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 p-3 rounded border border-danger/40 bg-danger/10 text-danger text-xs">
              <AlertTriangle size={14} className="shrink-0 mt-0.5" />
              <span className="break-words">{error}</span>
            </div>
          )}

          {preview && (
            <>
              <StatRow preview={preview} keyFileCount={keyPaths.length} />

              {folderCount > 0 && (
                <Section
                  icon={<FolderPlus size={14} className="text-muted" />}
                  title={`${folderCount} new folder${folderCount === 1 ? '' : 's'} will be created`}
                >
                  <ul className="text-xs font-mono text-muted space-y-0.5 max-h-32 overflow-y-auto">
                    {preview.new_folder_paths.map((p, i) => (
                      <li key={i} className="truncate">{p.join(' / ')}</li>
                    ))}
                  </ul>
                </Section>
              )}

              {dupCount > 0 && (
                <Section
                  icon={<AlertTriangle size={14} className="text-warning" />}
                  title={`${dupCount} duplicate${dupCount === 1 ? '' : 's'} detected`}
                >
                  <p className="text-xs text-muted">
                    A session with the same folder, name, host, port, and user already exists.
                  </p>
                  <fieldset className="mt-2 space-y-1.5" aria-label="Duplicate handling">
                    <StrategyOption
                      value="skip"
                      current={strategy}
                      onSelect={setStrategy}
                      label="Skip"
                      hint="Leave the existing session untouched."
                    />
                    <StrategyOption
                      value="overwrite"
                      current={strategy}
                      onSelect={setStrategy}
                      label="Overwrite"
                      hint="Refresh host / port / username / auth. Attached credentials are kept when the auth type matches, cleared when it changes. Terminal settings stay."
                    />
                    <StrategyOption
                      value="rename"
                      current={strategy}
                      onSelect={setStrategy}
                      label="Rename"
                      hint='Import as a new session named "<name> (imported)".'
                    />
                  </fieldset>
                </Section>
              )}

              {sessionCount > 0 && (
                <Section title={`${sessionCount} session${sessionCount === 1 ? '' : 's'} to import`}>
                  <ul className="text-xs font-mono space-y-0.5 max-h-40 overflow-y-auto">
                    {preview.sessions.slice(0, 200).map((s, i) => (
                      <li key={i} className="truncate text-muted">
                        <span className="text-fg">{s.name}</span>
                        <span className="mx-1 opacity-50">·</span>
                        <span>{s.username}@{s.host}{s.port !== 22 ? `:${s.port}` : ''}</span>
                        <span
                          className={`ml-2 px-1 rounded text-[10px] ${
                            s.auth_type === 'key'
                              ? 'bg-accent/20 text-accent'
                              : 'bg-warning/20 text-warning'
                          }`}
                        >
                          {s.auth_type}
                        </span>
                        {s.private_key_path && (
                          <span className="ml-1 opacity-80">{keyFileName(s.private_key_path)}</span>
                        )}
                        {s.folder_path.length > 0 && (
                          <span className="ml-2 opacity-60">{s.folder_path.join(' / ')}</span>
                        )}
                      </li>
                    ))}
                    {preview.sessions.length > 200 && (
                      <li className="text-muted italic">
                        … and {preview.sessions.length - 200} more
                      </li>
                    )}
                  </ul>
                </Section>
              )}

              {sessionCount === 0 && (
                <p className="text-muted text-xs">
                  No SSH sessions were found in this file. MobaXterm stores other session types
                  (RDP, VNC, Telnet, …) in the same file; only SSH rows are imported.
                </p>
              )}

              <p className="text-muted text-xs">
                Auth method comes from the source row. Referenced key files are read
                from disk and stored as encrypted <span className="font-mono">private_key</span>
                credentials in your vault, then attached to the matching sessions.
                Passwords aren&apos;t exported by MobaXterm, so password rows still land
                without a credential — edit each to pick one from the vault.
                Passphrase-protected keys: attach a <span className="font-mono">key_passphrase</span>
                credential in the session dialog to avoid per-connect prompts.
              </p>
            </>
          )}
        </div>

        <footer className="px-5 py-3 border-t border-border bg-surface2/30 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-1.5 border border-border rounded text-sm hover:bg-surface2 disabled:opacity-50 focus-ring"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={runImport}
            disabled={!canImport}
            className="px-4 py-1.5 bg-accent text-white rounded text-sm font-medium disabled:opacity-50 hover:brightness-110 focus-ring inline-flex items-center gap-1.5"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
            <span>Import</span>
          </button>
        </footer>
      </div>
    </div>
  );
}

function StatRow({
  preview,
  keyFileCount,
}: {
  preview: MobaImportPreview;
  keyFileCount: number;
}) {
  const cells: Array<{ label: string; value: number; tone?: 'muted' | 'warn' }> = [
    { label: 'Sessions',  value: preview.sessions.length },
    { label: 'New folders', value: preview.new_folder_paths.length, tone: 'muted' },
    { label: 'Key files',   value: keyFileCount, tone: 'muted' },
    { label: 'Duplicates',  value: preview.duplicate_indices.length, tone: preview.duplicate_indices.length ? 'warn' : 'muted' },
    { label: 'Skipped',     value: preview.skipped_non_ssh + preview.skipped_malformed, tone: preview.skipped_malformed ? 'warn' : 'muted' },
  ];
  return (
    <div className="grid grid-cols-5 gap-2">
      {cells.map((c) => (
        <div key={c.label} className="border border-border rounded p-2 bg-surface2/30">
          <div className={`text-lg font-semibold tabular-nums ${c.tone === 'warn' ? 'text-warning' : 'text-fg'}`}>
            {c.value}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-muted">{c.label}</div>
        </div>
      ))}
    </div>
  );
}

function keyFileName(rawPath: string): string {
  const parts = rawPath.split(/[\\/]/);
  return parts[parts.length - 1] || rawPath;
}

function Section({
  icon, title, children,
}: { icon?: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-1.5">
        {icon}
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">{title}</h3>
      </div>
      {children}
    </section>
  );
}

function StrategyOption({
  value, current, onSelect, label, hint,
}: {
  value: MobaDuplicateStrategy;
  current: MobaDuplicateStrategy;
  onSelect: (s: MobaDuplicateStrategy) => void;
  label: string;
  hint: string;
}) {
  const on = value === current;
  return (
    <label
      className={`flex items-start gap-2.5 p-2 rounded border cursor-pointer transition ${
        on ? 'border-accent bg-accent/10' : 'border-border hover:border-muted'
      }`}
    >
      <input
        type="radio"
        name="moba-duplicate-strategy"
        value={value}
        checked={on}
        onChange={() => onSelect(value)}
        className="mt-0.5 accent-accent"
      />
      <div className="min-w-0">
        <div className="font-medium text-sm">{label}</div>
        <div className="text-muted text-xs">{hint}</div>
      </div>
    </label>
  );
}
