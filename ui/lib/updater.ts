import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

/** localStorage key for the last-check timestamp (RFC3339 string). Used
 *  to enforce the monthly cadence without a DB round-trip. */
const LAST_CHECK_KEY = 'ezterm.updater.lastCheckAt';

/** Auto-check cadence. v0.14 default: once every 30 days. User can
 *  still trigger a manual check from the sidebar menu any time. */
const AUTO_CHECK_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

export async function checkForUpdate(): Promise<Update | null> {
  const u = await check();
  localStorage.setItem(LAST_CHECK_KEY, new Date().toISOString());
  return u ?? null;
}

/** Silent auto-check — only runs if the configured interval has elapsed
 *  since the last check. Returns the Update when one is available and
 *  cadence allows; returns null otherwise (including "still within
 *  window" which isn't an error). */
export async function maybeAutoCheck(): Promise<Update | null> {
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

export async function downloadAndInstall(
  update: Update,
  onProgress?: (downloaded: number, total: number | null) => void,
): Promise<void> {
  let downloaded = 0;
  let total: number | null = null;
  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case 'Started':
        total = event.data.contentLength ?? null;
        break;
      case 'Progress':
        downloaded += event.data.chunkLength;
        onProgress?.(downloaded, total);
        break;
      case 'Finished':
        onProgress?.(total ?? downloaded, total);
        break;
    }
  });
}

export { relaunch };
