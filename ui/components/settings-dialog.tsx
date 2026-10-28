'use client';
import { useEffect, useState, type ReactNode } from 'react';
import {
  Bell, Layers, Monitor, Palette, RefreshCw, ShieldCheck, TerminalSquare, X,
} from 'lucide-react';
import { useSettings, type SettingKey, type Settings } from '@/lib/settings';
import { useTheme } from '@/lib/theme';
import { getPalette, PALETTE_IDS, PALETTES, type PaletteId } from '@/lib/palettes';

type SectionId = 'appearance' | 'terminal' | 'sessions' | 'updates' | 'security';

const SECTIONS: { id: SectionId; label: string; icon: typeof Palette }[] = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'terminal',   label: 'Terminal',   icon: TerminalSquare },
  { id: 'sessions',   label: 'Sessions',   icon: Layers },
  { id: 'updates',    label: 'Updates',    icon: RefreshCw },
  { id: 'security',   label: 'Security',   icon: ShieldCheck },
];

/**
 * App preferences. Every control writes through on change — there is no
 * Save button (see lib/settings.ts). Per-session values in the session
 * dialog override the Terminal / Sessions defaults here.
 */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [section, setSection] = useState<SectionId>('appearance');

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4 overlay-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-[720px] max-w-full h-[520px] max-h-full bg-surface border border-border rounded-md shadow-dialog overflow-hidden dialog-in flex flex-col">
        <div className="h-10 px-4 border-b border-border flex items-center gap-2 shrink-0">
          <h2 id="settings-title" className="text-sm font-medium flex-1">Settings</h2>
          <span className="text-muted text-xs">Changes save automatically</span>
          <button type="button" onClick={onClose} aria-label="Close settings" className="icon-btn w-6 h-6">
            <X size={14} />
          </button>
        </div>
        <div className="flex-1 min-h-0 flex">
          <nav className="w-44 shrink-0 border-r border-border py-2" aria-label="Settings sections">
            {SECTIONS.map(({ id, label, icon: Icon }) => {
              const on = section === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setSection(id)}
                  aria-current={on ? 'page' : undefined}
                  className={`w-full flex items-center gap-2 px-4 h-8 text-sm text-left focus-ring ${
                    on ? 'bg-bg text-fg border-l-2 border-accent' : 'text-muted hover:text-fg hover:bg-surface2/40 border-l-2 border-transparent'
                  }`}
                >
                  <Icon size={14} />
                  {label}
                </button>
              );
            })}
          </nav>
          <div className="flex-1 min-w-0 overflow-y-auto p-5">
            {section === 'appearance' && <AppearanceSection />}
            {section === 'terminal'   && <TerminalSection />}
            {section === 'sessions'   && <SessionsSection />}
            {section === 'updates'    && <UpdatesSection />}
            {section === 'security'   && <SecuritySection />}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- sections ---------- */

function AppearanceSection() {
  const theme = useTheme((s) => s.theme);
  const setTheme = useTheme((s) => s.setTheme);
  return (
    <Group title="Appearance">
      <Row label="Theme" hint="Window chrome only; pick the terminal colours below.">
        <select className="input w-40" value={theme} onChange={(e) => void setTheme(e.target.value as 'dark' | 'light')}>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </Row>
      <EnumRow
        k="appearance.tabLabel"
        label="Tab label"
        hint="What each tab shows. Local shells always show their name."
        options={[['name', 'Session name'], ['userhost', 'user@host']]}
      />
      <PaletteRow />
    </Group>
  );
}

/** Terminal palette picker with a live swatch strip. Applies to every
 *  open tab immediately (terminal.tsx subscribes to the key). */
function PaletteRow() {
  const value = useSettings((s) => s.settings['terminal.palette']);
  const set = useSettings((s) => s.set);
  const palette = getPalette(value);
  const dark  = PALETTE_IDS.filter((id) => !PALETTES[id].light);
  const light = PALETTE_IDS.filter((id) =>  PALETTES[id].light);
  return (
    <div className="py-2.5">
      <div className="flex items-center gap-4">
        <div className="flex-1 min-w-0">
          <div className="text-sm">Terminal colours</div>
          <div className="text-muted text-xs mt-0.5">ANSI palette for every terminal tab. Changes apply live.</div>
        </div>
        <div className="shrink-0">
          <select
            className="input w-48"
            value={value}
            aria-label="Terminal colours"
            onChange={(e) => set('terminal.palette', e.target.value as PaletteId)}
          >
            <optgroup label="Dark">
              {dark.map((id) => <option key={id} value={id}>{PALETTES[id].label}</option>)}
            </optgroup>
            <optgroup label="Light">
              {light.map((id) => <option key={id} value={id}>{PALETTES[id].label}</option>)}
            </optgroup>
          </select>
        </div>
      </div>
      <PaletteSwatch palette={palette} />
    </div>
  );
}

