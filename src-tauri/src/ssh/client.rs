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
use crate::ssh::known_hosts::{fingerprint_sha256, KeyCheck};
use crate::ssh::registry::{Connection, ConnectionInput};
use crate::state::AppState;
use crate::vault;

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

struct ClientHandler {
    server_key_fp: Arc<Mutex<Option<String>>>,
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
        *self.server_key_fp.lock().await = Some(fp);
        // We accept here and verify against known_hosts in connect() after
        // the handshake completes. Rejecting here would give the user no
        // TOFU prompt path.
        Ok(true)
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

    // 2. Configure russh client.
    let config = Arc::new(Config::default());
    let server_key_fp = Arc::new(Mutex::new(None));
    let handler = ClientHandler {
        server_key_fp: server_key_fp.clone(),
    };
    let mut handle = client::connect(
        config,
        (session.host.as_str(), session.port as u16),
        handler,
    )
    .await
    .map_err(|e| AppError::Ssh(format!("connect: {e}")))?;

    // 3. Host-key TOFU check.
    let fp = server_key_fp
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
                "sha256",
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
                "sha256",
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
    channel
        .request_shell(true)
        .await
        .map_err(|e| AppError::Ssh(e.to_string()))?;

    // 6. Allocate connection id + mpsc + registry insert.
    let id = state.ssh.alloc_id();
    let (tx, rx) = mpsc::unbounded_channel::<ConnectionInput>();
    state
        .ssh
        .insert(Connection {
            id,
            host: session.host.clone(),
            port: session.port,
            user: session.username.clone(),
            stdin: tx,
        })
        .await;

    // 7. Spawn driver.
    tokio::spawn(drive_channel(app, id, handle, channel, rx));

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
        #[allow(dead_code)]
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
            let pt = vault::decrypt_with(&vs, &row.nonce, &row.ciphertext)?;
            // We don't implement per-key passphrase lookup here in v0.1; if the
            // key is passphrase-protected, the user must decrypt it beforehand.
            Ok((
                AuthMaterial::PrivateKey {
                    pem: Zeroizing::new(pt),
                    passphrase: None,
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
            // (Unix) or the platform-specific default (Windows).
            let mut agent = match russh_keys::agent::client::AgentClient::connect_env().await {
                Ok(a) => a,
                Err(e) => return Err(AppError::Ssh(format!("ssh-agent: {e}"))),
            };
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
                    return Ok(true);
                }
            }
            Ok(false)
        }
        AuthMaterial::Password(pw) => {
            let pw_str = std::str::from_utf8(&pw)
                .map_err(|_| AppError::Validation("non-utf8 password".into()))?;
            handle
                .authenticate_password(&session.username, pw_str)
                .await
                .map_err(|e| AppError::Ssh(e.to_string()))
        }
        AuthMaterial::PrivateKey { pem, passphrase: _ } => {
            let keypair = russh_keys::decode_secret_key(
                std::str::from_utf8(&pem)
                    .map_err(|_| AppError::Validation("non-utf8 key".into()))?,
                None,
            )
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
    handle: Handle<ClientHandler>,
    mut channel: Channel<Msg>,
    mut rx: mpsc::UnboundedReceiver<ConnectionInput>,
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
}
