import { useCallback, useEffect, useRef } from 'react';
import { useTabs } from './tabs-store';

interface Args {
  tabId:  string;
  /** Ref to the MDI area container — used to read live width/height for clamping. */
  areaRef: React.RefObject<HTMLDivElement | null>;
  /** Called on mousedown so the consumer can flip a `dragging` flag for pointer-events suppression. */
  onDragStart?: () => void;
  /** Called on mouseup. */
  onDragEnd?: () => void;
}

interface DragHandle { onUp: () => void; }

export function useMdiDrag({ tabId, areaRef, onDragStart, onDragEnd }: Args) {
  // Tracks an in-flight drag so the unmount cleanup can tear it down. Without
  // this, closing the tab (or switching view modes) mid-drag would leave the
  // window-level mousemove/mouseup listeners orphaned and holding stale closures.
  const handleRef = useRef<DragHandle | null>(null);

  useEffect(() => {
    return () => { handleRef.current?.onUp(); };
  }, []);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const area = areaRef.current;
    if (!area) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const cur = useTabs.getState().cascade[tabId];
    if (!cur) return;
    if (cur.maximized) return;          // can't drag while maximized
    const startGeom = { x: cur.x, y: cur.y, w: cur.w, h: cur.h };
    const areaW = area.clientWidth;
    const areaH = area.clientHeight;

    e.preventDefault();
    onDragStart?.();

    let raf = 0;
    let latest: { dx: number; dy: number } | null = null;

    function flush() {
      raf = 0;
      if (!latest) return;
      const { dx, dy } = latest;
      latest = null;
      const x = Math.max(0, Math.min(areaW - startGeom.w, startGeom.x + dx));
      const y = Math.max(0, Math.min(areaH - startGeom.h, startGeom.y + dy));
      // Re-check tab still exists (could be closed mid-drag).
      if (!useTabs.getState().cascade[tabId]) return;
      useTabs.getState().setCascadeGeom(tabId, { x, y });
    }

    function onMove(ev: MouseEvent) {
      latest = { dx: ev.clientX - startX, dy: ev.clientY - startY };
      if (raf) return;
      raf = requestAnimationFrame(flush);
    }
    function onUp() {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      handleRef.current = null;
      onDragEnd?.();
    }
    handleRef.current = { onUp };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [tabId, areaRef, onDragStart, onDragEnd]);

  return { onMouseDown };
}
