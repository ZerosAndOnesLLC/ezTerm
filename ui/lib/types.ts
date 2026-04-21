export type AuthType = 'password' | 'key' | 'agent';
export type CredentialKind = 'password' | 'private_key' | 'key_passphrase';
export type VaultStatus = 'uninitialized' | 'locked' | 'unlocked';

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
  cursor_style: CursorStyle;
  compression: number; // 0 | 1
  keepalive_secs: number;
  connect_timeout_secs: number;
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
  cursor_style: CursorStyle;
  compression: number;
  keepalive_secs: number;
  connect_timeout_secs: number;
  env: EnvPair[];
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
  host: string;
  port: number;
  username: string;
  /** 'key' when the source row referenced a private-key file, else 'password'. */
  auth_type: 'key' | 'password';
  /** Raw MobaXterm-style path to the private key file, or null for password rows. */
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
