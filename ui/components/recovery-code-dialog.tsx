'use client';
import { useEffect, useState } from 'react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { AlertTriangle, Copy, KeyRound, Loader2, RefreshCcw } from 'lucide-react';
import { api, errMessage } from '@/lib/tauri';

interface Props {
  onClose: () => void;
}

/** Generates a new recovery code (invalidating any prior code) and
 *  shows it to the user exactly once. The component takes the
 *  destructive action — calling `vault_generate_recovery_code` — on
 *  mount, because there is no preview state worth presenting first:
 *  the user opened this dialog because they want a code, and showing
 *  a "click to generate" button would just be a redundant step. */
export function RecoveryCodeDialog({ onClose }: Props) {
  const [state, setState] = useState<
    | { phase: 'generating' }
    | { phase: 'shown'; code: string }
    | { phase: 'error'; message: string }
  >({ phase: 'generating' });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const code = await api.vaultGenerateRecoveryCode();
        if (!cancelled) setState({ phase: 'shown', code });
      } catch (e) {
        if (!cancelled) setState({ phase: 'error', message: errMessage(e) });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function copy() {
    if (state.phase !== 'shown') return;
    try {
      await writeText(state.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard plugin failure shouldn't tear the dialog down — the
      // user can still write the code by hand. We silently ignore.
    }
  }

  function regenerate() {
    setState({ phase: 'generating' });
    api.vaultGenerateRecoveryCode()
      .then((code) => setState({ phase: 'shown', code }))
      .catch((e) => setState({ phase: 'error', message: errMessage(e) }));
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4 overlay-in"
      role="dialog"
      aria-modal="true"
      aria-label="Recovery code"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-[520px] max-w-full bg-surface border border-border rounded-md shadow-dialog overflow-hidden dialog-in">
        <div className="px-4 py-3 border-b border-border bg-surface2/30 flex items-center gap-2">
          <KeyRound size={14} className="text-accent" />
          <h2 className="font-semibold text-sm">Recovery code</h2>
        </div>

        <div className="p-4 space-y-3">
          <div className="flex items-start gap-2 px-3 py-2 rounded border border-warning/40 bg-warning/10 text-warning text-xs">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <div>
              Save this code somewhere safe (printout, password manager). It is the only way to unlock the vault if you forget your master password.
              We will <strong>never show it again</strong>.
            </div>
          </div>

          {state.phase === 'generating' && (
            <div className="h-20 flex items-center justify-center text-muted">
              <Loader2 size={18} className="animate-spin mr-2" /> Generating…
            </div>
          )}
          {state.phase === 'error' && (
            <div className="text-danger text-xs">{state.message}</div>
          )}
          {state.phase === 'shown' && (
            <>
              <div
                className="font-mono text-base tracking-wider text-center select-all bg-surface2/60 border border-border rounded p-3 break-all"
                aria-label="Recovery code"
              >
                {state.code}
              </div>
              <div className="flex justify-end gap-2 text-xs">
                <button
                  type="button"
                  onClick={copy}
                  className="inline-flex items-center gap-1 px-2 py-1 border border-border rounded hover:bg-surface2 focus-ring"
                >
                  <Copy size={12} />
                  {copied ? 'Copied' : 'Copy'}
                </button>
                <button
                  type="button"
                  onClick={regenerate}
                  className="inline-flex items-center gap-1 px-2 py-1 border border-border rounded hover:bg-surface2 focus-ring"
                  title="Regenerate (invalidates the code above)"
                >
                  <RefreshCcw size={12} />
                  Regenerate
                </button>
              </div>
              <p className="text-[11px] text-muted">
                Hyphens are purely visual &mdash; you can type the code with or without them when unlocking.
              </p>
            </>
          )}
        </div>

        <div className="px-4 py-3 border-t border-border bg-surface2/30 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded text-sm font-medium bg-accent text-white hover:brightness-110 focus-ring"
          >
            I&apos;ve saved it
          </button>
        </div>
      </div>
    </div>
  );
}
