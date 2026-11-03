'use client';
import { useEffect, useState } from 'react';
import { PlugZap, RefreshCw } from 'lucide-react';
import { MAX_RECONNECT_ATTEMPTS } from '@/lib/reconnect';

interface Props {
  attempt: number;
  /** Epoch ms the next attempt fires; `<= now` means one is in flight. */
  at: number;
  summary: string;
  /** Tick only while the tab is on screen. */
  active: boolean;
  onRetryNow: () => void;
  onCancel: () => void;
}

/** "Connection lost — reconnecting" overlay body. Owns its countdown tick
 *  so only this card re-renders once a second, not the whole terminal
 *  view; the tick stops once the countdown reaches zero or the tab is
 *  hidden. */
export function ReconnectCard({ attempt, at, summary, active, onRetryNow, onCancel }: Props) {
  const [now, setNow] = useState(() => Date.now());
  const waiting = at > now;

  useEffect(() => {
    if (!active) return;
    // Resync immediately (the card may have been hidden while time
    // passed), then tick until the attempt fires.
    const sync = () => setNow(Date.now());
    const first = window.setTimeout(sync, 0);
    if (at <= Date.now()) return () => window.clearTimeout(first);
    const id = window.setInterval(() => {
      sync();
      if (Date.now() >= at) window.clearInterval(id);
    }, 1000);
    return () => { window.clearTimeout(first); window.clearInterval(id); };
  }, [active, at]);

  return (
    <>
      <RefreshCw size={28} className="text-accent animate-spin mx-auto mb-2" />
      <div className="text-sm font-medium">Connection lost — reconnecting</div>
      <div className="text-muted text-xs mt-1">
        Attempt {attempt} of {MAX_RECONNECT_ATTEMPTS}
        {waiting ? ` · next try in ${Math.ceil((at - now) / 1000)}s` : ' · trying now…'}
      </div>
      <div className="text-muted text-xs mt-0.5 font-mono">{summary}</div>
      <div className="flex gap-2 justify-center mt-3">
        <button
          type="button"
          onClick={onRetryNow}
          disabled={!waiting}
          className="btn-primary focus-ring"
        >
          <PlugZap size={12} />
          Retry now
        </button>
        <button type="button" onClick={onCancel} className="btn-ghost focus-ring">
          Cancel
        </button>
      </div>
    </>
  );
}
