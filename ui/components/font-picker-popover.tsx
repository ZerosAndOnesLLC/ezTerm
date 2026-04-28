'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Minus, Plus, Save, X } from 'lucide-react';
import { fontChoicesForOS, MIN_FONT_SIZE, MAX_FONT_SIZE } from '@/lib/fonts';

interface Props {
  fontSize:   number;
  fontFamily: string;
  /** True when editing an unsaved / ephemeral (local / wsl host-not-in-db)
   *  session — the "Save as session default" checkbox only makes sense
   *  when the caller can persist back to `sessions`. */
  canSave:    boolean;
  /** Called on every font-size / family change so the terminal updates
   *  live. Does not persist — callers pass `onSave` for that. */
  onChange:   (next: { fontSize: number; fontFamily: string }) => void;
  /** Persist the current font-size + family to the session row. When
   *  undefined, the Save button is hidden. */
  onSave?:    () => void | Promise<void>;
  onClose:    () => void;
}

export function FontPickerPopover({
  fontSize,
  fontFamily,
  canSave,
  onChange,
  onSave,
  onClose,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [persist, setPersist] = useState(false);
  // Lazy memo: OS detection reads navigator.platform, so only do it once.
  const choices = useMemo(() => fontChoicesForOS(), []);

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    }
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  function bumpSize(delta: number) {
    const next = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, fontSize + delta));
    if (next !== fontSize) onChange({ fontSize: next, fontFamily });
  }

  // The dropdown shows an exact match on known presets; custom family
  // strings (set from the session dialog, or presets from a different
  // OS) just show "(custom)" so we don't misrepresent the value.
  const currentPresetValue = choices.some((c) => c.value === fontFamily)
    ? fontFamily
    : '__custom__';

  async function handleSaveClick() {
    if (!onSave) return;
    await onSave();
    onClose();
  }

  async function handleDone() {
    if (persist && onSave) await onSave();
    onClose();
  }

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Font settings"
      className="absolute top-2 right-2 bg-surface border border-border rounded-md shadow-menu py-2 px-3 text-xs w-[260px] dialog-in"
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="font-medium text-fg">Font</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close font picker"
          className="icon-btn w-5 h-5"
        >
          <X size={12} />
        </button>
      </div>

      <label className="block text-muted text-[11px] mb-1">Family</label>
      <select
        value={currentPresetValue}
        onChange={(e) => {
          const v = e.target.value;
          if (v === '__custom__') return; // no-op; custom comes from session dialog
          onChange({ fontSize, fontFamily: v });
        }}
        className="input w-full mb-3"
      >
        {choices.map((c) => (
          <option key={c.value || '__default__'} value={c.value}>
            {c.label}
          </option>
        ))}
        {currentPresetValue === '__custom__' && (
          <option value="__custom__">{fontFamily} (custom)</option>
        )}
      </select>

      <label className="block text-muted text-[11px] mb-1">Size</label>
      <div className="flex items-center gap-2 mb-3">
        <button
          type="button"
          onClick={() => bumpSize(-1)}
          disabled={fontSize <= MIN_FONT_SIZE}
          aria-label="Decrease font size"
          className="icon-btn w-7 h-7 disabled:opacity-40"
        >
          <Minus size={12} />
        </button>
        <input
          type="number"
          min={MIN_FONT_SIZE}
          max={MAX_FONT_SIZE}
          value={fontSize}
          onChange={(e) => {
            const raw = Number(e.target.value);
            if (Number.isFinite(raw)) {
              const next = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(raw)));
              if (next !== fontSize) onChange({ fontSize: next, fontFamily });
            }
          }}
          className="input w-16 text-center tabular-nums"
          aria-label="Font size (pt)"
        />
        <button
          type="button"
          onClick={() => bumpSize(1)}
          disabled={fontSize >= MAX_FONT_SIZE}
          aria-label="Increase font size"
          className="icon-btn w-7 h-7 disabled:opacity-40"
        >
          <Plus size={12} />
        </button>
        <span className="text-muted text-[10px] ml-auto">pt</span>
      </div>

      {canSave && onSave && (
        <label className="flex items-center gap-2 cursor-pointer select-none mb-2">
          <input
            type="checkbox"
            checked={persist}
            onChange={(e) => setPersist(e.target.checked)}
            className="w-3.5 h-3.5 accent-accent"
          />
          <span className="text-[11px]">Save as session default</span>
        </label>
      )}

      <div className="flex items-center justify-end gap-2 pt-1 border-t border-border/70">
        {canSave && onSave && (
          <button
            type="button"
            onClick={handleSaveClick}
            title="Save now without closing"
            className="inline-flex items-center gap-1 px-2 py-1 rounded border border-border text-fg hover:bg-surface2 focus-ring"
          >
            <Save size={11} />
            Save
          </button>
        )}
        <button
          type="button"
          onClick={handleDone}
          className="px-2 py-1 rounded bg-accent text-white hover:brightness-110 focus-ring"
        >
          Done
        </button>
      </div>
    </div>
  );
}
