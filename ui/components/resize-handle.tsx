'use client';
import { useEffect, useRef, useState } from 'react';

interface Props {
  /** Current width of the owning pane (px). Captured at drag start. */
  width: number;
  min: number;
  max: number;
  /** Width restored by double-click / Home-key. */
  defaultWidth: number;
  /** Live width during a drag or key step. Called at most once per frame. */
  onChange: (width: number) => void;
  /** Final width once the gesture ends — the place to persist. */
  onChangeEnd?: (width: number) => void;
  /** Pixels that must stay free to the right of the pane (the terminal and
   *  any other docked panes) regardless of `max`. Evaluated at drag start. */
  reserve?: number | (() => number);
  /** Accessible name, e.g. "Resize sidebar". */
  label: string;
}

/** Keyboard step sizes (px). */
const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;
/** Two pointerdowns this close in time and space count as a double-click.
 *  Detected by hand because the drag overlay swallows the pointerup, so
 *  the browser never targets a `dblclick` at the handle. */
const DBLCLICK_MS = 300;
const DBLCLICK_PX = 4;
/** Default `reserve`: keeps a usable terminal column to the right. */
const DEFAULT_RESERVE = 320;

/**
 * 4 px vertical grab strip docked on the right edge of a `relative` pane.
 * Dragging it horizontally resizes the pane; double-click resets; when
 * focused, arrow keys step the width and Home restores the default.
 *
 * While a drag is in flight a full-window transparent overlay sits above
 * everything so xterm.js (which otherwise grabs the pointer the moment it
 * crosses a terminal) can't hijack the gesture, and the cursor stays a
 * col-resize across the whole window. Moves are coalesced to one state
 * write per animation frame — the owning pane's ResizeObserver re-fits
 * the terminal on each, and that is not free.
 */
export function ResizeHandle({
  width, min, max, defaultWidth, onChange, onChangeEnd, reserve, label,
}: Props) {
  const [resizing, setResizing] = useState(false);
  const elRef = useRef<HTMLDivElement>(null);
  // Latest props, readable from the window listeners without re-binding
  // them mid-drag. Synced after each commit, not during render.
  const latest = useRef({ width, min, max, onChange, onChangeEnd, reserve });
  useEffect(() => {
    latest.current = { width, min, max, onChange, onChangeEnd, reserve };
  }, [width, min, max, onChange, onChangeEnd, reserve]);
  const cleanupRef = useRef<(() => void) | null>(null);
  const lastDown = useRef<{ t: number; x: number; y: number } | null>(null);

  // A pane can unmount mid-drag (e.g. the SFTP toggle is clicked by a
  // chorded second pointer); drop the window listeners with it.
  useEffect(() => () => cleanupRef.current?.(), []);

  /** Upper bound for this gesture: the prop `max`, further limited so
   *  `reserve` px stay free between the pane's left edge and the window's
   *  right edge. Never below `min`. */
  function effectiveMax(): number {
    const { min: lo, max: hi, reserve: r } = latest.current;
    const need = typeof r === 'function' ? r() : (r ?? DEFAULT_RESERVE);
    const left = elRef.current?.parentElement?.getBoundingClientRect().left ?? 0;
    return Math.max(lo, Math.min(hi, window.innerWidth - left - need));
  }

  function commit(w: number) {
    const { onChange: emit, onChangeEnd: done } = latest.current;
    emit(w);
    done?.(w);
  }

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();

    const now = performance.now();
    const prev = lastDown.current;
    lastDown.current = { t: now, x: e.clientX, y: e.clientY };
    if (
      prev &&
      now - prev.t < DBLCLICK_MS &&
      Math.abs(e.clientX - prev.x) < DBLCLICK_PX &&
      Math.abs(e.clientY - prev.y) < DBLCLICK_PX
    ) {
      lastDown.current = null;
      commit(defaultWidth);
      return;
    }

    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startW = latest.current.width;
    const lo = latest.current.min;
    const hi = effectiveMax();
    let raf = 0;
    let dx = 0;
    let last = startW;

    const flush = () => {
      raf = 0;
      last = Math.max(lo, Math.min(hi, startW + dx));
      latest.current.onChange(last);
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
      if (raf) { cancelAnimationFrame(raf); flush(); }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      cleanupRef.current = null;
      setResizing(false);
      if (last !== startW) latest.current.onChangeEnd?.(last);
    };
    cleanupRef.current = stop;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    setResizing(true);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    let next: number | null = null;
    switch (e.key) {
      case 'ArrowLeft':  next = width - step; break;
      case 'ArrowRight': next = width + step; break;
      case 'Home':       next = defaultWidth; break;
      case 'End':        next = max; break;
      default: return;
    }
    e.preventDefault();
    commit(Math.max(min, Math.min(effectiveMax(), next)));
  }

  return (
    <>
      <div
        ref={elRef}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        tabIndex={0}
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        aria-valuenow={width}
        aria-valuemin={min}
        aria-valuemax={max}
        title="Drag to resize · Double-click to reset"
        className={`absolute top-0 right-0 h-full w-1 cursor-col-resize group z-10 focus-ring ${
          resizing ? 'bg-accent/60' : 'hover:bg-accent/40 focus-visible:bg-accent/40'
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
