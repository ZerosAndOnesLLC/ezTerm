use serde::Serialize;

pub type Result<T, E = AppError> = std::result::Result<T, E>;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),

    #[error("migration error: {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),

    #[error("vault is locked")]
    VaultLocked,

    #[error("vault already initialized")]
    VaultAlreadyInitialized,

    #[error("incorrect master password")]
    BadPassword,

    #[error("cryptography error")]
    Crypto,

    #[error("not found")]
    NotFound,

    #[error("validation: {0}")]
    Validation(String),

    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("serde: {0}")]
    Serde(#[from] serde_json::Error),

    #[error("ssh: {0}")]
    Ssh(String),

    #[error("authentication failed")]
    AuthFailed,

    #[error("host key mismatch (expected {expected}, got {actual})")]
    HostKeyMismatch { expected: String, actual: String },

    #[error("host key not yet trusted")]
    HostKeyUntrusted,

    #[error("channel closed")]
    // emitted when explicit channel-close logic lands; Plan 3 or later
    #[allow(dead_code)]
    ChannelClosed,
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        let mut obj = serde_json::Map::new();
        obj.insert("code".into(), serde_json::Value::String(code_for(self).into()));
        obj.insert("message".into(), serde_json::Value::String(self.to_string()));
        if let AppError::HostKeyMismatch { expected, actual } = self {
            obj.insert("expected".into(), serde_json::Value::String(expected.clone()));
            obj.insert("actual".into(), serde_json::Value::String(actual.clone()));
        }
        serde_json::Value::Object(obj).serialize(s)
    }
}

fn code_for(e: &AppError) -> &'static str {
    match e {
        AppError::Db(_) => "db",
        AppError::Migrate(_) => "migrate",
        AppError::VaultLocked => "vault_locked",
        AppError::VaultAlreadyInitialized => "vault_already_initialized",
        AppError::BadPassword => "bad_password",
        AppError::Crypto => "crypto",
        AppError::NotFound => "not_found",
        AppError::Validation(_) => "validation",
        AppError::Io(_) => "io",
        AppError::Serde(_) => "serde",
        AppError::Ssh(_) => "ssh",
        AppError::AuthFailed => "auth_failed",
        AppError::HostKeyMismatch { .. } => "host_key_mismatch",
        AppError::HostKeyUntrusted => "host_key_untrusted",
        AppError::ChannelClosed => "channel_closed",
    }
}

impl From<russh::Error> for AppError {
    fn from(e: russh::Error) -> Self {
        AppError::Ssh(e.to_string())
    }
}
