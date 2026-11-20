'use client';
import { useEffect, useRef } from 'react';

export interface MenuItem {
  label?: string;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  shortcut?: string; // e.g. "Ctrl+Shift+C"
  /** When true, renders a 1px divider line instead of a clickable row. */
  separator?: boolean;
}

export function ContextMenu({
  x,
  y,
  items,
  header,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  /** Optional muted line above the items, e.g. the link the menu acts on.
   *  Long values truncate; the full text is in the tooltip. */
  header?: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k);
    return () => {
      document.removeEventListener('mousedown', h);
      document.removeEventListener('keydown', k);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={{ top: y, left: x }}
      className="fixed z-50 min-w-[200px] rounded-md border border-border bg-surface shadow-menu py-1 text-xs dialog-in"
      role="menu"
      aria-label={header}
    >
      {header && (
        <>
          <div className="px-3 py-1.5 max-w-[360px] truncate font-mono text-[11px] text-muted" title={header}>
            {header}
          </div>
          <div role="separator" className="my-1 border-t border-border/70" aria-hidden />
        </>
      )}
      {items.map((it, i) => it.separator ? (
        <div key={i} role="separator" className="my-1 border-t border-border/70" aria-hidden />
      ) : (
        <button
          key={i}
          type="button"
          role="menuitem"
          disabled={it.disabled}
          onClick={() => { it.onClick?.(); onClose(); }}
          className={`flex items-center w-full text-left px-3 py-1.5 hover:bg-surface2 focus-visible:outline-none focus-visible:bg-surface2 disabled:opacity-40 disabled:hover:bg-transparent ${
            it.danger ? 'text-danger' : 'text-fg'
          }`}
        >
          <span className="flex-1 truncate">{it.label}</span>
          {it.shortcut && (
            <span className="ml-6 text-muted font-mono text-[10px] tracking-tight">
              {it.shortcut}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
