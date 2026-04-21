use std::sync::Arc;

use async_trait::async_trait;
use russh::client::{self, Config, Handle, Msg};
use russh::Channel;
use russh_keys::key;
use russh_keys::PublicKeyBase64;
use tauri::AppHandle;
use tauri::Emitter;
use tokio::sync::{mpsc, Mutex};
use zeroize::Zeroizing;

use crate::db;
use crate::error::{AppError, Result};
use crate::log_redacted;
use crate::sftp::SftpRegistry;
use crate::ssh::known_hosts::{fingerprint_sha256, KeyCheck};
use crate::ssh::registry::{Connection, ConnectionInput, ConnectionRegistry};
use crate::state::AppState;
use crate::vault;
use crate::xserver::{self, XServerManager};

pub struct ConnectRequest {
    pub session_id: i64,
    pub cols: u16,
    pub rows: u16,
    /// If true, bypass known_hosts mismatch/untrusted checks (set only after
    /// the user explicitly confirmed trust in the UI prompt).
    pub trust_any: bool,
}

pub struct ConnectOutcome {
    pub connection_id: u64,
    pub fingerprint_sha256: String,
}

pub struct ClientHandler {
    /// (algorithm_name, sha256_fingerprint) captured from the server's host key.
    /// russh-keys 0.45's `PublicKey::name()` returns the SSH wire name
    /// (e.g. "ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256").
    server_key: Arc<Mutex<Option<(String, String)>>>,
    /// Display number to pipe forwarded X11 channels to (always the same
    /// display the connect flow acquired on — default :0). `None` disables
    /// X11 forwarding handling; `server_channel_open_x11` drops the channel.
    x11_display: Option<u8>,
}

#[async_trait]
impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &key::PublicKey,
    ) -> std::result::Result<bool, Self::Error> {
        // russh-keys 0.45 exposes the SSH-wire public-key blob via the
        // PublicKeyBase64 trait's public_key_bytes() method (the old
        // `key_format::serialize_public_key` helper has been removed).
        let blob = key.public_key_bytes();
        let fp = fingerprint_sha256(&blob);
        let alg = key.name().to_string();
        *self.server_key.lock().await = Some((alg, fp));
        // We accept here and verify against known_hosts in connect() after
        // the handshake completes. Rejecting here would give the user no
        // TOFU prompt path.
        Ok(true)
    }

    /// Server is asking to open an X11 channel back to us (a GUI app on
    /// the remote called out via `$DISPLAY`). Pipe the channel bidirectionally
    /// to our local VcXsrv on `127.0.0.1:6000+display`. Dropping the
    /// channel when X11 wasn't negotiated on this connection is the safe
    /// default — russh will close it on the server's side.
    async fn server_channel_open_x11(
        &mut self,
        channel: russh::Channel<Msg>,
        _originator_address: &str,
        _originator_port: u32,
        _session: &mut russh::client::Session,
    ) -> std::result::Result<(), Self::Error> {
        let Some(display) = self.x11_display else { return Ok(()); };
        let target = format!("127.0.0.1:{}", 6000 + display as u16);
        tokio::spawn(async move {
            let tcp = match tokio::net::TcpStream::connect(&target).await {
                Ok(s) => s,
                Err(e) => {
                    tracing::warn!("x11 forward: connect {target} failed: {e}");
                    return;
                }
            };
            let (mut ch_r, mut ch_w) = {
                let stream = channel.into_stream();
                tokio::io::split(stream)
            };
            let (mut tcp_r, mut tcp_w) = tokio::io::split(tcp);
            // Bi-directional pump. On either side closing, end both halves
            // so the X11 channel tears down cleanly.
            let a = tokio::io::copy(&mut ch_r, &mut tcp_w);
            let b = tokio::io::copy(&mut tcp_r, &mut ch_w);
            let _ = tokio::join!(a, b);
        });
        Ok(())
    }
}

