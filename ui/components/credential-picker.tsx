'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/tauri';
import type { CredentialKind, CredentialMeta } from '@/lib/types';

interface Props {
  kind: CredentialKind;
  value: number | null;
  onChange: (id: number | null) => void;
}

export function CredentialPicker({ kind, value, onChange }: Props) {
  const [list, setList] = useState<CredentialMeta[]>([]);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function reload() {
    const all = await api.credentialList();
    setList(all.filter((c) => c.kind === kind));
  }

  useEffect(() => {
    reload();
    // Clear inline-add state when kind flips (password <-> key).
    setAdding(false);
    setLabel('');
    setSecret('');
    setErr(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  async function create() {
    if (!label.trim() || !secret) {
      setErr('Label and secret are required');
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      const created = await api.credentialCreate(kind, label.trim(), secret);
      setSecret('');
      setLabel('');
      setAdding(false);
      await reload();
      onChange(created.id);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <select
        className="input"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
        aria-label="Credential"
      >
        <option value="">— choose —</option>
        {list.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>
      {!adding && (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="text-xs text-accent hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent rounded px-0.5"
        >
          + Add new credential
        </button>
      )}
      {adding && (
        <div className="space-y-2 border border-border rounded p-2 bg-surface2">
          <input
            className="w-full bg-surface border border-border rounded px-2 py-1 text-sm outline-none focus:border-accent"
            placeholder="Label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            aria-label="New credential label"
          />
          <textarea
            className="w-full bg-surface border border-border rounded px-2 py-1 text-sm font-mono outline-none focus:border-accent"
            rows={kind === 'private_key' ? 6 : 1}
            placeholder={kind === 'private_key' ? '-----BEGIN PRIVATE KEY-----' : 'secret'}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            aria-label="New credential secret"
          />
          {err && <div className="text-danger text-xs">{err}</div>}
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setSecret('');
                setLabel('');
                setErr(null);
              }}
              className="px-2 py-1 text-xs border border-border rounded hover:bg-surface focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={create}
              disabled={busy}
              className="px-2 py-1 text-xs bg-accent text-white rounded disabled:opacity-50 hover:brightness-110 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
