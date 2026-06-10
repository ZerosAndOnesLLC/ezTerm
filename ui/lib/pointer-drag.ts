/**
 * Pointer-event drag helper — replaces HTML5 drag-and-drop for in-app
 * reordering (tab bar, sessions tree).
 *
 * Why not HTML5 DnD: WebKitGTK's native drag implementation can take the
 * pointer grab and never release it (drag-end never fires), hard-freezing
 * the whole app on Linux — see issue #109 and
 * https://bugs.webkit.org/show_bug.cgi?id=32840. Pointer events run
 * entirely inside the webview's normal event loop, so they behave
 * identically on Windows, macOS, and Linux.
 *
 * Call from a `pointerdown` handler. The drag only starts once the pointer
 * moves past a small threshold, so plain clicks (and double-clicks) on the
 * same element keep working. Listeners go on `window` rather than using
 * pointer capture so the drag survives React re-rendering the source row
 * mid-drag.
 */

const DRAG_THRESHOLD_PX = 4;
/** Distance from the scroll container's edge where auto-scroll kicks in. */
const AUTOSCROLL_EDGE_PX = 28;
/** Auto-scroll speed in px per animation frame. */
const AUTOSCROLL_SPEED_PX = 10;

export interface PointerDragHandlers {
  /** Pointer crossed the drag threshold — show drag visuals. */
  onDragStart(): void;
  /** Pointer moved while dragging (also fired during auto-scroll ticks). */
  onDragMove(x: number, y: number): void;
  /** Pointer released while dragging. Not called for cancelled drags. */
  onDrop(x: number, y: number): void;
  /**
   * Drag interaction finished for any reason — drop, Escape, pointer
   * cancel, or a plain click that never crossed the threshold. Clear all
   * drag state here.
   */
  onEnd(): void;
  /** Container to auto-scroll when the pointer nears its edges. */
  scrollContainer?: () => HTMLElement | null;
  /** Scroll axis for auto-scroll. Defaults to 'y'. */
  axis?: 'x' | 'y';
}

/**
 * After a real drag, the browser still dispatches a `click` on the common
 * ancestor of pointerdown/pointerup targets. Swallow exactly that one click
 * so drops don't also activate tabs / toggle folders. The listener removes
 * itself on the next macrotask if no click fired (e.g. drop outside).
 */
function suppressNextClick(): void {
  const squelch = (ev: MouseEvent) => {
    ev.stopPropagation();
    ev.preventDefault();
  };
  window.addEventListener('click', squelch, { capture: true });
  window.setTimeout(
    () => window.removeEventListener('click', squelch, { capture: true }),
    0,
  );
}

export function beginPointerDrag(
  e: React.PointerEvent,
  handlers: PointerDragHandlers,
): void {
  // Left button only; touch is left to native scrolling.
  if (e.button !== 0 || e.pointerType === 'touch') return;

  const pointerId = e.pointerId;
  const startX = e.clientX;
  const startY = e.clientY;
  let dragging = false;
  let lastX = startX;
  let lastY = startY;
  let raf = 0;
  const prevUserSelect = document.body.style.userSelect;

  const scrollTick = () => {
    raf = requestAnimationFrame(scrollTick);
    const container = handlers.scrollContainer?.();
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const horizontal = handlers.axis === 'x';
    const pos = horizontal ? lastX : lastY;
    const lo = (horizontal ? rect.left : rect.top) + AUTOSCROLL_EDGE_PX;
    const hi = (horizontal ? rect.right : rect.bottom) - AUTOSCROLL_EDGE_PX;
    const delta = pos < lo ? -AUTOSCROLL_SPEED_PX : pos > hi ? AUTOSCROLL_SPEED_PX : 0;
    if (delta === 0) return;
    if (horizontal) container.scrollLeft += delta;
    else container.scrollTop += delta;
    // Content shifted under a stationary pointer — recompute the target.
    handlers.onDragMove(lastX, lastY);
  };

  const finish = (drop: boolean, ev?: PointerEvent) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onKey, true);
    if (raf) cancelAnimationFrame(raf);
    if (dragging) {
      document.body.style.userSelect = prevUserSelect;
      suppressNextClick();
      if (drop && ev) handlers.onDrop(ev.clientX, ev.clientY);
    }
    handlers.onEnd();
  };

  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    lastX = ev.clientX;
    lastY = ev.clientY;
    if (!dragging) {
      if (
        Math.abs(ev.clientX - startX) < DRAG_THRESHOLD_PX &&
        Math.abs(ev.clientY - startY) < DRAG_THRESHOLD_PX
      ) {
        return;
      }
      dragging = true;
      document.body.style.userSelect = 'none';
      handlers.onDragStart();
      if (handlers.scrollContainer) raf = requestAnimationFrame(scrollTick);
    }
    handlers.onDragMove(ev.clientX, ev.clientY);
  };

  const onUp = (ev: PointerEvent) => {
    if (ev.pointerId === pointerId) finish(true, ev);
  };
  const onCancel = (ev: PointerEvent) => {
    if (ev.pointerId === pointerId) finish(false);
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape' && dragging) {
      ev.stopPropagation();
      finish(false);
    }
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('keydown', onKey, true);
}
