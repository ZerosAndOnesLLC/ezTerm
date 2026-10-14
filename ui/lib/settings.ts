/**
 * App-wide preferences. One flat map of dotted keys, each with a typed
 * spec (default, kind, bounds). Values live in the SQLite `app_settings`
 * table as strings and are hydrated into this store once at unlock;
 * every `set` writes through immediately, so the panel needs no Save
 * button.
 *
 * Per-session values (scrollback, font, keepalive, …) still win over the
 * `terminal.*` / `sessions.*` defaults here — those defaults only seed
 * the session dialog for new sessions.
 *
 * Layout state (view mode, pane widths, minimized tabs) deliberately
 * stays in localStorage via tabs-store: it is per-browser-profile
 * convenience, not a preference a user expects to roam with a backup.
 */
import { create } from 'zustand';
import { api } from './tauri';
import { toast } from './toast';
import { errMessage } from './tauri';

export type CursorStyle = 'block' | 'underline' | 'bar';
export type RightClick  = 'menu' | 'paste';
export type Bell        = 'none' | 'visual' | 'sound';
export type TabLabel    = 'name' | 'userhost';

export interface Settings {
  'terminal.scrollback':         number;
  'terminal.fontSize':           number;
  'terminal.fontFamily':         string;
  'terminal.cursorStyle':        CursorStyle;
  'terminal.cursorBlink':        boolean;
  'terminal.copyOnSelect':       boolean;
  'terminal.rightClick':         RightClick;
  'terminal.warnMultilinePaste': boolean;
  'terminal.osc52Clipboard':     boolean;
  'terminal.bell':               Bell;

  'sessions.confirmCloseLive':   boolean;
  'sessions.confirmExit':        boolean;
  'sessions.autoOpenSftp':       boolean;
  'sessions.keepaliveSecs':      number;
  'sessions.connectTimeoutSecs': number;

  'appearance.tabLabel':         TabLabel;

  'updates.checkOnLaunch':       boolean;
  'updates.preRelease':          boolean;
  'updates.intervalDays':        number;

  /** 0 disables. */
  'security.idleLockMinutes':    number;
}

export type SettingKey = keyof Settings;

type Spec<T> =
  | { kind: 'bool';   default: T & boolean }
  | { kind: 'int';    default: T & number; min: number; max: number }
  | { kind: 'string'; default: T & string; maxLen: number }
  | { kind: 'enum';   default: T; values: readonly T[] };

export const SPEC: { [K in SettingKey]: Spec<Settings[K]> } = {
  'terminal.scrollback':         { kind: 'int', default: 5000, min: 0, max: 100_000 },
  'terminal.fontSize':           { kind: 'int', default: 13, min: 8, max: 48 },
  'terminal.fontFamily':         { kind: 'string', default: '', maxLen: 200 },
  'terminal.cursorStyle':        { kind: 'enum', default: 'block', values: ['block', 'underline', 'bar'] },
  'terminal.cursorBlink':        { kind: 'bool', default: true },
  'terminal.copyOnSelect':       { kind: 'bool', default: false },
  'terminal.rightClick':         { kind: 'enum', default: 'menu', values: ['menu', 'paste'] },
  'terminal.warnMultilinePaste': { kind: 'bool', default: true },
  'terminal.osc52Clipboard':     { kind: 'bool', default: true },
  'terminal.bell':               { kind: 'enum', default: 'none', values: ['none', 'visual', 'sound'] },

  'sessions.confirmCloseLive':   { kind: 'bool', default: true },
  'sessions.confirmExit':        { kind: 'bool', default: true },
  'sessions.autoOpenSftp':       { kind: 'bool', default: false },
  'sessions.keepaliveSecs':      { kind: 'int', default: 60, min: 0, max: 7200 },
  'sessions.connectTimeoutSecs': { kind: 'int', default: 15, min: 1, max: 600 },

  'appearance.tabLabel':         { kind: 'enum', default: 'name', values: ['name', 'userhost'] },

  'updates.checkOnLaunch':       { kind: 'bool', default: true },
  'updates.preRelease':          { kind: 'bool', default: false },
  'updates.intervalDays':        { kind: 'int', default: 30, min: 1, max: 365 },

  'security.idleLockMinutes':    { kind: 'int', default: 0, min: 0, max: 1440 },
};

