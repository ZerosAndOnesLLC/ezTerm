export type AuthType = 'password' | 'key' | 'agent';
export type CredentialKind = 'password' | 'private_key' | 'key_passphrase';
export type VaultStatus = 'uninitialized' | 'locked' | 'unlocked';
/** 'ssh' is a remote SSH session (full host/port/auth semantics).
 *  'wsl' launches `wsl.exe -d <host>` with `username` as the optional
 *       WSL user (empty = distro default user).
 *  'local' launches a local shell — `host` is the program short-name
 *       ('cmd' | 'pwsh' | 'powershell') or an absolute path, and
 *       `username` is the optional starting directory. */
export type SessionKind = 'ssh' | 'wsl' | 'local';

export interface Folder {
  id: number;
  parent_id: number | null;
  name: string;
  sort: number;
}

export type CursorStyle = 'block' | 'bar' | 'underline';

export interface EnvPair {
  key: string;
  value: string;
}

export interface Session {
  id: number;
  folder_id: number | null;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_type: AuthType;
  credential_id: number | null;
  key_passphrase_credential_id: number | null;
  color: string | null;
  sort: number;
  initial_command: string | null;
  scrollback_lines: number;
  font_size: number;
  /** CSS font-family string. Empty string means "use the app default
   *  stack" (Cascadia Mono + fallbacks, see lib/xterm.ts). */
  font_family: string;
  cursor_style: CursorStyle;
  compression: number; // 0 | 1
  keepalive_secs: number;
  connect_timeout_secs: number;
  session_kind: SessionKind;
  /** 0/1 — SSH-only. Enables X11 forwarding against the bundled VcXsrv. */
  forward_x11: number;
  /** Optional starting directory. WSL: passed as `wsl.exe --cd <value>`,
   *  empty = `~` (Linux home). SSH: `cd <value>` is written to the shell
   *  after connect, empty = remote default ($HOME). Ignored for local
   *  (cmd/pwsh) rows. */
  starting_dir: string | null;
}

export interface SessionInput {
  folder_id: number | null;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_type: AuthType;
  credential_id: number | null;
  key_passphrase_credential_id: number | null;
  color: string | null;
  initial_command: string | null;
  scrollback_lines: number;
  font_size: number;
  font_family: string;
  cursor_style: CursorStyle;
  compression: number;
  keepalive_secs: number;
  connect_timeout_secs: number;
  env: EnvPair[];
  session_kind: SessionKind;
  forward_x11: number;
  starting_dir: string | null;
}

export interface XServerStatus {
  installed:        boolean;
  install_path:     string | null;
  running_displays: number[];
}

/** Build target reported by the backend. Used to branch behavior in
 *  the UI without pulling in tauri-plugin-os. */
export type Platform = 'windows' | 'macos' | 'linux' | 'other';

/** A shell the backend found on this host. `display_name` is the
 *  human-readable label (basename on Unix, short id on Windows);
 *  `program` is what gets stored in `Session.host` and handed back to
 *  the spawn command. */
export interface DetectedShell {
  display_name: string;
  program:      string;
}

// --- Backup / restore -----------------------------------------------------

export interface BackupSummary {
  folders:      number;
  sessions:     number;
  credentials:  number;
  known_hosts:  number;
  settings:     number;
}

export interface BackupPreview {
  created_at:    string;
  app_version:   string;
  folders:       Folder[];
  sessions:      BackupSessionPreview[];
  credentials:   BackupCredentialPreview[];
  known_hosts:   BackupKnownHostPreview[];
  setting_count: number;
}

export interface BackupSessionPreview {
  id:            number;
  folder_id:     number | null;
  name:          string;
  host:          string;
  port:          number;
  username:      string;
  session_kind:  SessionKind;
  auth_type:     AuthType;
  credential_id: number | null;
}

export interface BackupCredentialPreview {
  id:    number;
  kind:  CredentialKind;
  label: string;
}

export interface BackupKnownHostPreview {
  host: string;
  port: number;
  fingerprint_sha256: string;
}

export interface BackupSelection {
  folder_ids:       number[];
  session_ids:      number[];
  credential_ids:   number[];
  /** [host, port] pairs. */
  known_hosts:      [string, number][];
  include_settings: boolean;
}

export interface RestoreSummary {
  folders_created:      number;
  sessions_created:     number;
  credentials_created:  number;
  known_hosts_upserted: number;
  settings_applied:     number;
  renamed:              string[];
}

// --- Cloud sync (phase 1 = local folder) ---------------------------------

export type SyncKind = 'none' | 'local' | 's3';

export interface SyncStatus {
  kind:               SyncKind;
  local_path:         string | null;
  s3_endpoint:        string | null;
  s3_bucket:          string | null;
  s3_prefix:          string | null;
  s3_region:          string | null;
  s3_access_key_id:   string | null;
  s3_last_etag:       string | null;
  last_success_at:    string | null;
  last_error:         string | null;
  pending:            boolean;
}

export interface S3ConfigInput {
  endpoint:          string;
  region:            string;
  bucket:            string;
  prefix:            string;
  access_key_id:     string;
  secret_access_key: string;
  passphrase:        string;
}

export interface CredentialMeta {
  id: number;
  kind: CredentialKind;
  label: string;
}

export interface AppErrorPayload {
  code: string;
  message: string;
}

export interface ConnectResult {
  connection_id: number;
  fingerprint_sha256: string;
}

export interface KnownHost {
  host: string;
  port: number;
  key_type: string;
  fingerprint: string;
  fingerprint_sha256: string;
  first_seen: string;
}

export interface HostKeyMismatchError {
  code: 'host_key_mismatch';
  message: string;
  expected: string;
  actual: string;
}

export interface SftpEntry {
  name: string;
  full_path: string;
  is_dir: boolean;
  is_symlink: boolean;
  size: number;
  mtime_unix: number;
  mode: number;
}

export interface TransferProgress {
  transfer_id: number;
  bytes_sent: number;
  total_bytes: number;
  done: boolean;
  error: string | null;
}

export interface TransferTicket {
  transfer_id: number;
}

// --- MobaXterm import -----------------------------------------------------

export interface ParsedMobaSession {
  folder_path: string[];
  name: string;
  /** 'ssh' for type-0 rows, 'wsl' for type-14 rows. */
  session_kind: 'ssh' | 'wsl';
  host: string;
  port: number;
  username: string;
  /** SSH-only: 'key' if source referenced a key file, else 'password'.
   *  WSL rows always have 'agent'. */
  auth_type: 'key' | 'password' | 'agent';
  /** Raw MobaXterm-style path to the private key file, or null. */
  private_key_path: string | null;
}

export interface MobaImportPreview {
  sessions: ParsedMobaSession[];
  skipped_non_ssh: number;
  skipped_malformed: number;
  /** Folder paths to create, deduped and ordered shallowest-first. */
  new_folder_paths: string[][];
  /** Indices into `sessions` that would collide with existing rows. */
  duplicate_indices: number[];
}

export type MobaDuplicateStrategy = 'skip' | 'overwrite' | 'rename';

export interface MobaImportResult {
  created: number;
  updated: number;
  skipped_duplicate: number;
  created_folders: number;
  /** Labels of private_key credentials created from key files on disk. */
  imported_keys: string[];
  /** Raw MobaXterm key paths we couldn't read — session imported without credential. */
  missing_keys: string[];
}
