import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { relaunch } from '@tauri-apps/plugin-process';

/** localStorage key for the last-check timestamp (RFC3339 string). Used
 *  to enforce the monthly cadence without a DB round-trip. */
const LAST_CHECK_KEY = 'ezterm.updater.lastCheckAt';

/** localStorage key for the pre-release opt-in. When 'true', the updater
 *  tracks the beta channel (newest release including pre-releases) instead
 *  of stable-only. Lets a user test a build before it's promoted to the
 *  public latest release. */
const PRE_RELEASE_KEY = 'ezterm.updater.preRelease';

/** Auto-check cadence. v0.14 default: once every 30 days. User can
 *  still trigger a manual check from the sidebar menu any time. */
const AUTO_CHECK_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

/** Metadata about an available update. Mirrors the Rust `UpdateInfo`
 *  (snake_case fields), returned by the `updater_check` command. */
export interface UpdateInfo {
  current_version: string;
  version: string;
  date: string | null;
  body: string | null;
  pre_release: boolean;
}

export function getPreReleaseOptIn(): boolean {
  return localStorage.getItem(PRE_RELEASE_KEY) === 'true';
}

export function setPreReleaseOptIn(on: boolean): void {
  localStorage.setItem(PRE_RELEASE_KEY, on ? 'true' : 'false');
}

/** Check the requested channel for an update. The backend stashes the
 *  discovered release so a later {@link downloadAndInstall} acts on exactly
 *  this build. */
export async function checkForUpdate(preRelease = getPreReleaseOptIn()): Promise<UpdateInfo | null> {
  const u = await invoke<UpdateInfo | null>('updater_check', { preRelease });
  localStorage.setItem(LAST_CHECK_KEY, new Date().toISOString());
  return u ?? null;
}

/** Silent auto-check — only runs if the configured interval has elapsed
 *  since the last check. Uses the persisted channel preference. Returns the
 *  UpdateInfo when one is available and cadence allows; returns null
 *  otherwise (including "still within window" which isn't an error). */
export async function maybeAutoCheck(): Promise<UpdateInfo | null> {
  const last = localStorage.getItem(LAST_CHECK_KEY);
  if (last) {
    const lastMs = Date.parse(last);
    if (Number.isFinite(lastMs) && Date.now() - lastMs < AUTO_CHECK_INTERVAL_MS) {
      return null;
    }
  }
  try {
    return await checkForUpdate();
  } catch {
    // Network / signing-key issues shouldn't block app startup.
    return null;
  }
}

/** Download and install the update found by the most recent
 *  {@link checkForUpdate}, reporting byte progress. Resolves once the
 *  installer has been applied; the caller relaunches. */
export async function downloadAndInstall(
  onProgress?: (downloaded: number, total: number | null) => void,
): Promise<void> {
  const unlisten = await listen<{ event: string; downloaded: number; total: number | null }>(
    'updater:progress',
    (e) => {
      const { event, downloaded, total } = e.payload;
      if (event === 'progress') onProgress?.(downloaded, total ?? null);
      else if (event === 'finished') onProgress?.(total ?? downloaded, total ?? null);
    },
  );
  try {
    await invoke('updater_download_install');
  } finally {
    unlisten();
  }
}

export { relaunch };
