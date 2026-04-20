'use client';
import { useEffect, useState } from 'react';
import { subscribeTransfer } from '@/lib/sftp';
import type { TransferProgress } from '@/lib/types';

export interface TrackedTransfer {
  transferId: number;
  label: string;      // e.g. "upload foo.log"
}

/// Bottom-of-pane progress strip. Subscribes to `sftp:transfer:{id}` events
/// for each tracked transfer. Done transfers disappear automatically. The
/// component does not trim the parent `tracked` array itself — the caller
/// owns that list; leaving stale entries around is harmless because a
/// finished transfer renders as nothing.
export function TransferStatus({ tracked }: { tracked: TrackedTransfer[] }) {
  const [states, setStates] = useState<Record<number, TransferProgress>>({});

  useEffect(() => {
    const unsubs: (() => void)[] = [];
    let cancelled = false;
    tracked.forEach(async (t) => {
      const u = await subscribeTransfer(t.transferId, (p) => {
        setStates((prev) => ({ ...prev, [t.transferId]: p }));
      });
      if (cancelled) u();
      else unsubs.push(u);
    });
    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
    };
  }, [tracked]);

  const active = tracked.filter((t) => !states[t.transferId]?.done);
  if (active.length === 0) return null;

  return (
    <div className="border-t border-border bg-surface text-xs p-2 space-y-1">
      {active.map((t) => {
        const p = states[t.transferId];
        const pct = p && p.total_bytes > 0 ? Math.floor((p.bytes_sent / p.total_bytes) * 100) : 0;
        return (
          <div key={t.transferId} className="flex items-center gap-2">
            <span className="flex-1 truncate">{t.label}</span>
            <span className="w-12 text-right text-muted tabular-nums">{p ? `${pct}%` : '…'}</span>
          </div>
        );
      })}
    </div>
  );
}
