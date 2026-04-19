export type AuthType = 'password' | 'key' | 'agent';
export type CredentialKind = 'password' | 'private_key' | 'key_passphrase';
export type VaultStatus = 'uninitialized' | 'locked' | 'unlocked';

export interface Folder {
  id: number;
  parent_id: number | null;
  name: string;
  sort: number;
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
  color: string | null;
  sort: number;
}

export interface SessionInput {
  folder_id: number | null;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_type: AuthType;
  credential_id: number | null;
  color: string | null;
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