export const DEFAULTS: Settings = Object.fromEntries(
  (Object.keys(SPEC) as SettingKey[]).map((k) => [k, SPEC[k].default]),
) as unknown as Settings;

/** Parse a stored string per the key's spec. Anything out of range or
 *  unrecognised falls back to the default rather than poisoning the
 *  store — the DB is user-editable and schemas drift between versions. */
export function parseSetting<K extends SettingKey>(key: K, raw: string | null | undefined): Settings[K] {
  const spec = SPEC[key];
  if (raw == null) return spec.default;
  switch (spec.kind) {
    case 'bool':
      return (raw === 'true' ? true : raw === 'false' ? false : spec.default) as Settings[K];
    case 'int': {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < spec.min || n > spec.max) return spec.default;
      return n as Settings[K];
    }
    case 'string':
      return (raw.length <= spec.maxLen ? raw : spec.default) as Settings[K];
    case 'enum':
      return ((spec.values as readonly string[]).includes(raw) ? raw : spec.default) as Settings[K];
  }
}

/** Clamp / validate an in-app value before storing. Returns null when
 *  the value is not representable (e.g. NaN from an empty number input)
 *  so the caller can ignore the keystroke instead of persisting junk. */
export function normalizeSetting<K extends SettingKey>(key: K, value: Settings[K]): Settings[K] | null {
  const spec = SPEC[key];
  switch (spec.kind) {
    case 'bool':
      return (typeof value === 'boolean' ? value : null) as Settings[K] | null;
    case 'int': {
      const n = Number(value);
      if (!Number.isFinite(n)) return null;
      return Math.round(Math.max(spec.min, Math.min(spec.max, n))) as Settings[K];
    }
    case 'string':
      return (typeof value === 'string' ? value.slice(0, spec.maxLen) : null) as Settings[K] | null;
    case 'enum':
      return ((spec.values as readonly unknown[]).includes(value) ? value : null) as Settings[K] | null;
  }
}

export function serializeSetting<K extends SettingKey>(key: K, value: Settings[K]): string {
  return String(value);
}

interface SettingsState {
  settings: Settings;
  hydrated: boolean;
  panelOpen: boolean;
  /** Load every stored key. Idempotent; safe to call again after unlock. */
  hydrate: () => Promise<void>;
  /** Validate, update the store, and persist. Returns false if rejected. */
  set: <K extends SettingKey>(key: K, value: Settings[K]) => boolean;
  openPanel: () => void;
  closePanel: () => void;
}

/** Pre-#166 location of the pre-release opt-in. Read once during the
 *  first hydrate so existing users keep their channel. */
const LEGACY_PRE_RELEASE_KEY = 'ezterm.updater.preRelease';

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULTS,
  hydrated: false,
  panelOpen: false,

  hydrate: async () => {
    let rows: [string, string][] = [];
    try {
      rows = await api.settingsList();
    } catch (e) {
      toast.danger('Could not load settings', errMessage(e));
      return;
    }
    const stored = new Map(rows);
    const next = { ...DEFAULTS };
    for (const key of Object.keys(SPEC) as SettingKey[]) {
      (next as Record<string, unknown>)[key] = parseSetting(key, stored.get(key));
    }
    if (!stored.has('updates.preRelease')) {
      try {
        const legacy = localStorage.getItem(LEGACY_PRE_RELEASE_KEY);
        if (legacy === 'true') {
          next['updates.preRelease'] = true;
          void api.settingsSet('updates.preRelease', 'true').catch(() => {});
          localStorage.removeItem(LEGACY_PRE_RELEASE_KEY);
        }
      } catch { /* localStorage unavailable */ }
    }
    set({ settings: next, hydrated: true });
  },

  set: (key, value) => {
    const clean = normalizeSetting(key, value);
    if (clean === null) return false;
    const prev = get().settings[key];
    if (prev === clean) return true;
    set((s) => ({ settings: { ...s.settings, [key]: clean } }));
    api.settingsSet(key, serializeSetting(key, clean)).catch((e: unknown) => {
      toast.danger('Setting not saved', errMessage(e));
      set((s) => ({ settings: { ...s.settings, [key]: prev } }));
    });
    return true;
  },

  openPanel:  () => set({ panelOpen: true }),
  closePanel: () => set({ panelOpen: false }),
}));

/** Non-reactive read for code outside React (xterm handlers, stores). */
export function getSetting<K extends SettingKey>(key: K): Settings[K] {
  return useSettings.getState().settings[key];
}
