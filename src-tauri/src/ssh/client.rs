use std::sync::{Arc, Mutex as StdMutex};

use russh::client::{self, Config, Handle, Msg};
use russh::keys::agent::client::AgentClient;
use russh::keys::agent::AgentIdentity;
use russh::keys::{decode_secret_key, ssh_key, PrivateKeyWithHashAlg};
use russh::Channel;
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
    /// If true, force X11 forwarding off for this connect even if the
    /// session row has `forward_x11 = 1`. Used by the "Continue without
    /// X11" button in the VcXsrv-missing dialog so the user can reach
    /// the host right now without editing the session.
    pub disable_x11: bool,
}

pub struct ConnectOutcome {
    pub connection_id: u64,
    pub fingerprint_sha256: String,
}

pub struct ClientHandler {
    /// (algorithm_name, sha256_fingerprint) captured from the server's host key.
    /// `ssh_key::PublicKey::algorithm().as_str()` returns the SSH wire name
    /// (e.g. "ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256").
    ///
    /// Uses `std::sync::Mutex` (not tokio's) because the handler only ever
    /// writes a tiny value and never holds the lock across an await —
    /// tokio's async mutex would propagate a `&Mutex` borrow through the
    /// returned future and trip russh 0.60's HRTB `Send` check.
    server_key: Arc<StdMutex<Option<(String, String)>>>,
    /// Display number to pipe forwarded X11 channels to (always the same
    /// display the connect flow acquired on — default :0). `None` disables
    /// X11 forwarding handling; `server_channel_open_x11` drops the channel.
    x11_display: Option<u8>,
    /// Shared dispatch table for inbound `forwarded-tcpip` channels.
    /// Populated by `ssh::forwards::remote::start` when a `-R` forward
    /// is created; the callback below looks up `(bind_addr, bind_port)`
    /// and shoves the inbound russh channel onto the matching sender.
    /// Same `Arc` is held on the owning `Connection`'s `Forwards` so
    /// the russh callback never has to reach back through `AppState`.
    forwarded_tcpip_dispatch: std::sync::Arc<tokio::sync::RwLock<
        std::collections::HashMap<(String, u32), tokio::sync::mpsc::Sender<russh::Channel<Msg>>>
    >>,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &ssh_key::PublicKey,
    ) -> std::result::Result<bool, Self::Error> {
        // `to_bytes()` encodes the `KeyData` into the SSH-wire public-key
        // blob — same bytes we fingerprint in `fingerprint_sha256`, so
        // existing `known_hosts` rows stay valid.
        let blob = server_public_key.to_bytes()?;
        let fp = fingerprint_sha256(&blob);
        let alg = server_public_key.algorithm().as_str().to_string();
        *self.server_key.lock().expect("server_key poisoned") = Some((alg, fp));
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

    /// Server is forwarding a TCP connection back to us on a port we
    /// previously requested via `tcpip_forward` (a Remote forward).
    /// Route the channel to the right forward task; drop it (russh
    /// closes server-side) if the forward has since been cancelled.
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        _session: &mut client::Session,
    ) -> std::result::Result<(), Self::Error> {
        let key = (connected_address.to_string(), connected_port);
        let tx = {
            let map = self.forwarded_tcpip_dispatch.read().await;
            map.get(&key).cloned()
        };
        if let Some(tx) = tx {
            // try_send so we never block russh's event loop. If the
            // forward task is wedged, drop the channel — pragmatic
            // backpressure for what should be a low-volume inflow.
            let _ = tx.try_send(channel);
        }
        Ok(())
    }
}

/// Owned handles extracted from `AppState` so `connect` doesn't have to
/// carry `&AppState` across awaits — otherwise russh 0.60's native-async
/// `Handler` trait composition produces an HRTB `Send` failure on
/// `&Pool<Sqlite>` at the `#[tauri::command]` boundary. All fields are
/// cheap to clone (Arcs or `Pool` which is Arc-based internally).
pub struct ConnectDeps {
    pub db: sqlx::SqlitePool,
    pub vault: Arc<tokio::sync::RwLock<vault::VaultState>>,
    pub ssh: Arc<ConnectionRegistry>,
    pub sftp: Arc<SftpRegistry>,
    pub xserver: Arc<XServerManager>,
}

