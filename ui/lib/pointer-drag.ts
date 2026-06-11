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
 * mid-drag. `onDragMove` is coalesced to one call per animation frame —
 * consumers do forced-layout hit-testing there, and high-rate mice deliver
 * several pointermoves per frame.
 *
 * Returns a cancel function (or undefined when the gesture can't start a
 * drag); components whose drag surface can unmount mid-drag must call it
 * from their unmount cleanup, or the window listeners outlive the
 * component with stale closures.
 */

const DRAG_THRESHOLD_PX = 4;
/** Distance from the scroll container's edge where auto-scroll kicks in. */
const AUTOSCROLL_EDGE_PX = 28;
/** Auto-scroll speed in px per animation frame. */
const AUTOSCROLL_SPEED_PX = 10;

export interface PointerDragHandlers {
  /** Pointer crossed the drag threshold — show drag visuals. */
  onDragStart(): void;
  /** Pointer moved while dragging (also fired during auto-scroll ticks).
   *  Coalesced to at most one call per animation frame. */
  onDragMove(x: number, y: number): void;
  /** Pointer released while dragging. Not called for cancelled drags. */
  onDrop(x: number, y: number): void;
  /**
   * Drag interaction finished for any reason — drop, Escape, pointer
   * cancel, lost button, or a plain click that never crossed the
   * threshold. Clear all drag state here.
   */
  onEnd(): void;
  /** Container to auto-scroll when the pointer nears its edges. */
  scrollContainer?: () => HTMLElement | null;
  /** Scroll axis for auto-scroll. Defaults to 'y'. */
  axis?: 'x' | 'y';
}

/**
 * After a real drag (or an Escape-cancelled one whose button is released
 * later), the browser still dispatches a `click` on the common ancestor of
 * the pointerdown/pointerup targets. Swallow exactly that one click so a
 * drop or cancel never also activates a tab / toggles a folder.
 *
 * Disarms on the first click it swallows OR on the next `pointerdown`:
 * every other click is necessarily preceded by its own pointerdown, so the
 * squelch can never eat an unrelated gesture's click — and unlike a
 * timeout, this doesn't race a busy main thread delaying the click.
 */
function suppressNextClick(): void {
  const squelch = (ev: MouseEvent) => {
    ev.stopPropagation();
    ev.preventDefault();
    disarm();
  };
  const disarm = () => {
    window.removeEventListener('click', squelch, { capture: true });
    window.removeEventListener('pointerdown', disarm, { capture: true });
  };
  window.addEventListener('click', squelch, { capture: true });
  window.addEventListener('pointerdown', disarm, { capture: true });
}

export function beginPointerDrag(
  e: React.PointerEvent,
  handlers: PointerDragHandlers,
): (() => void) | undefined {
  // Left button only; touch is left to native scrolling. Buttons inside
  // the pressed element (close, delete, panes) are clicks, never drag
  // handles.
  if (e.button !== 0 || e.pointerType === 'touch') return undefined;
  if ((e.target as HTMLElement).closest('button')) return undefined;

  const pointerId = e.pointerId;
  const startX = e.clientX;
  const startY = e.clientY;
  let dragging = false;
  let done = false;
  let lastX = startX;
  let lastY = startY;
  let scrollRaf = 0;
  let moveRaf = 0;
  // Cached at drag start: the container's own rect can't change during a
  // drag (only its scroll offset does), and reading it per frame forces a
  // reflow whenever something else (e.g. xterm output) dirtied layout.
  let scrollRect: DOMRect | null = null;
  const prevUserSelect = document.body.style.userSelect;

  const flushMove = () => {
    moveRaf = 0;
    handlers.onDragMove(lastX, lastY);
  };

  const scrollTick = () => {
    scrollRaf = requestAnimationFrame(scrollTick);
    const container = handlers.scrollContainer?.();
    if (!container || !scrollRect) return;
    const horizontal = handlers.axis === 'x';
    const pos = horizontal ? lastX : lastY;
    const lo = (horizontal ? scrollRect.left : scrollRect.top) + AUTOSCROLL_EDGE_PX;
    const hi = (horizontal ? scrollRect.right : scrollRect.bottom) - AUTOSCROLL_EDGE_PX;
    const delta = pos < lo ? -AUTOSCROLL_SPEED_PX : pos > hi ? AUTOSCROLL_SPEED_PX : 0;
    if (delta === 0) return;
    if (horizontal) container.scrollLeft += delta;
    else container.scrollTop += delta;
    // Content shifted under a stationary pointer — recompute the target.
    handlers.onDragMove(lastX, lastY);
  };

  const teardown = () => {
    done = true;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onKey, true);
    if (scrollRaf) cancelAnimationFrame(scrollRaf);
    if (moveRaf) cancelAnimationFrame(moveRaf);
    if (dragging) document.body.style.userSelect = prevUserSelect;
  };

  /** Abort without dropping: Escape, lost button, pointercancel, or the
   *  owning component unmounting. Safe to call repeatedly. */
  const cancel = () => {
    if (done) return;
    teardown();
    // The button may still be held (Escape mid-drag): its eventual release
    // fires a click with no intervening pointerdown, which the squelch
    // catches; if no such click ever comes, the next pointerdown disarms.
    if (dragging) suppressNextClick();
    handlers.onEnd();
  };

  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    // A pointerup lost outside the window leaves no button held; without
    // this check the drag would stay armed and the user's NEXT click would
    // deliver the drop.
    if (ev.buttons === 0) {
      cancel();
      return;
    }
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
      if (handlers.scrollContainer) {
        scrollRect = handlers.scrollContainer()?.getBoundingClientRect() ?? null;
        scrollRaf = requestAnimationFrame(scrollTick);
      }
    }
    if (!moveRaf) moveRaf = requestAnimationFrame(flushMove);
  };

  const onUp = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId || done) return;
    teardown();
    if (dragging) {
      suppressNextClick();
      handlers.onDrop(ev.clientX, ev.clientY);
    }
    handlers.onEnd();
  };

  const onCancel = (ev: PointerEvent) => {
    if (ev.pointerId === pointerId) cancel();
  };

  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape' && dragging) {
      ev.stopPropagation();
      cancel();
    }
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('keydown', onKey, true);

  return cancel;
}
