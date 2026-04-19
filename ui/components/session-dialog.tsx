'use client';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/tauri';
import type { AuthType, Folder, Session, SessionInput } from '@/lib/types';
import { CredentialPicker } from './credential-picker';

type Mode =
  | { mode: 'create'; folderId: number | null }
  | { mode: 'edit'; session: Session };

type Props = Mode & {
  folders: Folder[];
  onClose: () => void;
  onSaved: () => void;
};

// Implementation-notes §1: 6 swatches. Slate is the "no accent" option and
// stores null, so the picker has exactly 6 buttons — 5 real colors + slate/none.
const SWATCHES = [
  { value: '#60a5fa', label: 'Blue' },
  { value: '#34d399', label: 'Green' },
  { value: '#fbbf24', label: 'Amber' },
  { value: '#f87171', label: 'Red' },
  { value: '#a78bfa', label: 'Purple' },
  { value: null,      label: 'None', display: '#94a3b8' },
] as const;

export function SessionDialog(props: Props) {
  // Stable deps: only recompute when the identity of what we're editing changes.
  const editId  = props.mode === 'edit'   ? props.session.id : null;
  const newRoot = props.mode === 'create' ? props.folderId   : null;
  const initial: SessionInput = useMemo(() => {
    if (props.mode === 'edit') {
      const { id: _id, sort: _sort, ...rest } = props.session;
      void _id;
      void _sort;
      return rest;
    }
    return {
      folder_id: props.folderId,
      name: '',
      host: '',
      port: 22,
      username: '',
      auth_type: 'agent',
      credential_id: null,
      color: null,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId, newRoot, props.mode]);

  const [v, setV] = useState<SessionInput>(initial);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setV(initial);
  }, [initial]);

  const credKind =
    v.auth_type === 'password'
      ? ('password' as const)
      : v.auth_type === 'key'
        ? ('private_key' as const)
        : null;

  function validate(input: SessionInput): string | null {
    if (!input.name.trim()) return 'Name is required';
    if (!input.host.trim()) return 'Host is required';
    if (!input.username.trim()) return 'Username is required';
    if (!Number.isFinite(input.port) || input.port < 1 || input.port > 65535) {
      return 'Port must be between 1 and 65535';
    }
    if ((input.auth_type === 'password' || input.auth_type === 'key') && input.credential_id == null) {
      return 'Credential is required for this auth type';
    }
    return null;
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const problem = validate(v);
    if (problem) {
      setErr(problem);
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      if (props.mode === 'edit') {
        await api.sessionUpdate(props.session.id, v);
      } else {
        await api.sessionCreate(v);
      }
      props.onSaved();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-40"
      role="dialog"
      aria-modal="true"
      aria-label={props.mode === 'edit' ? 'Edit session' : 'New session'}
    >
      <form
        onSubmit={save}
        className="w-[480px] bg-surface border border-border rounded p-4 space-y-3 text-sm shadow-dialog"
      >
        <h2 className="text-base font-semibold">
          {props.mode === 'edit' ? 'Edit session' : 'New session'}
        </h2>
        <Field label="Name">
          <input
            value={v.name}
            onChange={(e) => setV({ ...v, name: e.target.value })}
            className="input"
            autoFocus
          />
        </Field>
        <Field label="Folder">
          <select
            value={v.folder_id ?? ''}
            onChange={(e) =>
              setV({ ...v, folder_id: e.target.value ? Number(e.target.value) : null })
            }
            className="input"
          >
            <option value="">(root)</option>
            {props.folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-[1fr_100px] gap-2">
          <Field label="Host">
            <input
              value={v.host}
              onChange={(e) => setV({ ...v, host: e.target.value })}
              className="input"
            />
          </Field>
          <Field label="Port">
            <input
              type="number"
              min={1}
              max={65535}
              value={v.port}
              onChange={(e) => setV({ ...v, port: Number(e.target.value) })}
              className="input"
            />
          </Field>
        </div>
        <Field label="Username">
          <input
            value={v.username}
            onChange={(e) => setV({ ...v, username: e.target.value })}
            className="input"
          />
        </Field>
        <Field label="Auth">
          <select
            value={v.auth_type}
            onChange={(e) =>
              setV({
                ...v,
                auth_type: e.target.value as AuthType,
                credential_id: null,
              })
            }
            className="input"
          >
            <option value="agent">SSH agent</option>
            <option value="password">Password</option>
            <option value="key">Private key</option>
          </select>
        </Field>
        {credKind && (
          <Field label="Credential">
            <CredentialPicker
              kind={credKind}
              value={v.credential_id}
              onChange={(id) => setV({ ...v, credential_id: id })}
            />
          </Field>
        )}
        <Field label="Tab color (optional)">
          <div className="flex gap-2 items-center">
            {SWATCHES.map((s) => {
              const selected = v.color === s.value;
              const bg = 'display' in s ? s.display : s.value!;
              return (
                <button
                  key={s.label}
                  type="button"
                  onClick={() => setV({ ...v, color: s.value })}
                  aria-label={s.label}
                  title={s.label}
                  aria-pressed={selected}
                  className={`w-6 h-6 rounded border focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
                    selected ? 'ring-2 ring-accent border-accent' : 'border-border'
                  }`}
                  style={{ background: bg }}
                />
              );
            })}
          </div>
        </Field>
        {err && <div className="text-danger text-xs">{err}</div>}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={props.onClose}
            className="px-3 py-1.5 border border-border rounded hover:bg-surface2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="px-3 py-1.5 bg-accent text-white rounded disabled:opacity-50 hover:brightness-110 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            {props.mode === 'edit' ? 'Save' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-muted text-xs">{label}</span>
      {children}
    </label>
  );
}
