import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  Folder, Session, SessionInput, CredentialMeta, CredentialKind, VaultStatus,
  AppErrorPayload, ConnectResult, KnownHost, SftpEntry, TransferTicket, EnvPair,
  MobaImportPreview, MobaImportResult, MobaDuplicateStrategy, ParsedMobaSession,
  XServerStatus,
  Platform, DetectedShell,
  Forward, ForwardInput, RuntimeForward, ForwardStartTarget,
  BackupSummary, BackupPreview, BackupSelection, RestoreSummary,
  SyncStatus, S3ConfigInput,
} from './types';

export function errMessage(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'message' in e) {
    return String((e as AppErrorPayload).message);
  }
  return String(e);
}

export const api = {
  // Vault
  vaultStatus: () => invoke<VaultStatus>('vault_status'),
  vaultInit:   (password: string) => invoke<void>('vault_init', { password }),
  vaultUnlock: (password: string) => invoke<void>('vault_unlock', { password }),
  vaultLock:   () => invoke<void>('vault_lock'),
  vaultVerifyPassword: (password: string) =>
    invoke<boolean>('vault_verify_password', { password }),
  vaultChangePassword: (oldPassword: string, newPassword: string) =>
    invoke<{ snapshot_path: string }>('vault_change_password', { oldPassword, newPassword }),
  vaultRecoveryStatus: () =>
    invoke<{ provisioned: boolean }>('vault_recovery_status'),
  /** Generates a new recovery code, requires master-password re-verify.
   *  snapshot_path is non-null when a prior recovery code was being
   *  overwritten (the backend takes a snapshot first). */
  vaultGenerateRecoveryCode: (password: string) =>
    invoke<{ code: string; snapshot_path: string | null }>(
      'vault_generate_recovery_code',
      { password },
    ),
  vaultUnlockWithRecovery: (code: string) =>
    invoke<void>('vault_unlock_with_recovery', { code }),
  /** Destructive — wipes all vault-encrypted data. Server validates
   *  the sentinel "DELETE-MY-VAULT"; the UI maps the user's typed
   *  "DELETE" to this value on submit. */
  vaultReset: () =>
    invoke<{ snapshot_path: string }>('vault_reset', {
      confirmation: 'DELETE-MY-VAULT',
    }),

  // Folders
  folderList:   () => invoke<Folder[]>('folder_list'),
  folderCreate: (parentId: number | null, name: string) =>
    invoke<Folder>('folder_create', { parentId, name }),
  folderRename: (id: number, name: string) => invoke<void>('folder_rename', { id, name }),
  folderDelete: (id: number) => invoke<void>('folder_delete', { id }),
  folderMove:   (id: number, parentId: number | null, sort: number) =>
    invoke<void>('folder_move', { id, parentId, sort }),
  folderReorder: (parentId: number | null, ids: number[]) =>
    invoke<void>('folder_reorder', { parentId, ids }),

  // Sessions
  sessionList:      () => invoke<Session[]>('session_list'),
  sessionGet:       (id: number) => invoke<Session>('session_get', { id }),
  sessionEnvGet:    (id: number) => invoke<EnvPair[]>('session_env_get', { id }),
  sessionCreate:    (input: SessionInput) => invoke<Session>('session_create', { input }),
  sessionUpdate:    (id: number, input: SessionInput) => invoke<Session>('session_update', { id, input }),
  sessionDelete:    (id: number) => invoke<void>('session_delete', { id }),
  sessionDuplicate: (id: number) => invoke<Session>('session_duplicate', { id }),
  sessionMove:      (id: number, folderId: number | null, sort: number) =>
    invoke<void>('session_move', { id, folderId, sort }),
  sessionReorder:   (folderId: number | null, ids: number[]) =>
    invoke<void>('session_reorder', { folderId, ids }),

  // Credentials
  credentialList:   () => invoke<CredentialMeta[]>('credential_list'),
  credentialCreate: (kind: CredentialKind, label: string, plaintext: string) =>
    invoke<CredentialMeta>('credential_create', { kind, label, plaintext }),
  credentialDelete: (id: number) => invoke<void>('credential_delete', { id }),

  // Settings
  settingsGet: (key: string) => invoke<string | null>('settings_get', { key }),
  settingsSet: (key: string, value: string) => invoke<void>('settings_set', { key, value }),

  // SSH
  sshConnect:    (sessionId: number, cols: number, rows: number, trustAny: boolean, disableX11?: boolean) =>
    invoke<ConnectResult>('ssh_connect', { sessionId, cols, rows, trustAny, disableX11 }),
  sshWrite:      (connectionId: number, bytes: number[]) =>
    invoke<void>('ssh_write', { connectionId, bytes }),
  sshResize:     (connectionId: number, cols: number, rows: number) =>
    invoke<void>('ssh_resize', { connectionId, cols, rows }),
  sshDisconnect: (connectionId: number) =>
    invoke<void>('ssh_disconnect', { connectionId }),

  // Known hosts
  knownHostList:   () => invoke<KnownHost[]>('known_host_list'),
  knownHostRemove: (host: string, port: number) => invoke<void>('known_host_remove', { host, port }),

  // SFTP
  sftpOpen:     (connectionId: number) => invoke<void>('sftp_open', { connectionId }),
  sftpList:     (connectionId: number, path: string) =>
    invoke<SftpEntry[]>('sftp_list', { connectionId, path }),
  sftpMkdir:    (connectionId: number, path: string) =>
    invoke<void>('sftp_mkdir', { connectionId, path }),
  sftpRmdir:    (connectionId: number, path: string) =>
    invoke<void>('sftp_rmdir', { connectionId, path }),
  sftpRemove:   (connectionId: number, path: string) =>
    invoke<void>('sftp_remove', { connectionId, path }),
  sftpRename:   (connectionId: number, from: string, to: string) =>
    invoke<void>('sftp_rename', { connectionId, from, to }),
  sftpChmod:    (connectionId: number, path: string, mode: number) =>
    invoke<void>('sftp_chmod', { connectionId, path, mode }),
  sftpRealpath: (connectionId: number, path: string) =>
    invoke<string>('sftp_realpath', { connectionId, path }),
  sftpUpload:   (connectionId: number, localPath: string, remotePath: string) =>
    invoke<TransferTicket>('sftp_upload', { connectionId, localPath, remotePath }),
  sftpUploadBytes: (connectionId: number, remotePath: string, bytes: number[]) =>
    invoke<TransferTicket>('sftp_upload_bytes', { connectionId, remotePath, bytes }),
  sftpDownload: (connectionId: number, remotePath: string, localPath: string) =>
    invoke<TransferTicket>('sftp_download', { connectionId, remotePath, localPath }),

  // Local PTY (WSL / cmd / pwsh)
  localConnect:    (sessionId: number, cols: number, rows: number) =>
    invoke<{ connection_id: number }>('local_connect', { sessionId, cols, rows }),
  localWrite:      (connectionId: number, bytes: number[]) =>
    invoke<void>('local_write', { connectionId, bytes }),
  localResize:     (connectionId: number, cols: number, rows: number) =>
    invoke<void>('local_resize', { connectionId, cols, rows }),
  localDisconnect: (connectionId: number) =>
    invoke<void>('local_disconnect', { connectionId }),
  localReady:      (connectionId: number) =>
    invoke<void>('local_ready', { connectionId }),
  wslListDistros:  () => invoke<string[]>('wsl_list_distros'),
  wslAutodetectSeed: () => invoke<number>('wsl_autodetect_seed'),
  localShellsAutodetectSeed: () => invoke<number>('local_shells_autodetect_seed'),
  listLocalShells: () => invoke<DetectedShell[]>('list_local_shells'),
  getPlatform:     () => invoke<Platform>('platform'),

  // Port forwards (persistent)
  forwardList:    (sessionId: number) => invoke<Forward[]>('forward_list', { sessionId }),
  forwardCreate:  (sessionId: number, input: ForwardInput) =>
    invoke<Forward>('forward_create', { sessionId, input }),
  forwardUpdate:  (id: number, input: ForwardInput) =>
    invoke<Forward>('forward_update', { id, input }),
  forwardDelete:  (id: number) => invoke<void>('forward_delete', { id }),

  // Port forwards (runtime)
  forwardRuntimeList: (connectionId: number) =>
    invoke<RuntimeForward[]>('forward_runtime_list', { connectionId }),
  forwardStart: (connectionId: number, target: ForwardStartTarget) =>
    invoke<RuntimeForward>('forward_start', { connectionId, target }),
  forwardStop: (connectionId: number, runtimeId: number) =>
    invoke<void>('forward_stop', { connectionId, runtimeId }),
  forwardStopAll: (connectionId: number) =>
    invoke<void>('forward_stop_all', { connectionId }),

  // X11 forwarding
  xserverStatus:   () => invoke<XServerStatus>('xserver_status'),
  xserverInstall:  () => invoke<string>('xserver_install'),

  // Backup / restore
  backupCreate: (path: string, masterPassword: string, passphrase: string) =>
    invoke<BackupSummary>('backup_create', { path, masterPassword, passphrase }),
  backupPreview: (path: string, passphrase: string) =>
    invoke<BackupPreview>('backup_preview', { path, passphrase }),
  backupRestore: (path: string, passphrase: string, selection: BackupSelection) =>
    invoke<RestoreSummary>('backup_restore', { path, passphrase, selection }),

  // Cloud sync (phase 1 = local folder, phase 2 = S3-compatible)
  syncStatus:          () => invoke<SyncStatus>('sync_status'),
  syncConfigureLocal:  (path: string, passphrase: string) =>
    invoke<void>('sync_configure_local', { path, passphrase }),
  syncConfigureS3:     (cfg: S3ConfigInput) =>
    invoke<void>('sync_configure_s3', { cfg }),
  syncDisable:         () => invoke<void>('sync_disable'),
  syncPushNow:         () => invoke<void>('sync_push_now'),
  syncPullToTemp:      () => invoke<string>('sync_pull_to_temp'),

  // Import
  mobaxtermPreview: (path: string) =>
    invoke<MobaImportPreview>('mobaxterm_preview', { path }),
  mobaxtermCommit:  (sessions: ParsedMobaSession[], duplicateStrategy: MobaDuplicateStrategy) =>
    invoke<MobaImportResult>('mobaxterm_commit', { sessions, duplicateStrategy }),
};

/** Subscribe to forwards:status:{connectionId} events. Returns an
 *  unsubscribe function. Callers should call it on unmount. */
export async function subscribeForwardEvents(
  connectionId: number,
  onUpdate: (rf: RuntimeForward) => void,
): Promise<() => void> {
  const un = await listen<RuntimeForward>(
    `forwards:status:${connectionId}`,
    (e) => onUpdate(e.payload),
  );
  return () => { un(); };
}
