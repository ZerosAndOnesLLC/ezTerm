'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeftRight, Globe2, Pencil, Play, Plus, Server, Square, Trash2,
} from 'lucide-react';
import { api, subscribeForwardEvents } from '@/lib/tauri';
import type { Forward, ForwardKind, RuntimeForward } from '@/lib/types';
import type { Tab } from '@/lib/tabs-store';
import { toast } from '@/lib/toast';
import { forwardLabel } from '@/lib/forwards';
import { ForwardDialog } from './forward-dialog';

const KIND_TONE: Record<ForwardKind, string> = {
  local:   'text-blue-400',
  remote:  'text-amber-400',
  dynamic: 'text-emerald-400',
};

type RowStatus = 'idle' | 'running' | 'error';

function statusClasses(s: RowStatus): string {
  switch (s) {
    case 'running': return 'bg-success';
    case 'error':   return 'bg-danger';
    default:        return 'bg-muted/60';
  }
}

function rfStatus(rf: RuntimeForward | undefined): RowStatus {
  if (!rf) return 'idle';
  switch (rf.status.status) {
    case 'running': return 'running';
    case 'error':   return 'error';
    default:        return 'idle';
  }
}

export function ForwardsPane({ tab, isVisible }: { tab: Tab; isVisible: boolean }) {
  const sessionId    = tab.session.id;
  const connectionId = tab.connectionId;
  const [runtime, setRuntime]       = useState<RuntimeForward[]>([]);
  const [persistent, setPersistent] = useState<Forward[]>([]);
  const [dialog, setDialog] = useState<
    | { kind: 'ephemeral-create' }
    | { kind: 'ephemeral-edit'; existing: RuntimeForward }
    | null
  >(null);

  useEffect(() => {
    api.forwardList(sessionId).then(setPersistent).catch(() => {});
  }, [sessionId]);

  useEffect(() => {
    if (connectionId == null) {
      setRuntime([]);
      return;
    }
    let cancelled = false;
    let unsub: (() => void) | undefined;
    api.forwardRuntimeList(connectionId)
      .then((list) => { if (!cancelled) setRuntime(list); })
      .catch(() => {});
    subscribeForwardEvents(connectionId, (rf) => {
      // Errors emitted from the runtime (bind, server reject,
      // auto-start scan failure) are async — the user isn't standing
      // at a command await. Surface them as a toast as well as in the
      // pane row so they don't get missed.
      if (rf.status.status === 'error') {
        toast.danger(`Forward failed — ${forwardLabel(rf.spec)}`, rf.status.message);
      }
      setRuntime((cur) => {
        const idx = cur.findIndex((x) => x.runtime_id === rf.runtime_id);
        if (rf.status.status === 'stopped') {
          // Drop persistent rows whose runtime stopped; keep ephemeral
          // rows only if status changed (they're managed by user).
          return rf.persistent_id != null
            ? cur.filter((x) => x.runtime_id !== rf.runtime_id)
            : (idx === -1 ? cur : (() => { const n = cur.slice(); n[idx] = rf; return n; })());
        }
        if (idx === -1) return [...cur, rf];
        const next = cur.slice();
        next[idx] = rf;
        return next;
      });
    }).then((u) => {
      // If the effect already cleaned up while we were awaiting the
      // listener registration, unsubscribe immediately so we don't
      // leak a dangling listener attached to a stale connectionId.
      if (cancelled) u();
      else unsub = u;
    });
    return () => { cancelled = true; unsub?.(); };
  }, [connectionId]);

  async function startPersistent(id: number) {
    if (connectionId == null) return;
    try { await api.forwardStart(connectionId, { kind: 'persistent', id }); }
    catch (e) { toast.danger('Start failed', String((e as { message?: string })?.message ?? e)); }
  }
  async function stop(runtimeId: number) {
    if (connectionId == null) return;
    try { await api.forwardStop(connectionId, runtimeId); }
    catch (e) { toast.danger('Stop failed', String((e as { message?: string })?.message ?? e)); }
  }

  const { runtimeByPersistent, ephemeral } = useMemo(() => {
    const byP = new Map<number, RuntimeForward>();
    const eph: RuntimeForward[] = [];
    for (const rf of runtime) {
      if (rf.persistent_id != null) byP.set(rf.persistent_id, rf);
      else eph.push(rf);
    }
    return { runtimeByPersistent: byP, ephemeral: eph };
  }, [runtime]);
  const empty = persistent.length === 0 && ephemeral.length === 0;

  // 256px wide, like the SFTP pane's default footprint.
  return (
    <div
      className="h-full flex flex-col bg-surface border-r border-border"
      style={{ width: 280, display: isVisible ? 'flex' : 'none' }}
    >
      <div className="px-3 py-2 flex items-center justify-between border-b border-border">
        <div className="text-sm font-medium">Forwards</div>
        <button
          onClick={() => setDialog({ kind: 'ephemeral-create' })}
          disabled={connectionId == null}
          title={connectionId == null ? 'Connect first to add a forward' : 'Add forward to this tab'}
          className="btn-ghost text-xs"
        >
          <Plus size={12} className="inline mr-0.5" /> Add
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        {empty && (
          <div className="p-4 text-sm text-muted">
            No forwards yet. Add one to tunnel a port through this session.
          </div>
        )}

        {persistent.map((p) => {
          const rt = runtimeByPersistent.get(p.id);
          const isRunning = rt?.status.status === 'running';
          const tone = rfStatus(rt);
          const lastError = rt?.status.status === 'error' ? rt.status.message : null;
          const label = forwardLabel(p);
          return (
            <Row key={`p-${p.id}`} kind={p.kind} label={label}
                 tone={tone} lastError={lastError}
                 actions={
                   <>
                     {isRunning
                       ? <IconBtn title="Stop"  onClick={() => stop(rt!.runtime_id)}><Square size={12}/></IconBtn>
                       : <IconBtn
                           title={connectionId == null ? 'Connect first to start' : 'Start'}
                           disabled={connectionId == null}
                           onClick={() => startPersistent(p.id)}>
                           <Play size={12}/>
                         </IconBtn>}
                     <IconBtn title="Delete"
                              onClick={async () => {
                                if (isRunning && connectionId != null) {
                                  await api.forwardStop(connectionId, rt!.runtime_id).catch(() => {});
                                }
                                await api.forwardDelete(p.id);
                                setPersistent((cur) => cur.filter((x) => x.id !== p.id));
                              }}>
                       <Trash2 size={12}/>
                     </IconBtn>
                   </>
                 } />
          );
        })}

        {ephemeral.map((rf) => (
          <Row key={`e-${rf.runtime_id}`}
               kind={rf.spec.kind}
               label={forwardLabel(rf.spec)}
               tone={rfStatus(rf)}
               lastError={rf.status.status === 'error' ? rf.status.message : null}
               actions={
                 <>
                   <IconBtn title="Edit"
                            onClick={() => setDialog({ kind: 'ephemeral-edit', existing: rf })}>
                     <Pencil size={12}/>
                   </IconBtn>
                   <IconBtn title="Stop" onClick={() => stop(rf.runtime_id)}>
                     <Square size={12}/>
                   </IconBtn>
                 </>
               } />
        ))}
      </div>

      {dialog?.kind === 'ephemeral-create' && connectionId != null && (
        <ForwardDialog mode="ephemeral-create" connectionId={connectionId}
                       onClose={() => setDialog(null)}
                       onSaved={() => setDialog(null)} />
      )}
      {dialog?.kind === 'ephemeral-edit' && connectionId != null && (
        <ForwardDialog mode="ephemeral-edit" connectionId={connectionId}
                       existing={dialog.existing}
                       onClose={() => setDialog(null)}
                       onSaved={() => setDialog(null)} />
      )}
    </div>
  );
}

function Row({ kind, label, tone, lastError, actions }: {
  kind: ForwardKind; label: string; tone: RowStatus;
  lastError: string | null; actions: React.ReactNode;
}) {
  const KindIcon = kind === 'local' ? ArrowLeftRight : kind === 'remote' ? Server : Globe2;
  return (
    <div className="px-3 py-2 border-b border-border hover:bg-surface2">
      <div className="flex items-center gap-2 text-sm min-w-0">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusClasses(tone)}`} aria-hidden />
        <KindIcon size={12} className={`shrink-0 ${KIND_TONE[kind]}`} />
        <span className="truncate flex-1 font-mono text-xs">{label}</span>
        <span className="flex items-center gap-0.5 shrink-0">{actions}</span>
      </div>
      {lastError && <div className="text-xs text-danger pl-6 mt-0.5 break-words">{lastError}</div>}
    </div>
  );
}

function IconBtn({
  children, title, onClick, disabled,
}: {
  children: React.ReactNode; title: string; onClick: () => void; disabled?: boolean;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="p-1 rounded hover:bg-surface2 text-muted hover:text-fg disabled:opacity-40 disabled:cursor-not-allowed"
    >
      {children}
    </button>
  );
}
