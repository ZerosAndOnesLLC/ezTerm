'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  Cog,
  Cpu,
  Key,
  KeyRound,
  Minus,
  Plus,
  Sliders,
  Square,
  Terminal as TerminalIcon,
  Trash2,
  Type,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api } from '@/lib/tauri';
import type {
  AuthType,
  CursorStyle,
  EnvPair,
  Folder,
  Session,
  SessionInput,
} from '@/lib/types';
import { CredentialPicker } from './credential-picker';

type Mode =
  | { mode: 'create'; folderId: number | null }
  | { mode: 'edit'; session: Session };

type Props = Mode & {
  folders: Folder[];
  onClose: () => void;
  onSaved: () => void;
};

type TabKey = 'general' | 'terminal' | 'advanced';

// Defaults mirror the Rust-side DB defaults (see migration
// 20260420130000_session_advanced_settings.sql).
const DEFAULTS: Omit<SessionInput, 'folder_id' | 'name' | 'host' | 'port' | 'username'> = {
  auth_type: 'agent',
  credential_id: null,
  key_passphrase_credential_id: null,
  color: null,
  initial_command: null,
  scrollback_lines: 5000,
  font_size: 13,
  cursor_style: 'block',
  compression: 0,
  keepalive_secs: 0,
  connect_timeout_secs: 15,
  env: [],
};

// Palette for the tab-color dot. Slate stores null = "no accent".
const SWATCHES = [
  { value: '#60a5fa', label: 'Blue' },
  { value: '#34d399', label: 'Green' },
  { value: '#fbbf24', label: 'Amber' },
  { value: '#f87171', label: 'Red' },
  { value: '#a78bfa', label: 'Purple' },
  { value: null,      label: 'None', display: '#94a3b8' },
] as const;

