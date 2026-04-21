'use client';
import { useEffect, useState } from 'react';
import { Eye, EyeOff, Plus } from 'lucide-react';
import { api } from '@/lib/tauri';
import type { CredentialKind, CredentialMeta } from '@/lib/types';

interface Props {
  kind: CredentialKind;
  value: number | null;
  onChange: (id: number | null) => void;
}

const PROMPT: Record<CredentialKind, { secret: string; verb: string }> = {
  password:       { secret: 'Password',                        verb: 'password' },
  private_key:    { secret: 'Private key (PEM or OpenSSH)',    verb: 'private key' },
  key_passphrase: { secret: 'Passphrase',                      verb: 'passphrase' },
};

export function CredentialPicker({ kind, value, onChange }: Props) {
  const [list, setList] = useState<CredentialMeta[]>([]);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState('');
  const [show, setShow] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function reload() {
    const all = await api.credentialList();
    setList(all.filter((c) => c.kind === kind));
  }

  useEffect(() => {
    reload();
    setAdding(false);
    setLabel('');
    setSecret('');
    setShow(false);
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
      setShow(false);
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
      <div className="flex gap-2">
        <select
          className="input flex-1"
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
          aria-label="Credential"
        >
          <option value="">— choose saved {PROMPT[kind].verb} —</option>
          {list.map((c) => (
            <option key={c.id} value={c.id}>{c.label}</option>
          ))}
        </select>
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="btn-ghost focus-ring"
          >
            <Plus size={12} />
            <span>Add new</span>
          </button>
        )}
      </div>

      {adding && (
        <div className="border border-border rounded-sm p-3 bg-surface2 space-y-2">
          <div className="text-[11px] uppercase tracking-wider text-muted font-medium">
            New {PROMPT[kind].verb}
          </div>
          <input
            className="input"
            placeholder="Label (e.g. 'Prod server key')"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            aria-label="New credential label"
            autoFocus
          />
          {kind === 'private_key' ? (
            <textarea
              className="w-full bg-surface border border-border rounded-sm px-2 py-1.5 text-xs font-mono outline-none focus:border-accent"
              rows={6}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              aria-label="New credential secret"
              spellCheck={false}
            />
          ) : (
            <div className="relative">
              <input
                type={show ? 'text' : 'password'}
                className="input pr-9"
                placeholder={PROMPT[kind].secret}
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                aria-label="New credential secret"
              />
              <button
                type="button"
                onClick={() => setShow((s) => !s)}
                aria-label={show ? 'Hide secret' : 'Show secret'}
                title={show ? 'Hide' : 'Show'}
                className="icon-btn absolute right-1 top-1/2 -translate-y-1/2 w-7 h-7"
              >
                {show ? <EyeOff size={12} /> : <Eye size={12} />}
              </button>
            </div>
          )}
          {err && <div className="text-danger text-xs">{err}</div>}
          <div className="flex gap-2 justify-end pt-1">
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setSecret('');
                setLabel('');
                setShow(false);
                setErr(null);
              }}
              className="px-3 py-1 text-xs border border-border rounded-sm hover:bg-surface focus-ring"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={create}
              disabled={busy}
              className="btn-primary focus-ring"
            >
              Save credential
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