/** Mock terminal line + the 16 ANSI colours on the palette background. */
function PaletteSwatch({ palette }: { palette: ReturnType<typeof getPalette> }) {
  const [, red, green, yellow, blue, magenta, cyan] = palette.ansi;
  return (
    <div
      className="mt-2 rounded-sm border border-border px-3 py-2 font-mono text-xs leading-5"
      style={{ background: palette.background, color: palette.foreground }}
      aria-hidden="true"
    >
      <div className="truncate">
        <span style={{ color: green }}>user@host</span>
        <span>:</span>
        <span style={{ color: blue }}>~/src</span>
        <span>$ </span>
        <span style={{ color: yellow }}>ls</span>
        <span> -la </span>
        <span style={{ color: cyan }}>docs/</span>
        <span> </span>
        <span style={{ color: magenta }}>*.md</span>
        <span> </span>
        <span style={{ color: red }}>error</span>
        <span
          className="inline-block w-[0.6em] h-[1em] align-text-bottom ml-0.5"
          style={{ background: palette.cursor }}
        />
      </div>
      <div className="mt-1.5 flex gap-1">
        {palette.ansi.map((c, i) => (
          <span
            key={i}
            title={`ANSI ${i}: ${c}`}
            className="h-3.5 flex-1 rounded-[2px]"
            style={{ background: c }}
          />
        ))}
      </div>
    </div>
  );
}

function TerminalSection() {
  return (
    <>
      <Group title="Defaults for new sessions" hint="Each session can override these in its own dialog.">
        <IntRow k="terminal.scrollback" label="Scrollback lines" hint="0 disables scrollback." step={500} />
        <IntRow k="terminal.fontSize" label="Font size" />
        <TextRow k="terminal.fontFamily" label="Font family" placeholder="(OS default mono stack)" />
        <EnumRow
          k="terminal.cursorStyle"
          label="Cursor style"
          options={[['block', 'Block'], ['underline', 'Underline'], ['bar', 'Bar']]}
        />
        <BoolRow k="terminal.cursorBlink" label="Cursor blink" hint="Applies to tabs opened after the change." />
      </Group>
      <Group title="Mouse and clipboard">
        <BoolRow k="terminal.copyOnSelect" label="Copy on select" hint="Selecting text copies it immediately." />
        <EnumRow
          k="terminal.rightClick"
          label="Right-click"
          hint="With Paste selected, Ctrl + right-click still opens the menu."
          options={[['menu', 'Open context menu'], ['paste', 'Paste clipboard']]}
        />
        <BoolRow
          k="terminal.warnMultilinePaste"
          label="Warn before pasting multiple lines"
          hint="Catches a whole script landing in a shell by accident."
        />
        <BoolRow
          k="terminal.osc52Clipboard"
          label="Programs may write the clipboard (OSC 52)"
          hint="Lets Claude Code, neovim and tmux copy to your clipboard over SSH. Programs can never read it."
        />
      </Group>
      <Group title="Bell">
        <EnumRow
          k="terminal.bell"
          label="On bell"
          options={[['none', 'Do nothing'], ['visual', 'Flash the terminal'], ['sound', 'Play a beep']]}
          icon={<Bell size={13} />}
        />
      </Group>
    </>
  );
}

function SessionsSection() {
  return (
    <>
      <Group title="Tabs">
        <BoolRow k="sessions.confirmCloseLive" label="Confirm before closing a connected tab" />
        <BoolRow k="sessions.confirmExit" label="Confirm before quitting with connected tabs" />
        <BoolRow k="sessions.autoOpenSftp" label="Open the file pane when a session connects" hint="SSH and WSL tabs." />
      </Group>
      <Group title="Defaults for new sessions" hint="Each session can override these in its own dialog.">
        <IntRow k="sessions.keepaliveSecs" label="Keepalive interval (seconds)" hint="0 disables. Keeps idle connections alive through NAT and firewalls." step={15} />
        <IntRow k="sessions.connectTimeoutSecs" label="Connect timeout (seconds)" />
      </Group>
    </>
  );
}

