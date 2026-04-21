'use client';
import { useEffect, useState } from 'react';
import { AlertTriangle, Cpu, Key, KeyRound, PlugZap, X } from 'lucide-react';
import { api, errMessage } from '@/lib/tauri';
import type { AuthType, EnvPair, Session, SessionInput } from '@/lib/types';
import { CredentialPicker } from './credential-picker';

interface Props {
  session:      Session;
  errorMessage: string;
  onCancel:     () => void;
  onSaved:      (session: Session) => void;
}

/** Lightweight overlay shown when SSH auth fails. Lets the user fix
 *  username / auth method / credential without leaving the tab or
 *  opening the full session dialog, then retries the connection. */
export function AuthFixOverlay({ session, errorMessage, onCancel, onSaved }: Props) {
  const [username, setUsername] = useState(session.username);
  const [authType, setAuthType] = useState<AuthType>(session.auth_type);
  const [credentialId, setCredentialId] = useState<number | null>(session.credential_id);
  const [passphraseId, setPassphraseId] = useState<number | null>(
    session.key_passphrase_credential_id,
  );
  const [env, setEnv] = useState<EnvPair[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Env vars live in a separate table. Load them so we don't drop them when
  // calling session_update (which takes the full SessionInput).
  useEffect(() => {
    let cancelled = false;
    api.sessionEnvGet(session.id).then((e) => { if (!cancelled) setEnv(e); }).catch(() => {});
    return () => { cancelled = true; };
  }, [session.id]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) { e.preventDefault(); onCancel(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  // Method change clears any attached credential from the prior method —
  // matches the session dialog's behaviour and prevents mismatched attachments.
  function switchMethod(next: AuthType) {
    setAuthType(next);
    setCredentialId(null);
    setPassphraseId(null);
  }

  const credKind =
    authType === 'password' ? ('password' as const) :
    authType === 'key' ? ('private_key' as const) :
    null;

  function validate(): string | null {
    if (!username.trim()) return 'Username is required';
    if ((authType === 'password' || authType === 'key') && credentialId == null) {
      return 'Pick or add a credential';
    }
    return null;
  }

  async function save() {
    const problem = validate();
    if (problem) { setErr(problem); return; }
    setErr(null);
    setBusy(true);
    try {
      const input: SessionInput = {
        folder_id: session.folder_id,
        name: session.name,
        host: session.host,
        port: session.port,
        username: username.trim(),
        auth_type: authType,
        credential_id: credentialId,
        key_passphrase_credential_id: passphraseId,
        color: session.color,
        initial_command: session.initial_command,
        scrollback_lines: session.scrollback_lines,
        font_size: session.font_size,
        font_family: session.font_family ?? '',
        cursor_style: session.cursor_style,
        compression: session.compression,
        keepalive_secs: session.keepalive_secs,
        connect_timeout_secs: session.connect_timeout_secs,
        env,
        session_kind: session.session_kind,
        forward_x11: session.forward_x11,
      };
      const updated = await api.sessionUpdate(session.id, input);
      onSaved(updated);
    } catch (e) {
      setErr(errMessage(e));
      setBusy(false);
    }
  }

  return (
    <div
      className="absolute inset-0 bg-bg/80 backdrop-blur-sm z-30 flex items-center justify-center p-4 overlay-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="authfix-title"
    >
      <div className="w-[480px] max-w-full max-h-[92%] flex flex-col bg-surface border border-border rounded-md shadow-dialog overflow-hidden dialog-in text-sm">
        <header className="px-5 py-3 border-b border-border flex items-center gap-3">
          <AlertTriangle size={18} className="text-warning shrink-0" />
          <div className="min-w-0 flex-1">
            <h2 id="authfix-title" className="font-semibold">Fix authentication</h2>
            <div className="text-muted text-xs truncate font-mono">
              {username || 'user'}@{session.host}{session.port !== 22 ? `:${session.port}` : ''}
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            aria-label="Close"
            className="icon-btn"
          >
            <X size={14} />
          </button>
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
          <div className="flex items-start gap-2 p-3 rounded border border-danger/40 bg-danger/10 text-danger text-xs">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <span className="break-words">{errorMessage}</span>
          </div>

          <label className="block space-y-1">
            <span className="text-muted text-xs">Username</span>
            <input
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
            />
          </label>

          <div className="space-y-1">
            <span className="text-muted text-xs">Auth method</span>
            <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Auth method">
              <MethodButton
                value="password" current={authType} Icon={Key}
                onSelect={switchMethod}
                title="Password" hint="Static password in vault"
              />
              <MethodButton
                value="key" current={authType} Icon={KeyRound}
                onSelect={switchMethod}
                title="Private Key" hint="PEM / OpenSSH key"
              />
              <MethodButton
                value="agent" current={authType} Icon={Cpu}
                onSelect={switchMethod}
                title="SSH Agent" hint="Pageant / OpenSSH Agent"
              />
            </div>
          </div>

          {credKind && (
            <div className="space-y-1">
              <span className="text-muted text-xs">
                {credKind === 'password' ? 'Password credential' : 'Private key'}
              </span>
              <CredentialPicker
                kind={credKind}
                value={credentialId}
                onChange={setCredentialId}
              />
            </div>
          )}

          {authType === 'key' && (
            <div className="space-y-1">
              <span className="text-muted text-xs">Key passphrase (optional)</span>
              <CredentialPicker
                kind="key_passphrase"
                value={passphraseId}
                onChange={setPassphraseId}
              />
            </div>
          )}

          {authType === 'agent' && (
            <p className="text-muted text-xs">
              Uses your OS SSH agent (Pageant / OpenSSH Agent service). On Windows the
              agent service is disabled by default — if you see
              <span className="font-mono mx-1">Agent failure</span>,
              switch to Password or Private Key.
            </p>
          )}

          {err && (
            <div role="alert" className="px-3 py-2 border border-danger/40 bg-danger/10 text-danger text-xs rounded">
              {err}
            </div>
          )}
        </div>

        <footer className="px-5 py-3 border-t border-border bg-surface2/30 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-1.5 border border-border rounded text-sm hover:bg-surface2 disabled:opacity-50 focus-ring"
          >
            Close tab
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="px-4 py-1.5 bg-accent text-white rounded text-sm font-medium disabled:opacity-50 hover:brightness-110 focus-ring inline-flex items-center gap-1.5"
          >
            <PlugZap size={12} />
            <span>Save &amp; reconnect</span>
          </button>
        </footer>
      </div>
    </div>
  );
}

function MethodButton({
  value, current, onSelect, title, hint, Icon,
}: {
  value:    AuthType;
  current:  AuthType;
  onSelect: (a: AuthType) => void;
  title:    string;
  hint:     string;
  Icon:     typeof Key;
}) {
  const on = value === current;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={() => onSelect(value)}
      className={`flex flex-col items-start gap-1 text-left p-2.5 rounded border transition ${
        on
          ? 'border-accent bg-accent/10 text-fg'
          : 'border-border hover:border-muted text-muted hover:text-fg'
      }`}
    >
      <Icon size={14} className={on ? 'text-accent' : ''} />
      <div className="font-medium text-xs">{title}</div>
      <div className="text-[10px] text-muted">{hint}</div>
    </button>
  );
}
