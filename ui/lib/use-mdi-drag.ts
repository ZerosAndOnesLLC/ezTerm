import { useCallback } from 'react';
import { useTabs } from './tabs-store';

interface Args {
  tabId:  string;
  /** Ref to the MDI area container — used to read live width/height for clamping. */
  areaRef: React.RefObject<HTMLDivElement>;
  /** Called on mousedown so the consumer can flip a `dragging` flag for pointer-events suppression. */
  onDragStart?: () => void;
  /** Called on mouseup. */
  onDragEnd?: () => void;
}

export function useMdiDrag({ tabId, areaRef, onDragStart, onDragEnd }: Args) {
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

    function onMove(ev: MouseEvent) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const x = Math.max(0, Math.min(areaW - startGeom.w, startGeom.x + dx));
      const y = Math.max(0, Math.min(areaH - startGeom.h, startGeom.y + dy));
      // Re-check tab still exists (could be closed mid-drag).
      const live = useTabs.getState().cascade[tabId];
      if (!live) return;
      useTabs.getState().setCascadeGeom(tabId, { x, y });
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      onDragEnd?.();
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [tabId, areaRef, onDragStart, onDragEnd]);

  return { onMouseDown };
}
