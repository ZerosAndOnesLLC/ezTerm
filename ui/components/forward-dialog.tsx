'use client';
import { useState } from 'react';
import { ArrowLeftRight, Globe2, Server } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api } from '@/lib/tauri';
import { toast } from '@/lib/toast';
import type {
  Forward, ForwardInput, ForwardKind, ForwardSpec, RuntimeForward,
} from '@/lib/types';

type Mode =
  | { mode: 'persistent-create'; sessionId: number }
  | { mode: 'persistent-edit';   forward: Forward }
  | { mode: 'ephemeral-create';  connectionId: number }
  | { mode: 'ephemeral-edit';    connectionId: number; existing: RuntimeForward };

type Props = Mode & {
  onClose: () => void;
  onSaved: (result: Forward | RuntimeForward) => void;
};

const KIND_TILES: { value: ForwardKind; label: string; hint: string; Icon: LucideIcon }[] = [
  { value: 'local',   label: 'Local (-L)',   hint: 'localhost → remote target',  Icon: ArrowLeftRight },
  { value: 'remote',  label: 'Remote (-R)',  hint: 'remote bind → local target', Icon: Server },
  { value: 'dynamic', label: 'Dynamic (-D)', hint: 'local SOCKS5 proxy',              Icon: Globe2 },
];

function blank(): ForwardSpec & { auto_start: number } {
  return {
    name: '', kind: 'local',
    bind_addr: '127.0.0.1', bind_port: 0,
    dest_addr: '',          dest_port: 0,
    auto_start: 1,
  };
}

export function ForwardDialog(props: Props) {
  const initial: ForwardSpec & { auto_start: number } = (() => {
    if (props.mode === 'persistent-edit') {
      const f = props.forward;
      return {
        name: f.name, kind: f.kind,
        bind_addr: f.bind_addr, bind_port: f.bind_port,
        dest_addr: f.dest_addr, dest_port: f.dest_port,
        auto_start: f.auto_start,
      };
    }
    if (props.mode === 'ephemeral-edit') {
      return { ...props.existing.spec, auto_start: 0 };
    }
    return blank();
  })();

  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const isPersistent = props.mode === 'persistent-create' || props.mode === 'persistent-edit';
  const isDynamic    = v.kind === 'dynamic';
  const nonLoopback  = v.bind_addr.trim() !== '' &&
                       !['127.0.0.1', 'localhost', '::1'].includes(v.bind_addr.trim());
  const privileged   = v.bind_port > 0 && v.bind_port < 1024;

  async function submit() {
    setErr(null);
    if (!v.bind_addr.trim()) return setErr('Bind address is required');
    if (v.bind_port < 1 || v.bind_port > 65535) return setErr('Bind port must be 1–65535');
    if (!isDynamic) {
      if (!v.dest_addr.trim()) return setErr('Destination host is required');
      if (v.dest_port < 1 || v.dest_port > 65535) return setErr('Destination port must be 1–65535');
    }
    setBusy(true);
    try {
      if (isPersistent) {
        const input: ForwardInput = {
          name: v.name, kind: v.kind,
          bind_addr: v.bind_addr, bind_port: v.bind_port,
          dest_addr: isDynamic ? '' : v.dest_addr,
          dest_port: isDynamic ?  0 : v.dest_port,
          auto_start: v.auto_start,
        };
        const out = props.mode === 'persistent-create'
          ? await api.forwardCreate(props.sessionId, input)
          : await api.forwardUpdate(props.forward.id, input);
        props.onSaved(out);
        props.onClose();
      } else {
        const spec: ForwardSpec = {
          name: v.name, kind: v.kind,
          bind_addr: v.bind_addr, bind_port: v.bind_port,
          dest_addr: isDynamic ? '' : v.dest_addr,
          dest_port: isDynamic ?  0 : v.dest_port,
        };
        if (props.mode === 'ephemeral-edit') {
          await api.forwardStop(props.connectionId, props.existing.runtime_id).catch(() => {});
        }
        const rf = await api.forwardStart(props.connectionId, { kind: 'ephemeral', spec });
        props.onSaved(rf);
        props.onClose();
      }
    } catch (e) {
      const msg = String((e as { message?: string })?.message ?? e);
      setErr(msg);
      toast.danger('Forward save failed', msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40">
      <div className="bg-surface text-fg w-[560px] rounded shadow-lg border border-border">
        <div className="px-4 py-3 border-b border-border font-medium">
          {isPersistent ? 'Forward (session config)' : 'Forward (this tab)'}
        </div>
        <div className="p-4 space-y-3">
          <div className="grid grid-cols-3 gap-2">
            {KIND_TILES.map(({ value, label, hint, Icon }) => (
              <button key={value} type="button"
                onClick={() => setV({ ...v, kind: value })}
                className={`flex flex-col items-start gap-1 p-2 rounded border text-left ${
                  v.kind === value
                    ? 'border-accent bg-accent/10'
                    : 'border-border hover:border-muted text-muted hover:text-fg'
                }`}>
                <Icon size={14} />
                <div className="text-sm font-medium">{label}</div>
                <div className="text-xs text-muted">{hint}</div>
              </button>
            ))}
          </div>

          <label className="block">
            <span className="text-xs text-muted">Name (optional)</span>
            <input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })}
                   className="input mt-1" placeholder="e.g. Postgres dev" />
          </label>

          <div className="grid grid-cols-[1fr_120px] gap-2">
            <label className="block">
              <span className="text-xs text-muted">Bind address</span>
              <input value={v.bind_addr}
                     onChange={(e) => setV({ ...v, bind_addr: e.target.value })}
                     className="input font-mono mt-1" placeholder="127.0.0.1" />
            </label>
            <label className="block">
              <span className="text-xs text-muted">Bind port</span>
              <input type="number" min={1} max={65535} value={v.bind_port || ''}
                     onChange={(e) => setV({ ...v, bind_port: Number(e.target.value) })}
                     className="input mt-1" />
            </label>
          </div>
          {nonLoopback && (
            <div className="text-xs text-warning bg-warning/10 border border-warning/30 rounded px-2 py-1">
              This forward will be reachable from other machines on your network.
            </div>
          )}
          {privileged && (
            <div className="text-xs text-muted">
              Ports below 1024 require admin/root on most systems.
            </div>
          )}

          {!isDynamic && (
            <div className="grid grid-cols-[1fr_120px] gap-2">
              <label className="block">
                <span className="text-xs text-muted">Destination host</span>
                <input value={v.dest_addr}
                       onChange={(e) => setV({ ...v, dest_addr: e.target.value })}
                       className="input font-mono mt-1"
                       placeholder={v.kind === 'remote' ? 'localhost' : 'db.internal'} />
              </label>
              <label className="block">
                <span className="text-xs text-muted">Destination port</span>
                <input type="number" min={1} max={65535} value={v.dest_port || ''}
                       onChange={(e) => setV({ ...v, dest_port: Number(e.target.value) })}
                       className="input mt-1" />
              </label>
            </div>
          )}

          {isPersistent && (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={v.auto_start === 1}
                     onChange={(e) => setV({ ...v, auto_start: e.target.checked ? 1 : 0 })} />
              <span className="text-sm">Auto-start when the session connects</span>
            </label>
          )}

          {err && <div className="text-sm text-danger">{err}</div>}
        </div>
        <div className="px-4 py-3 border-t border-border flex justify-end gap-2">
          <button type="button" onClick={props.onClose} className="btn-ghost">Cancel</button>
          <button type="button" onClick={submit} disabled={busy} className="btn-primary">
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
