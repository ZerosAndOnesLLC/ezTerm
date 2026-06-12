'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Eye, EyeOff, KeyRound, KeySquare, Lock, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api, errMessage } from '@/lib/tauri';
import { emitCredentialsChanged } from '@/lib/credential-events';
import { toast } from '@/lib/toast';
import type { CredentialDetail, CredentialKind } from '@/lib/types';
import { ConfirmDialog } from './confirm-dialog';

interface Props {
  onClose: () => void;
}

const GROUPS: { kind: CredentialKind; title: string; icon: typeof KeyRound; secretLabel: string }[] = [
  { kind: 'private_key',    title: 'SSH keys',        icon: KeySquare, secretLabel: 'Private key (PEM or OpenSSH)' },
  { kind: 'key_passphrase', title: 'Key passphrases', icon: KeyRound,  secretLabel: 'Passphrase' },
  { kind: 'password',       title: 'Passwords',       icon: Lock,      secretLabel: 'Password' },
];

type RowEdit =
  | { id: number; mode: 'rename'; label: string }
  | { id: number; mode: 'replace'; secret: string };

/** Vault credential manager — list, rename, replace-secret, delete, and
 *  add for every credential kind. Sessions reference credentials by id,
 *  so renames and secret rotations apply everywhere immediately; deletes
 *  null the references (warned via `used_by` before confirming). */
