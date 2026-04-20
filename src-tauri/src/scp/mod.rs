// Minimal SCP surface for v0.3: we don't implement the SCP file-transfer
// protocol yet. Commands in `crate::commands::scp` are stubs that return an
// actionable `AppError::Scp` message telling the caller to use the SFTP pane
// instead. A follow-up issue will add a real exec-channel SCP implementation.