/// Perform a full connect: resolve session, decrypt credential if needed,
/// open SSH, authenticate, open shell channel with PTY, register with
/// ConnectionRegistry, and spawn reader/writer tasks that bridge russh ↔ Tauri
/// events. Returns ConnectOutcome with the allocated connection_id on success.
pub async fn connect(
    state: &AppState,
    app: AppHandle,
    req: ConnectRequest,
) -> Result<ConnectOutcome> {
    // 1. Resolve saved session + load (possibly) encrypted credential.
    let session = db::sessions::get(&state.db, req.session_id).await?;
    {
        let host = &session.host;
        let user = &session.username;
        let port = session.port;
        let session_id = req.session_id;
        log_redacted!(info, "ssh.connect.begin",
            session_id = session_id,
            host = %host,
            port = port,
            user = %user);
    }
    let (auth_material, _cred_kind) = load_auth_material(state, &session).await?;
    let env_pairs = db::sessions::env_get(&state.db, req.session_id).await?;

    // 2. Configure russh client.
    // Per-session tunables (keepalive, compression) come from the sessions
    // row. A keepalive of 0 means "disabled" (russh reads the absence of a
    // Duration as "no keepalives"), matching our `keepalive_secs` semantics.
    let mut config = Config::default();
    if session.keepalive_secs > 0 {
        config.keepalive_interval =
            Some(std::time::Duration::from_secs(session.keepalive_secs as u64));
    }
    if session.compression == 1 {
        // Prefer zlib variants when the server offers them, but keep "none"
        // as a last resort so connect doesn't fail against strict servers.
        // Order matters: russh negotiates the first mutually-acceptable name.
        // The list is static because russh holds it via `Cow::Borrowed` for
        // the connection lifetime.
        static COMPRESSION_ON: &[russh::compression::Name] = &[
            russh::compression::ZLIB_LEGACY,
            russh::compression::ZLIB,
            russh::compression::NONE,
        ];
        config.preferred.compression = std::borrow::Cow::Borrowed(COMPRESSION_ON);
    }
    let config = Arc::new(config);
    let server_key = Arc::new(Mutex::new(None));
    // Handler's x11_display is set when the session's forward_x11 flag is
    // on — the async `channel_open_x11` callback reads it to route incoming
    // X11 channels to the correct VcXsrv display.
    let x11_display: Option<u8> = if session.forward_x11 != 0 {
        Some(xserver::DEFAULT_DISPLAY)
    } else {
        None
    };
    let handler = ClientHandler {
        server_key: server_key.clone(),
        x11_display,
    };
    // russh's `client::connect` has no built-in deadline, so we bound the
    // whole handshake (TCP + KEX + host-key) with the user-configured
    // connect_timeout_secs. Exceeding it maps to AppError::Ssh("connect
    // timeout") — distinct from AuthFailed so the UI can surface it plainly.
    let connect_fut = client::connect(
        config,
        (session.host.as_str(), session.port as u16),
        handler,
    );
    let mut handle = tokio::time::timeout(
        std::time::Duration::from_secs(session.connect_timeout_secs as u64),
        connect_fut,
    )
    .await
    .map_err(|_| AppError::Ssh("connect timeout".into()))?
    .map_err(|e| AppError::Ssh(format!("connect: {e}")))?;

    // 3. Host-key TOFU check.
    let (alg, fp) = server_key
        .lock()
        .await
        .clone()
        .ok_or_else(|| AppError::Ssh("no host key".into()))?;
    let check = check_known_host(&state.db, &session.host, session.port, &fp).await?;
    match check {
        KeyCheck::Matches => {}
        KeyCheck::Untrusted if req.trust_any => {
            db::known_hosts::upsert(
                &state.db,
                &session.host,
                session.port,
                &alg,
                &format!("SHA256:{fp}"),
                &fp,
            )
            .await?;
        }
        KeyCheck::Untrusted => return Err(AppError::HostKeyUntrusted),
        KeyCheck::Mismatch {
            expected_sha256,
            actual_sha256,
        } if req.trust_any => {
            db::known_hosts::upsert(
                &state.db,
                &session.host,
                session.port,
                &alg,
                &format!("SHA256:{actual_sha256}"),
                &actual_sha256,
            )
            .await?;
            let _ = expected_sha256;
        }
        KeyCheck::Mismatch {
            expected_sha256,
            actual_sha256,
        } => {
            return Err(AppError::HostKeyMismatch {
                expected: expected_sha256,
                actual: actual_sha256,
            });
        }
    }

    // 4. Authenticate.
    // `authenticate` takes `auth_material` by value, so any `Zeroizing` wrapper
    // inside it runs at the end of that function call — our in-process copy of
    // the secret is erased before we proceed. (See SECURITY NOTE on
    // `AuthMaterial` about the non-zeroized russh-side copy.)
    let authed = authenticate(&mut handle, &session, auth_material).await?;
    if !authed {
        return Err(AppError::AuthFailed);
    }
    {
        let host = &session.host;
        let user = &session.username;
        let fingerprint = &fp;
        log_redacted!(info, "ssh.auth.ok",
            host = %host,
            user = %user,
            fingerprint = %fingerprint);
    }

    // 5. Open shell channel with PTY.
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| AppError::Ssh(e.to_string()))?;
    // Env vars must be sent AFTER channel open and BEFORE shell/exec per
    // RFC 4254 §6.4. `want_reply: false` so we don't block on a per-var
    // round-trip; most sshd configs reject unlisted vars via AcceptEnv
    // silently anyway, and a false positive here isn't worth the latency.
    for pair in &env_pairs {
        if let Err(e) = channel
            .set_env(false, pair.key.as_str(), pair.value.as_str())
            .await
        {
            // Don't fail the connect just because the server rejected an env
            // var — log and continue. The UI will surface this as info via
            // the tab status once observability grows beyond tracing.
            // Locals so the `_forbid_names` lint (which only accepts bare
            // idents after `%`) compiles — see log_redacted macro rules.
            let key = &pair.key;
            let err = e;
            log_redacted!(warn, "ssh.env.set_failed",
                key = %key,
                error = %err);
        }
    }
    channel
        .request_pty(
            false,
            "xterm-256color",
            req.cols as u32,
            req.rows as u32,
            0,
            0,
            &[],
        )
        .await
        .map_err(|e| AppError::Ssh(e.to_string()))?;
    // X11 forwarding negotiation happens *after* the PTY request and before
    // request_shell, per OpenSSH's behaviour. If VcXsrv isn't installed we
    // surface the install error now rather than letting the channel race
    // into the shell with DISPLAY set but no local server listening.
    if let Some(display) = x11_display {
        state.xserver.acquire(display).await?;
        let cookie = xserver::generate_cookie();
        if let Err(e) = channel
            .request_x11(false, false, "MIT-MAGIC-COOKIE-1", cookie, 0)
            .await
        {
            // Already acquired — release so we don't leak a ref.
            state.xserver.release(display).await;
            return Err(AppError::Ssh(format!("request_x11: {e}")));
        }
    }
    channel
        .request_shell(true)
        .await
        .map_err(|e| AppError::Ssh(e.to_string()))?;
    // Optional initial command — written as keystrokes into the shell's
    // stdin the same way the user would have typed them. We intentionally
    // avoid `channel_exec` here so the interactive shell stays alive after
    // the command runs (exec would close the channel on exit).
    if let Some(cmd) = session.initial_command.as_ref() {
        let trimmed = cmd.trim();
        if !trimmed.is_empty() {
            let line = format!("{trimmed}\n");
            if let Err(e) = channel.data(line.as_bytes()).await {
                let err = e;
                log_redacted!(warn, "ssh.initial_command.failed", error = %err);
            }
        }
    }

    // 6. Allocate connection id + mpsc + registry insert.
    let id = state.ssh.alloc_id();
    let (tx, rx) = mpsc::unbounded_channel::<ConnectionInput>();
    // Wrap the russh Handle in Arc<Mutex<..>> before ownership branches: the
    // driver task needs it for the Close-branch disconnect, and SFTP (Plan 3)
    // needs it to open a second session channel on demand.
    let handle_mutex = Arc::new(Mutex::new(handle));
    state
        .ssh
        .insert(Connection {
            id,
            host: session.host.clone(),
            port: session.port,
            user: session.username.clone(),
            stdin: tx,
            ssh_handle: handle_mutex.clone(),
            x11_display,
        })
        .await;

    // 7. Spawn driver.
    // Clone the two registry Arcs so the driver task can clean up its own
    // SFTP + SSH state in every exit branch (EOF / Close / ExitStatus / error).
    // Without this the `SftpRegistry` entry would outlive the transport and
    // `SftpHandle`s would leak until app shutdown (audit I-1).
    let ssh_reg = state.ssh.clone();
    let sftp_reg = state.sftp.clone();
    let xserver_reg = state.xserver.clone();
    tokio::spawn(drive_channel(
        app,
        id,
        handle_mutex,
        channel,
        rx,
        ssh_reg,
        sftp_reg,
        xserver_reg,
        x11_display,
    ));

    Ok(ConnectOutcome {
        connection_id: id,
        fingerprint_sha256: fp,
    })
}

