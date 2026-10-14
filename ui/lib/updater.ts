import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { relaunch } from '@tauri-apps/plugin-process';
import { getSetting, useSettings } from './settings';

/** localStorage key for the last-check timestamp (RFC3339 string). State,
 *  not a preference — it stays in localStorage. */
const LAST_CHECK_KEY = 'ezterm.updater.lastCheckAt';

/** Metadata about an available update. Mirrors the Rust `UpdateInfo`
 *  (snake_case fields), returned by the `updater_check` command. */
export interface UpdateInfo {
  current_version: string;
  version: string;
  date: string | null;
  body: string | null;
  pre_release: boolean;
}

/** Channel preference — `updates.preRelease` in the settings store. When
 *  true the updater tracks the newest release including pre-releases. */
export function getPreReleaseOptIn(): boolean {
  return getSetting('updates.preRelease');
}

export function setPreReleaseOptIn(on: boolean): void {
  useSettings.getState().set('updates.preRelease', on);
}

/** Check the requested channel for an update. The backend stashes the
 *  discovered release so a later {@link downloadAndInstall} acts on exactly
 *  this build. */
export async function checkForUpdate(preRelease = getPreReleaseOptIn()): Promise<UpdateInfo | null> {
  const u = await invoke<UpdateInfo | null>('updater_check', { preRelease });
  localStorage.setItem(LAST_CHECK_KEY, new Date().toISOString());
  return u ?? null;
}

/** Silent auto-check — only runs if `updates.checkOnLaunch` is on and the
 *  configured interval (`updates.intervalDays`) has elapsed since the last
 *  check. Uses the persisted channel preference. Returns the UpdateInfo
 *  when one is available and cadence allows; returns null otherwise
 *  (including "still within window" which isn't an error). Call after
 *  the settings store is hydrated. */
export async function maybeAutoCheck(): Promise<UpdateInfo | null> {
  if (!getSetting('updates.checkOnLaunch')) return null;
  const intervalMs = getSetting('updates.intervalDays') * 24 * 60 * 60 * 1000;
  const last = localStorage.getItem(LAST_CHECK_KEY);
  if (last) {
    const lastMs = Date.parse(last);
    if (Number.isFinite(lastMs) && Date.now() - lastMs < intervalMs) {
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
