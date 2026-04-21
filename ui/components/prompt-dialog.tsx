'use client';
import { useEffect, useRef, useState } from 'react';

interface Props {
  title:        string;
  label?:       string;
  initialValue?: string;
  placeholder?: string;
  confirmText?: string;
  cancelText?:  string;
  validate?:    (v: string) => string | null;
  onCancel:     () => void;
  onConfirm:    (value: string) => void | Promise<void>;
}

export function PromptDialog({
  title,
  label,
  initialValue = '',
  placeholder,
  confirmText = 'Save',
  cancelText = 'Cancel',
  validate,
  onCancel,
  onConfirm,
}: Props) {
  const [value, setValue] = useState(initialValue);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (validate) {
      const problem = validate(value);
      if (problem) { setErr(problem); return; }
    }
    if (!value.trim()) { setErr(`${label ?? 'Value'} is required`); return; }
    setErr(null);
    setBusy(true);
    try {
      await onConfirm(value.trim());
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4 overlay-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="prompt-title"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <form
        onSubmit={submit}
        className="w-[440px] max-w-full bg-surface border border-border rounded-md shadow-dialog dialog-in"
      >
        <div className="p-4">
          <h2 id="prompt-title" className="font-semibold text-sm">{title}</h2>
          <label className="block mt-3 space-y-1">
            {label && <span className="text-muted text-xs">{label}</span>}
            <input
              ref={inputRef}
              className="input"
              value={value}
              placeholder={placeholder}
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
          {err && <div className="text-danger text-xs mt-2">{err}</div>}
        </div>
        <div className="px-4 py-3 border-t border-border bg-surface2/30 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 border border-border rounded text-sm hover:bg-surface2 focus-ring"
          >
            {cancelText}
          </button>
          <button
            type="submit"
            disabled={busy}
            className="px-3 py-1.5 bg-accent text-white rounded text-sm font-medium hover:brightness-110 disabled:opacity-50 focus-ring"
          >
            {confirmText}
          </button>
        </div>
      </form>
    </div>
  );
}