/// SECURITY NOTE: `Zeroizing` only covers the bytes we own. russh 0.45 copies
/// the password into a `String` inside its auth `Msg` (see `russh/src/auth.rs`
/// for `Method::Password { password: String }`); that copy lives for the
/// connection lifetime and is not zeroized. If this matters, migrate to the
/// russh `keyboard-interactive` flow once upstream adds zeroizing wrappers.
/// Tracked as a follow-up (see repo issues).
///
/// We mitigate our own exposure by taking `AuthMaterial` into `authenticate`
/// by value and letting it drop at the end of that function, so our
/// `Zeroizing` wrapper runs as soon as russh is done with the reference.
enum AuthMaterial {
    Agent,
    Password(Zeroizing<Vec<u8>>),
    PrivateKey {
        pem: Zeroizing<Vec<u8>>,
        passphrase: Option<Zeroizing<Vec<u8>>>,
    },
}

async fn load_auth_material(
    state: &AppState,
    session: &db::sessions::Session,
) -> Result<(AuthMaterial, Option<String>)> {
    match session.auth_type.as_str() {
        "agent" => Ok((AuthMaterial::Agent, None)),
        "password" => {
            let cred_id = session
                .credential_id
                .ok_or_else(|| AppError::Validation("missing credential".into()))?;
            let row = db::credentials::get(&state.db, cred_id).await?;
            let vs = state.vault.read().await;
            let pt = vault::decrypt_with(&vs, &row.nonce, &row.ciphertext)?;
            Ok((
                AuthMaterial::Password(Zeroizing::new(pt)),
                Some(row.kind),
            ))
        }
        "key" => {
            let cred_id = session
                .credential_id
                .ok_or_else(|| AppError::Validation("missing credential".into()))?;
            let row = db::credentials::get(&state.db, cred_id).await?;
            let vs = state.vault.read().await;
            let pem = vault::decrypt_with(&vs, &row.nonce, &row.ciphertext)?;
            // Optional passphrase credential — stored as a separate row with
            // kind='key_passphrase' so a single stored passphrase can be reused
            // across multiple sessions that share the same private key.
            let passphrase = if let Some(pp_id) = session.key_passphrase_credential_id {
                let pp_row = db::credentials::get(&state.db, pp_id).await?;
                let pp = vault::decrypt_with(&vs, &pp_row.nonce, &pp_row.ciphertext)?;
                Some(Zeroizing::new(pp))
            } else {
                None
            };
            Ok((
                AuthMaterial::PrivateKey {
                    pem: Zeroizing::new(pem),
                    passphrase,
                },
                Some(row.kind),
            ))
        }
        other => Err(AppError::Validation(format!(
            "unknown auth_type: {other}"
        ))),
    }
}