function UpdatesSection() {
  return (
    <Group title="Updates">
      <BoolRow k="updates.checkOnLaunch" label="Check for updates on launch" />
      <IntRow k="updates.intervalDays" label="Check at most every (days)" />
      <BoolRow
        k="updates.preRelease"
        label="Include pre-releases"
        hint="Track the newest build, including betas, to test versions before they ship publicly."
      />
    </Group>
  );
}

function SecuritySection() {
  return (
    <Group title="Vault">
      <IntRow
        k="security.idleLockMinutes"
        label="Lock the vault after inactivity (minutes)"
        hint="0 keeps it unlocked until you lock it. Open connections stay up; reopening tabs needs the master password."
        step={5}
      />
      <div className="text-muted text-xs flex items-start gap-2 mt-1">
        <Monitor size={13} className="shrink-0 mt-0.5" />
        <span>Inactivity means no keyboard or mouse input anywhere in the ezTerm window.</span>
      </div>
    </Group>
  );
}

/* ---------- building blocks ---------- */

function Group({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="mb-6 last:mb-0">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted mb-1">{title}</h3>
      {hint && <p className="text-muted text-xs mb-2">{hint}</p>}
      <div className="divide-y divide-border border-y border-border">{children}</div>
    </section>
  );
}

function Row({ label, hint, icon, children }: { label: string; hint?: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4 py-2.5">
      <div className="flex-1 min-w-0">
        <div className="text-sm flex items-center gap-1.5">{icon}{label}</div>
        {hint && <div className="text-muted text-xs mt-0.5">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

type BoolKey = { [K in SettingKey]: Settings[K] extends boolean ? K : never }[SettingKey];
type IntKey  = { [K in SettingKey]: Settings[K] extends number ? K : never }[SettingKey];
type StrKey  = { [K in SettingKey]: Settings[K] extends string ? K : never }[SettingKey];

function BoolRow({ k, label, hint }: { k: BoolKey; label: string; hint?: string }) {
  const value = useSettings((s) => s.settings[k]);
  const set = useSettings((s) => s.set);
  return (
    <Row label={label} hint={hint}>
      <label className="inline-flex items-center cursor-pointer">
        <input
          type="checkbox"
          role="switch"
          aria-checked={value}
          aria-label={label}
          checked={value}
          onChange={(e) => set(k, e.target.checked)}
          className="accent-accent w-4 h-4"
        />
      </label>
    </Row>
  );
}

function IntRow({ k, label, hint, step = 1 }: { k: IntKey; label: string; hint?: string; step?: number }) {
  const value = useSettings((s) => s.settings[k]);
  const set = useSettings((s) => s.set);
  // Local draft while typing; the store is written once, on blur or
  // Enter, so an intermediate prefix below the minimum ("1" on the way
  // to "13") is never clamped out from under the user and each edit is
  // one IPC write. When the store value changes underneath (reverted
  // after a failed save) the draft follows — adjusted during render,
  // not in an effect, per the React guidance for derived state.
  const [draft, setDraft] = useState(String(value));
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setDraft(String(value));
  }
  const commit = () => {
    if (draft !== '' && set(k, Number(draft))) return;
    setDraft(String(useSettings.getState().settings[k]));
  };
  return (
    <Row label={label} hint={hint}>
      <input
        type="number"
        step={step}
        value={draft}
        aria-label={label}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
        className="input w-28 text-right tabular-nums"
      />
    </Row>
  );
}

function TextRow({ k, label, hint, placeholder }: { k: StrKey; label: string; hint?: string; placeholder?: string }) {
  const value = useSettings((s) => s.settings[k]);
  const set = useSettings((s) => s.set);
  return (
    <Row label={label} hint={hint}>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        onChange={(e) => set(k, e.target.value)}
        className="input w-56"
      />
    </Row>
  );
}

function EnumRow<K extends SettingKey>({
  k, label, hint, options, icon,
}: { k: K; label: string; hint?: string; options: [Settings[K] & string, string][]; icon?: ReactNode }) {
  const value = useSettings((s) => s.settings[k]);
  const set = useSettings((s) => s.set);
  return (
    <Row label={label} hint={hint} icon={icon}>
      <select
        className="input w-48"
        value={value as string}
        aria-label={label}
        onChange={(e) => set(k, e.target.value as Settings[K])}
      >
        {options.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
      </select>
    </Row>
  );
}
