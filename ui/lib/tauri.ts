import { invoke } from '@tauri-apps/api/core';
import type {
  Folder, Session, SessionInput, CredentialMeta, CredentialKind, VaultStatus,
} from './types';

export const api = {
  // Vault
  vaultStatus: () => invoke<VaultStatus>('vault_status'),
  vaultInit:   (password: string) => invoke<void>('vault_init', { password }),
  vaultUnlock: (password: string) => invoke<void>('vault_unlock', { password }),
  vaultLock:   () => invoke<void>('vault_lock'),

  // Folders
  folderList:   () => invoke<Folder[]>('folder_list'),
  folderCreate: (parentId: number | null, name: string) =>
    invoke<Folder>('folder_create', { parentId, name }),
  folderRename: (id: number, name: string) => invoke<void>('folder_rename', { id, name }),
  folderDelete: (id: number) => invoke<void>('folder_delete', { id }),
  folderMove:   (id: number, parentId: number | null, sort: number) =>
    invoke<void>('folder_move', { id, parentId, sort }),

  // Sessions
  sessionList:      () => invoke<Session[]>('session_list'),
  sessionGet:       (id: number) => invoke<Session>('session_get', { id }),
  sessionCreate:    (input: SessionInput) => invoke<Session>('session_create', { input }),
  sessionUpdate:    (id: number, input: SessionInput) => invoke<Session>('session_update', { id, input }),
  sessionDelete:    (id: number) => invoke<void>('session_delete', { id }),
  sessionDuplicate: (id: number) => invoke<Session>('session_duplicate', { id }),

  // Credentials
  credentialList:   () => invoke<CredentialMeta[]>('credential_list'),
  credentialCreate: (kind: CredentialKind, label: string, plaintext: string) =>
    invoke<CredentialMeta>('credential_create', { kind, label, plaintext }),
  credentialDelete: (id: number) => invoke<void>('credential_delete', { id }),

  // Settings
  settingsGet: (key: string) => invoke<string | null>('settings_get', { key }),
  settingsSet: (key: string, value: string) => invoke<void>('settings_set', { key, value }),
};
