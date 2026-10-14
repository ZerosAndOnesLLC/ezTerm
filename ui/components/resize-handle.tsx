'use client';
import { useEffect, useRef, useState } from 'react';

interface Props {
  /** Current width of the owning pane (px). Captured at drag start. */
  width: number;
  min: number;
  max: number;
  onChange: (width: number) => void;
  /** Double-click on the handle. Typically resets to the default width. */
  onReset: () => void;
  /** Accessible name, e.g. "Resize sidebar". */
  label: string;
}

/**
 * 4 px vertical grab strip docked on the right edge of a `relative` pane.
 * Dragging it horizontally resizes the pane; double-click resets.
 *
 * While a drag is in flight a full-window transparent overlay sits above
 * everything so xterm.js (which otherwise grabs the pointer the moment it
 * crosses a terminal) can't hijack the gesture, and the cursor stays a
 * col-resize across the whole window. Moves are coalesced to one state
 * write per animation frame — the owning pane's ResizeObserver re-fits
 * the terminal on each, and that is not free.
 */
export function ResizeHandle({ width, min, max, onChange, onReset, label }: Props) {
  const [resizing, setResizing] = useState(false);
  // Latest props, readable from the window listeners without re-binding
  // them mid-drag. Synced after each commit, not during render.
  const latest = useRef({ width, min, max, onChange });
  useEffect(() => {
    latest.current = { width, min, max, onChange };
  }, [width, min, max, onChange]);
  const cleanupRef = useRef<(() => void) | null>(null);

  // A pane can unmount mid-drag (e.g. the SFTP toggle is clicked by a
  // chorded second pointer); drop the window listeners with it.
  useEffect(() => () => cleanupRef.current?.(), []);

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startW = latest.current.width;
    let raf = 0;
    let dx = 0;

    const flush = () => {
      raf = 0;
      const { min: lo, max: hi, onChange: emit } = latest.current;
      emit(Math.max(lo, Math.min(hi, startW + dx)));
    };
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (ev.buttons === 0) { stop(); return; }
      dx = ev.clientX - startX;
      if (!raf) raf = requestAnimationFrame(flush);
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) stop();
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      cleanupRef.current = null;
      setResizing(false);
    };
    cleanupRef.current = stop;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    setResizing(true);
  }

  return (
    <>
      <div
        onPointerDown={onPointerDown}
        onDoubleClick={onReset}
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        aria-valuenow={width}
        aria-valuemin={min}
        aria-valuemax={max}
        title="Drag to resize · Double-click to reset"
        className={`absolute top-0 right-0 h-full w-1 cursor-col-resize group z-10 ${
          resizing ? 'bg-accent/60' : 'hover:bg-accent/40'
        } transition-colors`}
      >
        <span
          className={`absolute inset-y-0 right-0 w-[2px] ${
            resizing ? 'bg-accent' : 'bg-transparent group-hover:bg-accent/60'
          }`}
          aria-hidden
        />
      </div>
      {resizing && <div className="fixed inset-0 z-[100] cursor-col-resize" aria-hidden />}
    </>
  );
}