async fn authenticate(
    handle: &mut Handle<ClientHandler>,
    session: &db::sessions::Session,
    mat: AuthMaterial,
) -> Result<bool> {
    match mat {
        AuthMaterial::Agent => {
            // Attempt to reach the user's SSH agent via SSH_AUTH_SOCK
            // (Unix) or the platform-specific default (Windows). Wrap in a
            // 30s timeout so an unresponsive agent socket (common after a
            // screen lock on macOS) doesn't pin a connect future forever.
            tokio::time::timeout(std::time::Duration::from_secs(30), async {
                let mut agent = russh_keys::agent::client::AgentClient::connect_env()
                    .await
                    .map_err(|e| AppError::Ssh(format!("ssh-agent: {e}")))?;
                let ids = agent
                    .request_identities()
                    .await
                    .map_err(|e| AppError::Ssh(e.to_string()))?;
                for id in ids {
                    let (a2, ok) = handle
                        .authenticate_future(session.username.clone(), id, agent)
                        .await;
                    agent = a2;
                    if ok.map_err(|e| AppError::Ssh(e.to_string()))? {
                        return Ok::<_, AppError>(true);
                    }
                }
                Ok(false)
            })
            .await
            .map_err(|_| AppError::Ssh("ssh-agent auth timeout".into()))?
        }
        AuthMaterial::Password(pw) => {
            let pw_str = std::str::from_utf8(&pw)
                .map_err(|_| AppError::Validation("non-utf8 password".into()))?;
            handle
                .authenticate_password(&session.username, pw_str)
                .await
                .map_err(|e| AppError::Ssh(e.to_string()))
        }
        AuthMaterial::PrivateKey { pem, passphrase } => {
            let pem_str = std::str::from_utf8(&pem)
                .map_err(|_| AppError::Validation("non-utf8 key".into()))?;
            let pp_str = passphrase
                .as_deref()
                .map(|b| {
                    std::str::from_utf8(b)
                        .map_err(|_| AppError::Validation("non-utf8 key passphrase".into()))
                })
                .transpose()?;
            let keypair = russh_keys::decode_secret_key(pem_str, pp_str)
                .map_err(|e| AppError::Ssh(format!("key parse: {e}")))?;
            handle
                .authenticate_publickey(&session.username, Arc::new(keypair))
                .await
                .map_err(|e| AppError::Ssh(e.to_string()))
        }
    }
}

