'use client';
import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, Download, Loader2, RefreshCw, Sparkles, X,
} from 'lucide-react';
import { type Update } from '@tauri-apps/plugin-updater';
import { checkForUpdate, downloadAndInstall, relaunch } from '@/lib/updater';
import { errMessage } from '@/lib/tauri';

interface Props {
  /** If provided, skip the initial check and start from "update-available".
   *  Used when the auto-check fired before the user opened the dialog. */
  initialUpdate?: Update | null;
  onClose: () => void;
}

type Phase =
  | { kind: 'checking' }
  | { kind: 'up-to-date' }
  | { kind: 'available'; update: Update }
  | { kind: 'downloading'; update: Update; downloaded: number; total: number | null }
  | { kind: 'installed'; update: Update }
  | { kind: 'error'; message: string };

export function UpdateDialog({ initialUpdate, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>(
    initialUpdate ? { kind: 'available', update: initialUpdate } : { kind: 'checking' },
  );
  const busy = phase.kind === 'checking' || phase.kind === 'downloading' || phase.kind === 'installed';
  const startedRef = useRef(false);

  useEffect(() => {
    // In strict mode mount→cleanup→mount, ensure we don't fire the
    // check twice — Tauri's updater HTTP is idempotent but the UX
    // flicker is avoidable.
    if (startedRef.current) return;
    startedRef.current = true;
    if (initialUpdate) return;
    (async () => {
      try {
        const u = await checkForUpdate();
        setPhase(u ? { kind: 'available', update: u } : { kind: 'up-to-date' });
      } catch (e) {
        setPhase({ kind: 'error', message: errMessage(e) });
      }
    })();
  }, [initialUpdate]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) { e.preventDefault(); onClose(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  async function install() {
    if (phase.kind !== 'available') return;
    const update = phase.update;
    setPhase({ kind: 'downloading', update, downloaded: 0, total: null });
    try {
      await downloadAndInstall(update, (downloaded, total) => {
        setPhase({ kind: 'downloading', update, downloaded, total });
      });
      setPhase({ kind: 'installed', update });
      // Brief pause so the user sees "installed" before the app restarts.
      setTimeout(() => { void relaunch(); }, 800);
    } catch (e) {
      setPhase({ kind: 'error', message: errMessage(e) });
    }
  }

  async function recheck() {
    setPhase({ kind: 'checking' });
    try {
      const u = await checkForUpdate();
      setPhase(u ? { kind: 'available', update: u } : { kind: 'up-to-date' });
    } catch (e) {
      setPhase({ kind: 'error', message: errMessage(e) });
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4 overlay-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="update-title"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div className="w-[520px] max-w-full max-h-[85vh] flex flex-col bg-surface border border-border rounded-md shadow-dialog overflow-hidden dialog-in text-sm">
        <header className="px-5 py-3 border-b border-border flex items-center gap-3">
          <Sparkles size={16} className="text-accent" />
          <h2 id="update-title" className="font-semibold flex-1">ezTerm updates</h2>
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

        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-3">
          {phase.kind === 'checking' && (
            <div className="flex items-center gap-2 text-muted">
              <Loader2 size={14} className="animate-spin" />
              <span>Checking GitHub for a newer release…</span>
            </div>
          )}

          {phase.kind === 'up-to-date' && (
            <div className="flex items-center gap-2 text-success">
              <CheckCircle2 size={16} />
              <span>You&rsquo;re on the latest version.</span>
            </div>
          )}

          {phase.kind === 'available' && (
            <>
              <div className="flex items-baseline gap-2">
                <span className="text-muted text-xs">Current</span>
                <span className="font-mono">{phase.update.currentVersion}</span>
                <span className="text-muted mx-1">→</span>
                <span className="text-muted text-xs">New</span>
                <span className="font-mono font-semibold text-accent">{phase.update.version}</span>
              </div>
              {phase.update.date && (
                <div className="text-muted text-xs">
                  Published {new Date(phase.update.date).toLocaleString()}
                </div>
              )}
              {phase.update.body && (
                <div>
                  <div className="text-muted text-xs mb-1 uppercase tracking-wider">Release notes</div>
                  <pre className="text-xs whitespace-pre-wrap bg-surface2/40 border border-border rounded p-3 max-h-60 overflow-auto">
                    {phase.update.body}
                  </pre>
                </div>
              )}
              <p className="text-muted text-xs">
                Installing will download the signed installer, verify it
                against the updater public key baked into this build, and
                relaunch ezTerm into the new version. Any open SSH / WSL
                sessions will be closed.
              </p>
            </>
          )}

          {phase.kind === 'downloading' && (
            <>
              <div className="flex items-center gap-2">
                <Download size={14} className="text-accent" />
                <span className="font-mono text-xs">{phase.update.version}</span>
                <span className="text-muted text-xs ml-auto">
                  {formatBytes(phase.downloaded)}
                  {phase.total != null && ` / ${formatBytes(phase.total)}`}
                </span>
              </div>
              <ProgressBar value={phase.downloaded} total={phase.total} />
              <div className="text-muted text-xs">Downloading and verifying signature…</div>
            </>
          )}

          {phase.kind === 'installed' && (
            <div className="flex items-center gap-2 text-success">
              <CheckCircle2 size={16} />
              <span>Installed v{phase.update.version}. Restarting ezTerm…</span>
            </div>
          )}

          {phase.kind === 'error' && (
            <div className="flex items-start gap-2 p-3 rounded border border-danger/40 bg-danger/10 text-danger text-xs">
              <AlertTriangle size={14} className="shrink-0 mt-0.5" />
              <span className="break-words">{phase.message}</span>
            </div>
          )}
        </div>

        <footer className="px-5 py-3 border-t border-border bg-surface2/30 flex justify-end gap-2">
          {(phase.kind === 'up-to-date' || phase.kind === 'error') && (
            <button
              type="button"
              onClick={recheck}
              className="px-3 py-1.5 border border-border rounded text-sm hover:bg-surface2 focus-ring inline-flex items-center gap-1.5"
            >
              <RefreshCw size={12} /> Check again
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 border border-border rounded text-sm hover:bg-surface2 disabled:opacity-50 focus-ring"
          >
            {phase.kind === 'available' ? 'Later' : 'Close'}
          </button>
          {phase.kind === 'available' && (
            <button
              type="button"
              onClick={install}
              className="px-4 py-1.5 bg-accent text-white rounded text-sm font-medium hover:brightness-110 focus-ring inline-flex items-center gap-1.5"
            >
              <Download size={12} /> Install &amp; restart
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

function ProgressBar({ value, total }: { value: number; total: number | null }) {
  const pct = total && total > 0 ? Math.min(100, Math.round((value / total) * 100)) : null;
  return (
    <div className="h-1.5 bg-surface2 rounded-sm overflow-hidden">
      <div
        className={`h-full bg-accent transition-all ${pct === null ? 'animate-pulse w-1/3' : ''}`}
        style={pct !== null ? { width: `${pct}%` } : undefined}
      />
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