export function CredentialsDialog({ onClose }: Props) {
  const [items, setItems] = useState<CredentialDetail[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [edit, setEdit] = useState<RowEdit | null>(null);
  const [addKind, setAddKind] = useState<CredentialKind | null>(null);
  const [addLabel, setAddLabel] = useState('');
  const [addSecret, setAddSecret] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<CredentialDetail | null>(null);
  const [busy, setBusy] = useState(false);
  // Re-entrancy guard for run(): state alone is stale within one tick, so
  // a double-Enter in the rename input could launch concurrent mutations.
  const busyRef = useRef(false);

  const reload = useCallback(async () => {
    try {
      setItems(await api.credentialListDetailed());
      setLoaded(true);
    } catch (e) {
      toast.danger('Failed to load credentials', errMessage(e));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.credentialListDetailed()
      .then((d) => {
        if (cancelled) return;
        setItems(d);
        setLoaded(true);
      })
      .catch((e: unknown) => {
        if (!cancelled) toast.danger('Failed to load credentials', errMessage(e));
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Capture phase + stopPropagation: this dialog can be nested inside
      // the session dialog (via CredentialPicker), whose own bubble-phase
      // window handlers bind Escape (close) AND Ctrl/Cmd+Enter (save) —
      // either would tear down the session editor underneath the open
      // manager. Swallow both here; Escape unwinds one layer at a time:
      // confirm → inline edit → dialog. Never gated on busy — a hung
      // mutation must not leave Escape dead for the whole app.
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (confirmDelete) {
          setConfirmDelete(null);
        } else if (edit || addKind) {
          setEdit(null);
          setAddKind(null);
        } else {
          onClose();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [edit, addKind, confirmDelete, onClose]);

  /** Run a mutation + reload. Returns false on failure so callers keep
   *  the inline form (and whatever the user typed) open. Re-entrant
   *  calls are dropped while a mutation is in flight. */
  async function run(fn: () => Promise<void>): Promise<boolean> {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    try {
      await fn();
      await reload();
      emitCredentialsChanged();
      return true;
    } catch (e) {
      toast.danger('Action failed', errMessage(e));
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function saveRename() {
    if (edit?.mode !== 'rename') return;
    const { id, label } = edit;
    if (!label.trim()) return;
    const ok = await run(async () => {
      await api.credentialUpdate(id, label.trim(), null);
      toast.success('Credential renamed');
    });
    if (ok) setEdit(null);
  }

  async function saveReplace(current: CredentialDetail) {
    if (edit?.mode !== 'replace' || !edit.secret) return;
    const secret = edit.secret;
    const ok = await run(async () => {
      // label: null — rotating never writes the label, so a stale list
      // can't silently revert a rename done elsewhere (or on a synced
      // device) in the meantime.
      await api.credentialUpdate(current.id, null, secret);
      toast.success('Secret updated', current.label);
    });
    if (ok) setEdit(null);
  }

  async function saveAdd() {
    if (!addKind || !addLabel.trim() || !addSecret) return;
    const kind = addKind;
    const ok = await run(async () => {
      await api.credentialCreate(kind, addLabel.trim(), addSecret);
      toast.success('Credential added', addLabel.trim());
    });
    if (ok) {
      setAddKind(null);
      setAddLabel('');
      setAddSecret('');
    }
  }

  async function doDelete(c: CredentialDetail) {
    const ok = await run(async () => {
      await api.credentialDelete(c.id);
      toast.success('Credential deleted', c.label);
    });
    // Keep the confirm open on failure — closing it would make a failed
    // delete look successful apart from a transient toast.
    if (ok) setConfirmDelete(null);
  }

  // Portaled to <body>: the dialog can be opened from CredentialPicker
  // inside the session editor's <form> (Enter would implicitly submit it)
  // and inside AuthFixOverlay, whose backdrop-filter creates a containing
  // block that re-anchors `fixed` descendants to the terminal pane.
  // Escaping the DOM tree sidesteps both.
  return createPortal(
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4 overlay-in"
      role="dialog"
      aria-modal="true"
      aria-label="Credentials"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-[600px] max-w-full max-h-[85vh] bg-surface border border-border rounded-md shadow-dialog overflow-hidden dialog-in flex flex-col">
        <div className="px-4 py-3 border-b border-border bg-surface2/30 flex items-center justify-between">
          <h2 className="font-semibold text-sm">Credentials</h2>
          <span className="text-[11px] text-muted">
            Stored encrypted in the vault · changes apply to every session using them
          </span>
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-4 space-y-5">
          {GROUPS.map((g) => {
            const rows = items.filter((c) => c.kind === g.kind);
            const GroupIcon = g.icon;
            return (
              <section key={g.kind} aria-label={g.title}>
                <div className="flex items-center gap-2 mb-1.5">
                  <GroupIcon size={13} className="text-accent" />
                  <h3 className="text-[11px] uppercase tracking-wider text-muted font-medium flex-1">
                    {g.title}
                  </h3>
                  <button
                    type="button"
                    onClick={() => {
                      setEdit(null);
                      setAddKind(g.kind);
                      setAddLabel('');
                      setAddSecret('');
                    }}
                    className="btn-ghost focus-ring"
                  >
                    <Plus size={12} />
                    <span>Add</span>
                  </button>
                </div>

                <div className="border border-border rounded-sm divide-y divide-border">
                  {rows.length === 0 && addKind !== g.kind && (
                    <div className="px-3 py-2 text-xs text-muted">
                      {loaded ? `No ${g.title.toLowerCase()} saved.` : 'Loading…'}
                    </div>
                  )}

                  {rows.map((c) => (
                    <div key={c.id} className="px-3 py-2 space-y-2">
                      <div className="flex items-center gap-2 group">
                        {edit?.id === c.id && edit.mode === 'rename' ? (
                          <>
                            <input
                              className="input flex-1"
                              value={edit.label}
                              onChange={(e) => setEdit({ ...edit, label: e.target.value })}
                              onKeyDown={(e) => { if (e.key === 'Enter') saveRename(); }}
                              aria-label={`Rename ${c.label}`}
                              autoFocus
                            />
                            <button type="button" onClick={saveRename} disabled={busy} className="btn-primary focus-ring">
                              Save
                            </button>
                            <button
                              type="button"
                              onClick={() => setEdit(null)}
                              className="px-2 py-1 text-xs border border-border rounded-sm hover:bg-surface2 focus-ring"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <div className="flex-1 min-w-0">
                              <div className="text-xs font-medium truncate">{c.label}</div>
                              <div className="text-[11px] text-muted flex gap-2">
                                <span>Added {c.created_at.slice(0, 10)}</span>
                                <span
                                  title={c.used_by.length ? c.used_by.map((s) => s.name).join('\n') : undefined}
                                  className={c.used_by.length ? '' : 'opacity-70'}
                                >
                                  {c.used_by.length
                                    ? `· Used by ${c.used_by.length} session${c.used_by.length === 1 ? '' : 's'}`
                                    : '· Not used by any session'}
                                </span>
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => { setAddKind(null); setEdit({ id: c.id, mode: 'rename', label: c.label }); }}
                              aria-label={`Rename ${c.label}`}
                              title="Rename"
                              className="icon-btn opacity-0 group-hover:opacity-100 focus:opacity-100"
                            >
                              <Pencil size={12} />
                            </button>
                            <button
                              type="button"
                              onClick={() => { setAddKind(null); setEdit({ id: c.id, mode: 'replace', secret: '' }); }}
                              aria-label={`Replace secret for ${c.label}`}
                              title={`Replace ${g.secretLabel.toLowerCase()}`}
                              className="icon-btn opacity-0 group-hover:opacity-100 focus:opacity-100"
                            >
                              <RefreshCw size={12} />
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDelete(c)}
                              aria-label={`Delete ${c.label}`}
                              title="Delete"
                              className="icon-btn opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-danger hover:bg-danger/10"
                            >
                              <Trash2 size={12} />
                            </button>
                          </>
                        )}
                      </div>

                      {edit?.id === c.id && edit.mode === 'replace' && (
                        <div className="space-y-2">
                          <SecretInput
                            kind={g.kind}
                            placeholder={`New ${g.secretLabel.toLowerCase()}`}
                            value={edit.secret}
                            onChange={(secret) => setEdit({ ...edit, secret })}
                            onEnter={() => saveReplace(c)}
                            ariaLabel={`New secret for ${c.label}`}
                          />
                          <div className="flex gap-2 justify-end">
                            <button
                              type="button"
                              onClick={() => setEdit(null)}
                              className="px-2 py-1 text-xs border border-border rounded-sm hover:bg-surface2 focus-ring"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              onClick={() => saveReplace(c)}
                              disabled={busy || !edit.secret}
                              className="btn-primary focus-ring"
                            >
                              Replace secret
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}

                  {addKind === g.kind && (
                    <div className="px-3 py-2 bg-surface2/40 space-y-2">
                      <input
                        className="input"
                        placeholder="Label (e.g. 'Prod server key')"
                        value={addLabel}
                        onChange={(e) => setAddLabel(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') saveAdd(); }}
                        aria-label={`New ${g.title} label`}
                        autoFocus
                      />
                      <SecretInput
                        kind={g.kind}
                        placeholder={g.secretLabel}
                        value={addSecret}
                        onChange={setAddSecret}
                        onEnter={saveAdd}
                        ariaLabel={`New ${g.title} secret`}
                      />
                      <div className="flex gap-2 justify-end">
                        <button
                          type="button"
                          onClick={() => setAddKind(null)}
                          className="px-2 py-1 text-xs border border-border rounded-sm hover:bg-surface2 focus-ring"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={saveAdd}
                          disabled={busy || !addLabel.trim() || !addSecret}
                          className="btn-primary focus-ring"
                        >
                          Save credential
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </section>
            );
          })}
        </div>

        <div className="px-4 py-3 border-t border-border bg-surface2/30 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 border border-border rounded text-sm hover:bg-surface2 focus-ring"
          >
            Close
          </button>
        </div>
      </div>

      {confirmDelete && (
        <ConfirmDialog
          kind="danger"
          title={`Delete "${confirmDelete.label}"?`}
          body={
            confirmDelete.used_by.length
              ? `Used by ${confirmDelete.used_by.length} session${confirmDelete.used_by.length === 1 ? '' : 's'}:\n${
                  confirmDelete.used_by.map((s) => `· ${s.name}`).join('\n')
                }\n\nThese sessions will fail to connect until you assign them a new credential.`
              : 'No sessions use this credential.'
          }
          confirmText="Delete"
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => doDelete(confirmDelete)}
        />
      )}
    </div>,
    document.body,
  );
}

function SecretInput({
  kind, placeholder, value, onChange, onEnter, ariaLabel,
}: {
  kind: CredentialKind;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  /** Enter-to-save for the single-line variant; the private-key textarea
   *  keeps Enter for newlines. */
  onEnter?: () => void;
  ariaLabel: string;
}) {
  const [show, setShow] = useState(false);
  if (kind === 'private_key') {
    return (
      <textarea
        className="w-full bg-surface border border-border rounded-sm px-2 py-1.5 text-xs font-mono outline-none focus:border-accent"
        rows={5}
        placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={ariaLabel}
        spellCheck={false}
      />
    );
  }
  return (
    <div className="relative">
      <input
        type={show ? 'text' : 'password'}
        className="input pr-9"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') onEnter?.(); }}
        aria-label={ariaLabel}
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
  );
}
