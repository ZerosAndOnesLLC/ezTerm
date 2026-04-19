'use client';

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
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-40" role="dialog" aria-modal="true">
      <div className="w-[480px] bg-surface border border-border rounded p-4 space-y-3 text-sm">
        <h2 className="text-base font-semibold">
          {p.kind === 'untrusted' ? 'Trust host?' : 'Host key changed!'}
        </h2>
        <p className="text-muted">
          {p.kind === 'untrusted'
            ? `No previous record for ${p.host}:${p.port}. Verify the fingerprint out-of-band before trusting.`
            : `The host key for ${p.host}:${p.port} differs from the stored record. This may indicate interception — do NOT continue unless you know why.`}
        </p>
        {p.expectedFingerprint && (
          <div>
            <div className="text-xs text-muted">Expected SHA256</div>
            <div className="font-mono text-xs break-all">{p.expectedFingerprint}</div>
          </div>
        )}
        <div>
          <div className="text-xs text-muted">{p.expectedFingerprint ? 'Actual SHA256' : 'SHA256'}</div>
          <div className="font-mono text-xs break-all">{p.fingerprint}</div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={p.onCancel}
            className="px-3 py-1.5 border border-border rounded hover:bg-surface2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={p.onTrust}
            className={`px-3 py-1.5 rounded text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${p.kind === 'mismatch' ? 'bg-red-600 hover:bg-red-500' : 'bg-accent hover:brightness-110'}`}
          >
            {p.kind === 'mismatch' ? 'Replace and connect' : 'Trust and connect'}
          </button>
        </div>
      </div>
    </div>
  );
}
