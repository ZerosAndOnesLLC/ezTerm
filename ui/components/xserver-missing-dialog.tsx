'use client';
import { useEffect, useState } from 'react';
import { AlertTriangle, Download, Loader2, MonitorOff } from 'lucide-react';
import { api, errMessage } from '@/lib/tauri';

type Phase =
  | { kind: 'idle' }
  | { kind: 'installing' }
  | { kind: 'failed'; message: string };

interface Props {
  /** User clicked "Install VcXsrv". Runs the backend download + silent
   *  install and resolves when VcXsrv is available. Errors are surfaced
   *  in the dialog; the caller decides whether the connect retry succeeds. */
  onInstalled: () => void;
  /** User wants to proceed without X11. Caller disables the session's
   *  X11 flag and reconnects. */
  onContinueWithoutX11: () => void;
  /** User dismissed the dialog (tab closes / overlay hides). */
  onCancel: () => void;
}

export function XServerMissingDialog({ onInstalled, onContinueWithoutX11, onCancel }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && phase.kind !== 'installing') {
        e.preventDefault();
        onCancel();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, phase.kind]);

  async function runInstall() {
    setPhase({ kind: 'installing' });
    try {
      await api.xserverInstall();
      onInstalled();
    } catch (e) {
      setPhase({ kind: 'failed', message: errMessage(e) });
    }
  }

  const installing = phase.kind === 'installing';

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4 overlay-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="xserver-missing-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !installing) onCancel();
      }}
    >
      <div className="w-[460px] max-w-full bg-surface border border-border rounded-md shadow-dialog overflow-hidden dialog-in">
        <div className="p-4 flex gap-3">
          <div className="shrink-0 text-warning">
            <AlertTriangle size={22} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="xserver-missing-title" className="font-semibold text-sm">
              VcXsrv is required for X11 forwarding
            </h2>
            <p className="text-muted text-xs mt-1">
              This session has X11 forwarding enabled, but no VcXsrv install was
              found next to ezTerm, in your user data folder, or under
              <span className="font-mono mx-1">C:\Program Files\VcXsrv\</span>.
              You can install it now (roughly 3&nbsp;MB, no admin required) or
              connect without X11 for this session.
            </p>
            {phase.kind === 'failed' && (
              <p className="text-danger text-xs mt-2 break-words">
                Install failed: {phase.message}
              </p>
            )}
            {installing && (
              <p className="text-muted text-xs mt-2 inline-flex items-center gap-1.5">
                <Loader2 size={12} className="animate-spin" />
                Downloading and installing VcXsrv…
              </p>
            )}
          </div>
        </div>
        <div className="px-4 py-3 border-t border-border bg-surface2/30 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={installing}
            className="px-3 py-1.5 border border-border rounded text-sm hover:bg-surface2 focus-ring disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onContinueWithoutX11}
            disabled={installing}
            className="px-3 py-1.5 border border-border rounded text-sm hover:bg-surface2 focus-ring disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            <MonitorOff size={12} />
            Continue without X11
          </button>
          <button
            type="button"
            onClick={runInstall}
            disabled={installing}
            className="px-3 py-1.5 rounded text-sm font-medium bg-accent text-white hover:brightness-110 focus-ring disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {installing ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
            {phase.kind === 'failed' ? 'Retry install' : 'Install VcXsrv'}
          </button>
        </div>
      </div>
    </div>
  );
}
