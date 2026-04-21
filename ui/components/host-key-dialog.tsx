'use client';
import { ShieldAlert, ShieldX } from 'lucide-react';

interface Props {
  host: string;
  port: number;
  kind: 'untrusted' | 'mismatch';
  fingerprint: string;             // for untrusted, the new key; for mismatch, the new key
  expectedFingerprint?: string;    // only set for mismatch
  onTrust: () => void;
  onCancel: () => void;
}

export function HostKeyDialog(p: Props) {
  const mismatch = p.kind === 'mismatch';
  const Icon = mismatch ? ShieldX : ShieldAlert;
  const iconColor = mismatch ? 'text-danger' : 'text-warning';
  const confirmCls = mismatch
    ? 'bg-danger text-white hover:brightness-110'
    : 'bg-accent text-white hover:brightness-110';

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-40 p-4 overlay-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="hostkey-title"
    >
      <div className="w-[520px] max-w-full bg-surface border border-border rounded-md shadow-dialog dialog-in overflow-hidden">
        <div className="p-4 flex gap-3">
          <div className={`shrink-0 ${iconColor}`}>
            <Icon size={28} />
          </div>
          <div className="min-w-0 flex-1 space-y-3">
            <h2 id="hostkey-title" className="text-base font-semibold">
              {mismatch ? 'Host key changed!' : 'Trust this host?'}
            </h2>
            <p className="text-muted text-xs">
              {mismatch
                ? `The host key for ${p.host}:${p.port} differs from the stored record. This may indicate interception — do NOT continue unless you know why.`
                : `No previous record for ${p.host}:${p.port}. Verify the fingerprint out-of-band before trusting.`}
            </p>
            {p.expectedFingerprint && (
              <div>
                <div className="text-[11px] uppercase tracking-wider text-muted font-medium">Expected SHA256</div>
                <div className="font-mono text-xs break-all mt-0.5 text-fg">{p.expectedFingerprint}</div>
              </div>
            )}
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted font-medium">
                {p.expectedFingerprint ? 'Actual SHA256' : 'SHA256'}
              </div>
              <div className="font-mono text-xs break-all mt-0.5 text-fg">{p.fingerprint}</div>
            </div>
          </div>
        </div>
        <div className="px-4 py-3 border-t border-border bg-surface2/30 flex justify-end gap-2">
          <button
            type="button"
            onClick={p.onCancel}
            className="px-3 py-1.5 border border-border rounded text-sm hover:bg-surface2 focus-ring"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={p.onTrust}
            className={`px-3 py-1.5 rounded text-sm font-medium focus-ring ${confirmCls}`}
          >
            {mismatch ? 'Replace and connect' : 'Trust and connect'}
          </button>
        </div>
      </div>
    </div>
  );
}
