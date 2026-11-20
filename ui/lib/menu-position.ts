/** Gap kept between a menu and the window edge. */
export const MENU_EDGE_MARGIN = 8;

/** Where to put a menu of `width` x `height` opened at the pointer
 *  (`x`, `y`) so it stays inside a `viewW` x `viewH` window.
 *
 *  Like native context menus, it opens to the right of / below the pointer
 *  and flips to the left / above when that side would overflow. A menu
 *  bigger than the window on an axis pins to the margin rather than going
 *  negative, so its top-left (header, first items) stays reachable. */
export function placeMenu(
  x: number, y: number,
  width: number, height: number,
  viewW: number, viewH: number,
  margin: number = MENU_EDGE_MARGIN,
): { left: number; top: number } {
  return {
    left: placeAxis(x, width, viewW, margin),
    top:  placeAxis(y, height, viewH, margin),
  };
}

function placeAxis(pointer: number, size: number, view: number, margin: number): number {
  let pos = pointer;
  if (pos + size > view - margin) pos = pointer - size; // flip
  const max = view - margin - size;
  if (pos > max) pos = max;
  if (pos < margin) pos = margin;
  return pos;
}