export function SessionDialog(props: Props) {
  const editId  = props.mode === 'edit'   ? props.session.id : null;
  const newRoot = props.mode === 'create' ? props.folderId   : null;

  const initial: SessionInput = useMemo(() => {
    if (props.mode === 'edit') {
      const s = props.session;
      return {
        folder_id: s.folder_id,
        name: s.name,
        host: s.host,
        port: s.port,
        username: s.username,
        auth_type: s.auth_type,
        credential_id: s.credential_id,
        key_passphrase_credential_id: s.key_passphrase_credential_id,
        color: s.color,
        initial_command: s.initial_command,
        scrollback_lines: s.scrollback_lines,
        font_size: s.font_size,
        cursor_style: s.cursor_style,
        compression: s.compression,
        keepalive_secs: s.keepalive_secs,
        connect_timeout_secs: s.connect_timeout_secs,
        env: [], // populated async below
      };
    }
    return {
      folder_id: props.folderId,
      name: '',
      host: '',
      port: 22,
      username: '',
      ...DEFAULTS,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId, newRoot, props.mode]);

  const [v, setV] = useState<SessionInput>(initial);
  const [tab, setTab] = useState<TabKey>('general');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setV(initial); }, [initial]);

  // Load env vars for edit mode (separate IPC — env is in its own table).
  useEffect(() => {
    if (props.mode !== 'edit') return;
    let cancelled = false;
    api.sessionEnvGet(props.session.id).then((env) => {
      if (!cancelled) setV((cur) => ({ ...cur, env }));
    }).catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId]);

  // Esc closes, Ctrl+Enter saves.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); props.onClose(); }
      else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        void save();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v]);

  const credKind =
    v.auth_type === 'password' ? ('password' as const)
    : v.auth_type === 'key' ? ('private_key' as const)
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
    if (input.scrollback_lines < 0 || input.scrollback_lines > 100_000) {
      return 'Scrollback must be between 0 and 100000';
    }
    if (input.font_size < 8 || input.font_size > 48) {
      return 'Font size must be between 8 and 48';
    }
    if (input.keepalive_secs < 0 || input.keepalive_secs > 7200) {
      return 'Keepalive must be between 0 and 7200 seconds';
    }
    if (input.connect_timeout_secs < 1 || input.connect_timeout_secs > 600) {
      return 'Connect timeout must be between 1 and 600 seconds';
    }
    for (const p of input.env) {
      if (!p.key.trim()) return 'Env var name cannot be empty';
      if (p.key.includes('=') || p.key.includes('\0')) return 'Env var name cannot contain "=" or NUL';
    }
    return null;
  }

  async function save(e?: React.FormEvent) {
    e?.preventDefault();
    const problem = validate(v);
    if (problem) { setErr(problem); return; }
    setErr(null);
    setBusy(true);
    try {
      // Strip empty env rows the user left blank. Backend would reject them
      // anyway; silently dropping is friendlier than an error.
      const cleaned: SessionInput = {
        ...v,
        initial_command: v.initial_command?.trim() ? v.initial_command : null,
        env: v.env.filter((p) => p.key.trim()),
      };
      if (props.mode === 'edit') {
        await api.sessionUpdate(props.session.id, cleaned);
      } else {
        await api.sessionCreate(cleaned);
      }
      props.onSaved();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const accent = v.color ?? '#94a3b8';
  const summary = `${v.username || 'user'}@${v.host || 'host'}:${v.port || 22}`;

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-40 p-4 overlay-in"
      role="dialog"
      aria-modal="true"
      aria-label={props.mode === 'edit' ? 'Edit session' : 'New session'}
      onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}
    >
      <form
        onSubmit={save}
        className="w-[760px] max-w-full max-h-[90vh] flex flex-col bg-surface border border-border rounded-md shadow-dialog overflow-hidden text-sm dialog-in"
      >
        {/* Header with live summary */}
        <header className="px-5 py-3 border-b border-border flex items-center gap-3">
          <span
            className="w-3 h-3 rounded-full shrink-0"
            style={{ background: accent }}
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <div className="font-semibold truncate">
              {v.name || (props.mode === 'edit' ? 'Edit session' : 'New session')}
            </div>
            <div className="text-muted text-xs truncate font-mono">{summary}</div>
          </div>
          <button
            type="button"
            onClick={props.onClose}
            aria-label="Close"
            className="icon-btn"
          >
            <X size={14} />
          </button>
        </header>

        {/* Body: tab rail + content */}
        <div className="flex flex-1 min-h-0">
          <nav
            className="w-[160px] shrink-0 border-r border-border bg-surface py-2"
            role="tablist"
            aria-label="Session sections"
          >
            <TabButton id="general"  label="General"  icon={<Sliders size={13} />}   active={tab} onClick={setTab} />
            <TabButton id="terminal" label="Terminal" icon={<TerminalIcon size={13} />} active={tab} onClick={setTab} />
            <TabButton id="advanced" label="Advanced" icon={<Cog size={13} />}       active={tab} onClick={setTab} />
          </nav>

          <div className="flex-1 min-w-0 overflow-y-auto p-5 space-y-4" role="tabpanel">
            {tab === 'general' && (
              <GeneralPane v={v} setV={setV} folders={props.folders} credKind={credKind} />
            )}
            {tab === 'terminal' && (
              <TerminalPane v={v} setV={setV} />
            )}
            {tab === 'advanced' && (
              <AdvancedPane v={v} setV={setV} />
            )}
          </div>
        </div>

        {err && (
          <div role="alert" className="px-5 py-2 border-t border-danger/40 bg-danger/10 text-danger text-xs">
            {err}
          </div>
        )}

        {/* Footer */}
        <footer className="px-5 py-3 border-t border-border flex items-center justify-between gap-3 bg-surface2/30">
          <span className="text-muted text-xs">
            <kbd className="px-1 py-0.5 border border-border rounded bg-surface text-xs">Esc</kbd>
            <span className="mx-1">close</span>
            <kbd className="px-1 py-0.5 border border-border rounded bg-surface text-xs">Ctrl</kbd>
            <span className="mx-0.5">+</span>
            <kbd className="px-1 py-0.5 border border-border rounded bg-surface text-xs">Enter</kbd>
            <span className="ml-1">save</span>
          </span>
          <div className="flex gap-2">
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
              className="px-4 py-1.5 bg-accent text-white rounded font-medium disabled:opacity-50 hover:brightness-110 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              {props.mode === 'edit' ? 'Save changes' : 'Create session'}
            </button>
          </div>
        </footer>
      </form>
    </div>
  );

  function TabButton({
    id, label, icon, active, onClick,
  }: {
    id: TabKey;
    label: string;
    icon: React.ReactNode;
    active: TabKey;
    onClick: (id: TabKey) => void;
  }) {
    const on = id === active;
    return (
      <button
        type="button"
        role="tab"
        aria-selected={on}
        onClick={() => onClick(id)}
        className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm border-l-2 transition-colors ${
          on
            ? 'border-accent text-fg bg-surface2'
            : 'border-transparent text-muted hover:text-fg hover:bg-surface2/50'
        }`}
      >
        {icon}
        <span>{label}</span>
      </button>
    );
  }
}

interface PaneProps {
  v: SessionInput;
  setV: React.Dispatch<React.SetStateAction<SessionInput>>;
}

function GeneralPane({
  v, setV, folders, credKind,
}: PaneProps & {
  folders: Folder[];
  credKind: 'password' | 'private_key' | null;
}) {
  return (
    <>
      <SectionHeading>Connection</SectionHeading>
      <Field label="Name">
        <input
          value={v.name}
          onChange={(e) => setV({ ...v, name: e.target.value })}
          className="input"
          autoFocus
          placeholder="My production server"
        />
      </Field>
      <Field label="Folder">
        <select
          value={v.folder_id ?? ''}
          onChange={(e) => setV({ ...v, folder_id: e.target.value ? Number(e.target.value) : null })}
          className="input"
        >
          <option value="">(root)</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>{f.name}</option>
          ))}
        </select>
      </Field>
      <div className="grid grid-cols-[1fr_110px] gap-3">
        <Field label="Host">
          <input
            value={v.host}
            onChange={(e) => setV({ ...v, host: e.target.value })}
            className="input"
            placeholder="example.com or 10.0.0.1"
          />
        </Field>
        <Field label="Port">
          <input
            type="number" min={1} max={65535}
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
          placeholder="root"
        />
      </Field>

      <SectionHeading>Authentication</SectionHeading>
      <Field label="Method">
        <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Auth method">
          <AuthOption value="password" current={v.auth_type} Icon={Key}
            onSelect={(a) => setV({ ...v, auth_type: a, credential_id: null, key_passphrase_credential_id: null })}
            title="Password" hint="Static password in vault" />
          <AuthOption value="key" current={v.auth_type} Icon={KeyRound}
            onSelect={(a) => setV({ ...v, auth_type: a, credential_id: null, key_passphrase_credential_id: null })}
            title="Private Key" hint="PEM / OpenSSH key" />
          <AuthOption value="agent" current={v.auth_type} Icon={Cpu}
            onSelect={(a) => setV({ ...v, auth_type: a, credential_id: null, key_passphrase_credential_id: null })}
            title="SSH Agent" hint="Pageant / OpenSSH Agent" />
        </div>
      </Field>

      {credKind && (
        <Field label={credKind === 'password' ? 'Password credential' : 'Private key'}>
          <CredentialPicker
            kind={credKind}
            value={v.credential_id}
            onChange={(id) => setV({ ...v, credential_id: id })}
          />
        </Field>
      )}
      {v.auth_type === 'key' && (
        <Field label="Key passphrase (optional)">
          <CredentialPicker
            kind="key_passphrase"
            value={v.key_passphrase_credential_id}
            onChange={(id) => setV({ ...v, key_passphrase_credential_id: id })}
          />
        </Field>
      )}
      {v.auth_type === 'agent' && (
        <p className="text-muted text-xs">
          Uses your OS SSH agent (Pageant / OpenSSH Agent service). On Windows
          the agent service is disabled by default — if you see
          <span className="font-mono mx-1">Agent failure</span>,
          switch to Password or Private Key.
        </p>
      )}

      <SectionHeading>Appearance</SectionHeading>
      <Field label="Tab color">
        <div className="flex gap-1.5 items-center">
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
                className={`w-5 h-5 rounded-sm border transition ${
                  selected ? 'ring-2 ring-accent border-transparent' : 'border-border hover:border-muted'
                }`}
                style={{ background: bg }}
              />
            );
          })}
        </div>
      </Field>
    </>
  );
}

function TerminalPane({ v, setV }: PaneProps) {
  const CURSOR_OPTIONS: Array<{ v: CursorStyle; label: string; Icon: LucideIcon }> = [
    { v: 'block',     label: 'Block',     Icon: Square },
    { v: 'bar',       label: 'Bar',       Icon: Type },
    { v: 'underline', label: 'Underline', Icon: Minus },
  ];

  return (
    <>
      <SectionHeading>On connect</SectionHeading>
      <Field label="Initial command (optional)" hint="Runs once after the shell opens, as if you typed it.">
        <input
          value={v.initial_command ?? ''}
          onChange={(e) => setV({ ...v, initial_command: e.target.value })}
          className="input font-mono"
          placeholder="tmux attach -t main || tmux new -s main"
        />
      </Field>

      <SectionHeading>Display</SectionHeading>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Scrollback lines" hint="0 disables scrollback.">
          <input
            type="number" min={0} max={100_000} step={500}
            value={v.scrollback_lines}
            onChange={(e) => setV({ ...v, scrollback_lines: Number(e.target.value) })}
            className="input"
          />
        </Field>
        <Field label="Font size">
          <input
            type="number" min={8} max={48}
            value={v.font_size}
            onChange={(e) => setV({ ...v, font_size: Number(e.target.value) })}
            className="input"
          />
        </Field>
      </div>
      <Field label="Cursor style">
        <div className="inline-flex rounded border border-border overflow-hidden">
          {CURSOR_OPTIONS.map((o) => {
            const on = v.cursor_style === o.v;
            return (
              <button
                key={o.v}
                type="button"
                onClick={() => setV({ ...v, cursor_style: o.v })}
                aria-pressed={on}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs transition-colors ${
                  on
                    ? 'bg-surface2 text-fg'
                    : 'bg-surface text-muted hover:bg-surface2/60 hover:text-fg'
                }`}
              >
                <o.Icon size={12} />
                <span>{o.label}</span>
              </button>
            );
          })}
        </div>
      </Field>

      <SectionHeading>Environment variables</SectionHeading>
      <p className="text-muted text-xs">
        Sent via SSH <span className="font-mono">env</span> requests on connect.
        Most servers reject unlisted names via <span className="font-mono">AcceptEnv</span>;
        <span className="font-mono"> LANG</span> and <span className="font-mono">LC_*</span> usually work.
      </p>
      <EnvEditor value={v.env} onChange={(env) => setV({ ...v, env })} />
    </>
  );
}

