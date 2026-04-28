import { useCallback, useEffect, useRef } from 'react';
import { useTabs } from './tabs-store';

export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const MIN_W = 200;
const MIN_H = 120;

interface Args {
  tabId:   string;
  edge:    ResizeEdge;
  areaRef: React.RefObject<HTMLDivElement>;
  onDragStart?: () => void;
  onDragEnd?:   () => void;
}

interface ResizeHandle { onUp: () => void; }

export function useMdiResize({ tabId, edge, areaRef, onDragStart, onDragEnd }: Args) {
  // See useMdiDrag for the same unmount-during-drag rationale.
  const handleRef = useRef<ResizeHandle | null>(null);

  useEffect(() => {
    return () => { handleRef.current?.onUp(); };
  }, []);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const area = areaRef.current;
    if (!area) return;
    const cur = useTabs.getState().cascade[tabId];
    if (!cur || cur.maximized) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const start  = { x: cur.x, y: cur.y, w: cur.w, h: cur.h };
    const areaW = area.clientWidth;
    const areaH = area.clientHeight;

    e.preventDefault();
    e.stopPropagation();   // don't trigger title-bar drag from a corner
    onDragStart?.();

    let raf = 0;
    let latest: { dx: number; dy: number } | null = null;

    function flush() {
      raf = 0;
      if (!latest) return;
      const { dx, dy } = latest;
      latest = null;

      let { x, y, w, h } = start;

      if (edge.includes('e')) {
        w = Math.max(MIN_W, Math.min(areaW - start.x, start.w + dx));
      }
      if (edge.includes('w')) {
        // West edge: x and w move opposite.
        const newX = Math.max(0, Math.min(start.x + start.w - MIN_W, start.x + dx));
        w = start.w + (start.x - newX);
        x = newX;
      }
      if (edge.includes('s')) {
        h = Math.max(MIN_H, Math.min(areaH - start.y, start.h + dy));
      }
      if (edge.includes('n')) {
        const newY = Math.max(0, Math.min(start.y + start.h - MIN_H, start.y + dy));
        h = start.h + (start.y - newY);
        y = newY;
      }

      if (!useTabs.getState().cascade[tabId]) return;
      useTabs.getState().setCascadeGeom(tabId, { x, y, w, h });
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
  }, [tabId, edge, areaRef, onDragStart, onDragEnd]);

  return { onMouseDown };
}
