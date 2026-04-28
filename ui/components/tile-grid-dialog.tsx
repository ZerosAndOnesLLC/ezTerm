'use client';
import { useEffect, useRef, useState } from 'react';
import { Grid3x3 } from 'lucide-react';
import { useTabs } from '@/lib/tabs-store';

interface Props {
  onCancel:  () => void;
  onConfirm: (rows: number, cols: number) => void;
}

export function TileGridDialog({ onCancel, onConfirm }: Props) {
  const stored = useTabs((s) => s.tileGrid);
  const [rows, setRows] = useState<number>(stored.rows);
  const [cols, setCols] = useState<number>(stored.cols);
  const okBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { okBtnRef.current?.focus(); }, []);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  function clamp(n: number) { return Math.max(1, Math.min(8, n | 0)); }

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4 overlay-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tile-grid-title"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <form
        className="w-[360px] max-w-full bg-surface border border-border rounded-md shadow-dialog overflow-hidden dialog-in"
        onSubmit={(e) => { e.preventDefault(); onConfirm(clamp(rows), clamp(cols)); }}
      >
        <div className="p-4 flex gap-3">
          <div className="shrink-0 text-accent"><Grid3x3 size={22} /></div>
          <div className="min-w-0 flex-1">
            <h2 id="tile-grid-title" className="font-semibold text-sm">Tile grid</h2>
            <p className="text-muted text-xs mt-1">Pick the rows × columns layout.</p>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs text-muted">Rows</span>
                <input
                  type="number" min={1} max={8}
                  value={rows}
                  onChange={(e) => setRows(Number(e.target.value))}
                  className="mt-1 w-full px-2 py-1.5 bg-bg border border-border rounded text-sm focus-ring"
                />
              </label>
              <label className="block">
                <span className="text-xs text-muted">Columns</span>
                <input
                  type="number" min={1} max={8}
                  value={cols}
                  onChange={(e) => setCols(Number(e.target.value))}
                  className="mt-1 w-full px-2 py-1.5 bg-bg border border-border rounded text-sm focus-ring"
                />
              </label>
            </div>
          </div>
        </div>
        <div className="px-4 py-3 border-t border-border bg-surface2/30 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 border border-border rounded text-sm hover:bg-surface2 focus-ring"
          >
            Cancel
          </button>
          <button
            ref={okBtnRef}
            type="submit"
            className="px-3 py-1.5 rounded text-sm font-medium bg-accent text-white hover:brightness-110 focus-ring"
          >
            Apply
          </button>
        </div>
      </form>
    </div>
  );
}