function AdvancedPane({ v, setV }: PaneProps) {
  return (
    <>
      <SectionHeading>Connection</SectionHeading>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Connect timeout (seconds)">
          <input
            type="number" min={1} max={600}
            value={v.connect_timeout_secs}
            onChange={(e) => setV({ ...v, connect_timeout_secs: Number(e.target.value) })}
            className="input"
          />
        </Field>
        <Field label="Keepalive (seconds)" hint="0 disables SSH keepalives.">
          <input
            type="number" min={0} max={7200}
            value={v.keepalive_secs}
            onChange={(e) => setV({ ...v, keepalive_secs: Number(e.target.value) })}
            className="input"
          />
        </Field>
      </div>

      <SectionHeading>Transport</SectionHeading>
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={v.compression === 1}
          onChange={(e) => setV({ ...v, compression: e.target.checked ? 1 : 0 })}
          className="w-4 h-4 accent-accent"
        />
        <span>Enable SSH compression (zlib)</span>
      </label>
      <p className="text-muted text-xs -mt-2">
        Helps on slow links. Negligible or negative effect on LANs; leave off unless
        you know the link is constrained.
      </p>
    </>
  );
}

function EnvEditor({
  value, onChange,
}: { value: EnvPair[]; onChange: (env: EnvPair[]) => void }) {
  function update(i: number, patch: Partial<EnvPair>) {
    onChange(value.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  }
  function remove(i: number) {
    onChange(value.filter((_, idx) => idx !== i));
  }
  function add() {
    onChange([...value, { key: '', value: '' }]);
  }
  return (
    <div className="space-y-2">
      {value.length === 0 && (
        <div className="text-muted text-xs italic">No variables.</div>
      )}
      {value.map((p, i) => (
        <div key={i} className="grid grid-cols-[180px_1fr_auto] gap-2 items-center">
          <input
            className="input font-mono"
            placeholder="NAME"
            value={p.key}
            onChange={(e) => update(i, { key: e.target.value })}
            aria-label={`env name ${i + 1}`}
          />
          <input
            className="input font-mono"
            placeholder="value"
            value={p.value}
            onChange={(e) => update(i, { value: e.target.value })}
            aria-label={`env value ${i + 1}`}
          />
          <button
            type="button"
            onClick={() => remove(i)}
            aria-label={`remove env ${p.key || i + 1}`}
            className="w-7 h-7 flex items-center justify-center rounded-sm border border-border text-muted hover:text-danger hover:border-danger/60 focus-ring"
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        className="inline-flex items-center gap-1 text-xs px-2 py-1 border border-dashed border-border rounded-sm text-muted hover:text-fg hover:border-accent focus-ring"
      >
        <Plus size={12} />
        <span>Add variable</span>
      </button>
    </div>
  );
}

function AuthOption({
  value, current, onSelect, title, hint, Icon,
}: {
  value: AuthType;
  current: AuthType;
  onSelect: (a: AuthType) => void;
  title: string;
  hint: string;
  Icon: LucideIcon;
}) {
  const on = value === current;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={() => onSelect(value)}
      className={`flex flex-col items-start gap-1 text-left p-3 rounded border transition ${
        on
          ? 'border-accent bg-accent/10 text-fg'
          : 'border-border hover:border-muted text-muted hover:text-fg'
      }`}
    >
      <Icon size={16} className={on ? 'text-accent' : ''} />
      <div className="font-medium text-sm">{title}</div>
      <div className="text-xs text-muted">{hint}</div>
    </button>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-xs uppercase tracking-wider text-muted font-semibold pt-2 first:pt-0">
      {children}
    </h3>
  );
}

function Field({
  label, hint, children,
}: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-muted text-xs">{label}</span>
      {children}
      {hint && <span className="block text-muted text-xs">{hint}</span>}
    </label>
  );
}