async fn check_known_host(
    pool: &sqlx::SqlitePool,
    host: &str,
    port: i64,
    actual: &str,
) -> Result<KeyCheck> {
    let existing = db::known_hosts::get(pool, host, port).await?;
    Ok(match existing {
        None => KeyCheck::Untrusted,
        Some(row) if row.fingerprint_sha256 == actual => KeyCheck::Matches,
        Some(row) => KeyCheck::Mismatch {
            expected_sha256: row.fingerprint_sha256,
            actual_sha256: actual.to_string(),
        },
    })
}

async fn drive_channel(
    app: AppHandle,
    id: u64,
    handle: Arc<Mutex<Handle<ClientHandler>>>,
    mut channel: Channel<Msg>,
    mut rx: mpsc::UnboundedReceiver<ConnectionInput>,
    ssh_reg: Arc<ConnectionRegistry>,
    sftp_reg: Arc<SftpRegistry>,
    xserver_reg: Arc<XServerManager>,
    x11_display: Option<u8>,
) {
    let ev_data = format!("ssh:data:{id}");
    let ev_close = format!("ssh:close:{id}");
    let ev_error = format!("ssh:error:{id}");
    loop {
        tokio::select! {
            maybe_msg = channel.wait() => {
                match maybe_msg {
                    Some(russh::ChannelMsg::Data { data }) => {
                        let _ = app.emit(&ev_data, data.to_vec());
                    }
                    Some(russh::ChannelMsg::ExtendedData { data, .. }) => {
                        let _ = app.emit(&ev_data, data.to_vec());
                    }
                    Some(russh::ChannelMsg::ExitStatus { exit_status }) => {
                        let _ = app.emit(&ev_close, exit_status);
                        log_redacted!(info, "ssh.channel.closed", connection_id = id);
                        break;
                    }
                    Some(russh::ChannelMsg::Eof) | Some(russh::ChannelMsg::Close) | None => {
                        let _ = app.emit(&ev_close, serde_json::Value::Null);
                        log_redacted!(info, "ssh.channel.closed", connection_id = id);
                        break;
                    }
                    _ => {}
                }
            }
            cmd = rx.recv() => {
                match cmd {
                    Some(ConnectionInput::Bytes(bytes)) => {
                        // Channel::data takes an AsyncRead; &[u8] implements AsyncRead.
                        if let Err(e) = channel.data(&bytes[..]).await {
                            let _ = app.emit(&ev_error, e.to_string());
                        }
                    }
                    Some(ConnectionInput::Resize { cols, rows }) => {
                        let _ = channel.window_change(cols as u32, rows as u32, 0, 0).await;
                    }
                    Some(ConnectionInput::Close) | None => {
                        let _ = channel.eof().await;
                        let _ = handle
                            .lock()
                            .await
                            .disconnect(russh::Disconnect::ByApplication, "closed by user", "en")
                            .await;
                        let _ = app.emit(&ev_close, serde_json::Value::Null);
                        log_redacted!(info, "ssh.channel.closed", connection_id = id);
                        break;
                    }
                }
            }
        }
    }

    // Connection teardown: drop SFTP state first (so any cached `SftpHandle`
    // is released before the underlying russh transport is gone), then the
    // SSH registry entry. `ConnectionRegistry::close` is idempotent — calling
    // it here after a user-initiated `ConnectionInput::Close` (which landed
    // via `AppState::close_connection`) is a harmless no-op. (audit I-1)
    sftp_reg.remove(id).await;
    ssh_reg.close(id).await;
    // Release the X server ref so the VcXsrv process exits when no other
    // sessions are using it.
    if let Some(display) = x11_display {
        xserver_reg.release(display).await;
    }
}