impl ConnectDeps {
    pub fn from_state(s: &AppState) -> Self {
        Self {
            db: s.db.clone(),
            vault: s.vault.clone(),
            ssh: s.ssh.clone(),
            sftp: s.sftp.clone(),
            xserver: s.xserver.clone(),
        }
    }
}

/// Perform a full connect: resolve session, decrypt credential if needed,
/// open SSH, authenticate, open shell channel with PTY, register with
/// ConnectionRegistry, and spawn reader/writer tasks that bridge russh ↔ Tauri
/// events. Returns ConnectOutcome with the allocated connection_id on success.
///
/// The returned future is boxed as `Pin<Box<dyn Future + Send>>` to erase
/// the concrete future type at the crate boundary. russh 0.60's
/// native-async `Handler` trait composes inner futures in a way the
/// compiler's trait solver can't prove `Send` under HRTB — boxing the
/// outer future short-circuits that chain.
pub fn connect(
    deps: ConnectDeps,
    app: AppHandle,
    req: ConnectRequest,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<ConnectOutcome>> + Send>> {
    Box::pin(connect_impl(deps, app, req))
}

async fn connect_impl(
    deps: ConnectDeps,
    app: AppHandle,
    req: ConnectRequest,
) -> Result<ConnectOutcome> {
    // 1. Resolve saved session + load (possibly) encrypted credential.
    let session = db::sessions::get(&deps.db, req.session_id).await?;
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
    let (auth_material, _cred_kind) = load_auth_material(&deps, &session).await?;
    let env_pairs = db::sessions::env_get(&deps.db, req.session_id).await?;

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
    let server_key = Arc::new(StdMutex::new(None));
    // Handler's x11_display is set when the session's forward_x11 flag is
    // on — the async `channel_open_x11` callback reads it to route incoming
    // X11 channels to the correct VcXsrv display.
    let x11_display: Option<u8> = if session.forward_x11 != 0 && !req.disable_x11 {
        Some(xserver::DEFAULT_DISPLAY)
    } else {
        None
    };
    // Shared dispatch table for Remote forwards. Same `Arc` lives on
    // both the handler (read by the russh callback) and on the
    // `Connection.forwards.dispatch` (written by `remote::start` /
    // `remote::stop`). No lock contention between the two — writes only
    // happen from forward setup/teardown; reads only from the callback.
    let forwarded_tcpip_dispatch: Arc<tokio::sync::RwLock<
        std::collections::HashMap<(String, u32), tokio::sync::mpsc::Sender<russh::Channel<Msg>>>,
    >> = Arc::new(tokio::sync::RwLock::new(std::collections::HashMap::new()));
    let handler = ClientHandler {
        server_key: server_key.clone(),
        x11_display,
        forwarded_tcpip_dispatch: forwarded_tcpip_dispatch.clone(),
    };
    // russh's `client::connect` has no built-in deadline, so we bound the
    // whole handshake (TCP + KEX + host-key) with the user-configured
    // connect_timeout_secs. Exceeding it maps to AppError::Ssh("connect
    // timeout") — distinct from AuthFailed so the UI can surface it plainly.
    // Clone host into an owned `String` so the address tuple doesn't borrow
    // from `session` across the connect await — capturing `&str` there trips
    // the `for<'a> &'a str: Send` HRTB check on russh 0.60.
    let host_owned = session.host.clone();
    let connect_fut = client::connect(
        config,
        (host_owned, session.port as u16),
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
        .expect("server_key poisoned")
        .clone()
        .ok_or_else(|| AppError::Ssh("no host key".into()))?;
    let check = check_known_host(&deps.db, &session.host, session.port, &fp).await?;
    match check {
        KeyCheck::Matches => {}
        KeyCheck::Untrusted if req.trust_any => {
            db::known_hosts::upsert(
                &deps.db,
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
                &deps.db,
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
        deps.xserver.acquire(display).await?;
        let cookie = xserver::generate_cookie();
        if let Err(e) = channel
            .request_x11(false, false, "MIT-MAGIC-COOKIE-1", cookie, 0)
            .await
        {
            // Already acquired — release so we don't leak a ref.
            deps.xserver.release(display).await;
            return Err(AppError::Ssh(format!("request_x11: {e}")));
        }
    }
    channel
        .request_shell(true)
        .await
        .map_err(|e| AppError::Ssh(e.to_string()))?;
    // Optional starting directory — written before `initial_command` so the
    // command runs in the right place. Same rationale as initial_command for
    // using the shell channel rather than `channel_exec`: we need the
    // interactive shell to stay alive. Tilde-prefixed paths go through raw
    // so bash expansion still works; everything else is double-quoted.
    if let Some(raw) = session.starting_dir.as_ref() {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            let line = format!("cd {}\n", format_cd_target(trimmed));
            if let Err(e) = channel.data(line.as_bytes()).await {
                let err = e;
                log_redacted!(warn, "ssh.starting_dir.failed", error = %err);
            }
        }
    }
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
    let id = deps.ssh.alloc_id();
    let (tx, rx) = mpsc::unbounded_channel::<ConnectionInput>();
    // Wrap the russh Handle in Arc<Mutex<..>> before ownership branches: the
    // driver task needs it for the Close-branch disconnect, and SFTP (Plan 3)
    // needs it to open a second session channel on demand.
    let handle_mutex = Arc::new(Mutex::new(handle));
    let forwards = Arc::new(crate::ssh::forwards::Forwards::with_dispatch(
        forwarded_tcpip_dispatch.clone(),
    ));
    deps.ssh
        .insert(Connection {
            id,
            host: session.host.clone(),
            port: session.port,
            user: session.username.clone(),
            stdin: tx,
            ssh_handle: handle_mutex.clone(),
            x11_display,
            forwards,
        })
        .await;

    // 7. Spawn driver.
    // Clone the two registry Arcs so the driver task can clean up its own
    // SFTP + SSH state in every exit branch (EOF / Close / ExitStatus / error).
    // Without this the `SftpRegistry` entry would outlive the transport and
    // `SftpHandle`s would leak until app shutdown (audit I-1).
    let ssh_reg = deps.ssh.clone();
    let sftp_reg = deps.sftp.clone();
    let xserver_reg = deps.xserver.clone();
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

/// SECURITY NOTE: `Zeroizing` only covers the bytes we own. russh copies the
/// password into a `String` inside its auth `Msg` (see `russh/src/auth.rs`
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
    deps: &ConnectDeps,
    session: &db::sessions::Session,
) -> Result<(AuthMaterial, Option<String>)> {
    match session.auth_type.as_str() {
        "agent" => Ok((AuthMaterial::Agent, None)),
        "password" => {
            let cred_id = session
                .credential_id
                .ok_or_else(|| AppError::Validation("missing credential".into()))?;
            let row = db::credentials::get(&deps.db, cred_id).await?;
            let vs = deps.vault.read().await;
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
            let row = db::credentials::get(&deps.db, cred_id).await?;
            let vs = deps.vault.read().await;
            let pem = vault::decrypt_with(&vs, &row.nonce, &row.ciphertext)?;
            // Optional passphrase credential — stored as a separate row with
            // kind='key_passphrase' so a single stored passphrase can be reused
            // across multiple sessions that share the same private key.
            let passphrase = if let Some(pp_id) = session.key_passphrase_credential_id {
                let pp_row = db::credentials::get(&deps.db, pp_id).await?;
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
            // Attempt to reach the user's SSH agent. Wrap in a 30s timeout
            // so an unresponsive agent (e.g. OpenSSH-for-Windows named pipe
            // that has entered a bad state) doesn't pin a connect future
            // forever. `authenticate_publickey_with` sends a SIGN_REQUEST
            // to the agent via the `Signer` trait; only `AgentIdentity::PublicKey`
            // is wired here — OpenSSH certificates are a v0.2 follow-up.
            tokio::time::timeout(std::time::Duration::from_secs(30), async {
                let mut agent = connect_ssh_agent()
                    .await
                    .map_err(|e| AppError::Ssh(format!("ssh-agent: {e}")))?;
                let ids = agent
                    .request_identities()
                    .await
                    .map_err(|e| AppError::Ssh(e.to_string()))?;
                let rsa_hash = handle
                    .best_supported_rsa_hash()
                    .await
                    .ok()
                    .flatten()
                    .flatten();
                for id in ids {
                    let AgentIdentity::PublicKey { key, .. } = id else {
                        continue;
                    };
                    let res = handle
                        .authenticate_publickey_with(
                            session.username.clone(),
                            key,
                            rsa_hash,
                            &mut agent,
                        )
                        .await
                        .map_err(|e| AppError::Ssh(e.to_string()))?;
                    if res.success() {
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
            let res = handle
                .authenticate_password(&session.username, pw_str)
                .await
                .map_err(|e| AppError::Ssh(e.to_string()))?;
            Ok(res.success())
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
            let keypair = decode_secret_key(pem_str, pp_str)
                .map_err(|e| AppError::Ssh(format!("key parse: {e}")))?;
            // `PrivateKeyWithHashAlg` is RSA-only; `new` ignores `hash_alg`
            // for non-RSA keys, so passing the server's preferred RSA hash
            // unconditionally is safe and correct.
            let rsa_hash = handle
                .best_supported_rsa_hash()
                .await
                .ok()
                .flatten()
                .flatten();
            let key = PrivateKeyWithHashAlg::new(Arc::new(keypair), rsa_hash);
            let res = handle
                .authenticate_publickey(&session.username, key)
                .await
                .map_err(|e| AppError::Ssh(e.to_string()))?;
            Ok(res.success())
        }
    }
}

/// Platform-specific SSH agent connect. Returns a concrete `AgentClient`
/// type (not a type-erased one) — `russh::auth::Signer::auth_sign`
/// returns an `impl Future` whose `Send` bound the compiler can only
/// prove when the stream type is concrete. A `Box<dyn AgentStream + Send>`
/// trips an HRTB `Send` check at the `authenticate_publickey_with` call
/// site. On Windows we prefer the OpenSSH-for-Windows named pipe
/// (`\\.\pipe\openssh-ssh-agent`); Pageant support is a follow-up.
#[cfg(windows)]
async fn connect_ssh_agent(
) -> std::result::Result<AgentClient<tokio::net::windows::named_pipe::NamedPipeClient>, russh::keys::Error> {
    AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await
}

#[cfg(unix)]
async fn connect_ssh_agent(
) -> std::result::Result<AgentClient<tokio::net::UnixStream>, russh::keys::Error> {
    AgentClient::connect_env().await
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

/// Format a user-supplied path for use as the argument to `cd` in a POSIX
/// shell. Tilde-prefixed paths (`~`, `~/foo`, `~user/foo`) are emitted raw
/// so bash/zsh tilde expansion still kicks in; everything else is
/// double-quoted with the metacharacters that have special meaning inside
/// double quotes (`\`, `"`, `$`, `` ` ``) backslash-escaped. This makes a
/// bare path with spaces work (`/var/log my dir` → `"/var/log my dir"`)
/// without silently breaking on `$HOME` expansion inside user-typed values.
fn format_cd_target(raw: &str) -> String {
    if raw.starts_with('~') {
        return raw.to_string();
    }
    let mut out = String::with_capacity(raw.len() + 2);
    out.push('"');
    for ch in raw.chars() {
        if matches!(ch, '\\' | '"' | '$' | '`') {
            out.push('\\');
        }
        out.push(ch);
    }
    out.push('"');
    out
}

#[cfg(test)]
mod cd_target_tests {
    use super::format_cd_target;

    #[test]
    fn tilde_passes_through_raw() {
        assert_eq!(format_cd_target("~"), "~");
        assert_eq!(format_cd_target("~/projects"), "~/projects");
        assert_eq!(format_cd_target("~root/logs"), "~root/logs");
    }

    #[test]
    fn bare_path_is_quoted() {
        assert_eq!(format_cd_target("/var/log"), "\"/var/log\"");
        assert_eq!(
            format_cd_target("/path with spaces"),
            "\"/path with spaces\""
        );
    }

    #[test]
    fn metachars_are_escaped() {
        assert_eq!(format_cd_target("/a$b"), "\"/a\\$b\"");
        assert_eq!(format_cd_target("/a\"b"), "\"/a\\\"b\"");
        assert_eq!(format_cd_target("/a\\b"), "\"/a\\\\b\"");
        assert_eq!(format_cd_target("/a`b"), "\"/a\\`b\"");
    }
}
