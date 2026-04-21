'use client';
import { useEffect, useRef } from 'react';
import { AlertTriangle, Info } from 'lucide-react';

export type ConfirmKind = 'danger' | 'info';

interface Props {
  title:       string;
  body?:       string;
  confirmText?: string;
  cancelText?:  string;
  kind?:       ConfirmKind;
  onCancel:    () => void;
  onConfirm:   () => void;
}

export function ConfirmDialog({
  title,
  body,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  kind = 'info',
  onCancel,
  onConfirm,
}: Props) {
  const confirmBtnRef = useRef<HTMLButtonElement>(null);
  // Focus the primary action on mount so Enter immediately confirms —
  // matches native confirm-dialog semantics but keeps tab order sane.
  useEffect(() => { confirmBtnRef.current?.focus(); }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const Icon = kind === 'danger' ? AlertTriangle : Info;
  const iconColor = kind === 'danger' ? 'text-danger' : 'text-accent';
  const confirmCls = kind === 'danger'
    ? 'bg-danger text-white hover:brightness-110'
    : 'bg-accent text-white hover:brightness-110';

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4 overlay-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="w-[420px] max-w-full bg-surface border border-border rounded-md shadow-dialog overflow-hidden dialog-in">
        <div className="p-4 flex gap-3">
          <div className={`shrink-0 ${iconColor}`}>
            <Icon size={22} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="confirm-title" className="font-semibold text-sm">{title}</h2>
            {body && <p className="text-muted text-xs mt-1 whitespace-pre-line">{body}</p>}
          </div>
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
            ref={confirmBtnRef}
            type="button"
            onClick={onConfirm}
            className={`px-3 py-1.5 rounded text-sm font-medium focus-ring ${confirmCls}`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
