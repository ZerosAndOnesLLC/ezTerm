import { describe, expect, it } from 'vitest';
import { placeMenu } from './menu-position';

// 1280x800 window, 8px margin, 360x120 menu.
const at = (x: number, y: number, w = 360, h = 120) => placeMenu(x, y, w, h, 1280, 800, 8);

describe('placeMenu', () => {
  it('opens at the pointer when it fits', () => {
    expect(at(100, 100)).toEqual({ left: 100, top: 100 });
  });

  it('flips left near the right edge', () => {
    expect(at(1200, 100)).toEqual({ left: 1200 - 360, top: 100 });
  });

  it('flips up near the bottom edge', () => {
    expect(at(100, 750)).toEqual({ left: 100, top: 750 - 120 });
  });

  it('flips both ways in the bottom-right corner', () => {
    expect(at(1270, 790)).toEqual({ left: 1270 - 360, top: 790 - 120 });
  });

  it('pins to the margin when flipping would still overflow', () => {
    // 300px from the left edge, menu 360 wide: right side overflows a
    // 400px window and the flipped position would be negative.
    expect(placeMenu(300, 10, 360, 50, 400, 400, 8)).toEqual({ left: 8, top: 10 });
  });

  it('keeps an oversized menu on screen from the top-left', () => {
    expect(placeMenu(50, 50, 2000, 1000, 1280, 800, 8)).toEqual({ left: 8, top: 8 });
  });
});
