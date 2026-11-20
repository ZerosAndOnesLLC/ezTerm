import { describe, expect, it } from 'vitest';
import { isWebUrl, linkClickAction, openLinkShortcut, type LinkClickEvent } from './links';

const click = (over: Partial<LinkClickEvent> = {}): LinkClickEvent => ({
  button: 0, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...over,
});

describe.each([
  { os: 'Windows / Linux', isMac: false },
  { os: 'macOS', isMac: true },
])('linkClickAction on $os', ({ isMac }) => {
  it('offers the menu on a plain left click', () => {
    expect(linkClickAction(click(), false, isMac)).toBe('menu');
  });

  it('ignores right and middle clicks so copy / paste keep working', () => {
    expect(linkClickAction(click({ button: 2 }), false, isMac)).toBeNull();
    expect(linkClickAction(click({ button: 1 }), false, isMac)).toBeNull();
  });

  it('ignores the mouse-up that ends a drag-selection', () => {
    expect(linkClickAction(click(), true, isMac)).toBeNull();
  });

  it('leaves selection modifiers alone', () => {
    expect(linkClickAction(click({ shiftKey: true }), false, isMac)).toBeNull();
    expect(linkClickAction(click({ altKey: true }), false, isMac)).toBeNull();
  });
});

describe('linkClickAction open modifier', () => {
  it('opens on Ctrl+click off macOS, ignoring Meta', () => {
    expect(linkClickAction(click({ ctrlKey: true }), false, false)).toBe('open');
    expect(linkClickAction(click({ metaKey: true }), false, false)).toBeNull();
  });

  it('opens on Cmd+click on macOS', () => {
    expect(linkClickAction(click({ metaKey: true }), false, true)).toBe('open');
  });

  it('ignores Ctrl+click on macOS, where it is the secondary click', () => {
    expect(linkClickAction(click({ ctrlKey: true }), false, true)).toBeNull();
  });

  it('never opens a right click, whatever the modifier', () => {
    expect(linkClickAction(click({ button: 2, ctrlKey: true }), false, false)).toBeNull();
    expect(linkClickAction(click({ button: 2, metaKey: true }), false, true)).toBeNull();
  });

  it('never opens after a drag-selection', () => {
    expect(linkClickAction(click({ ctrlKey: true }), true, false)).toBeNull();
    expect(linkClickAction(click({ metaKey: true }), true, true)).toBeNull();
  });

  it('labels the gesture per platform', () => {
    expect(openLinkShortcut(false)).toBe('Ctrl+Click');
    expect(openLinkShortcut(true)).toBe('Cmd+Click');
  });
});

describe('isWebUrl', () => {
  it('accepts http and https', () => {
    expect(isWebUrl('https://example.com/path?q=1')).toBe(true);
    expect(isWebUrl('http://10.0.0.5:8080/')).toBe(true);
  });

  it('rejects other schemes and junk', () => {
    expect(isWebUrl('file:///C:/Windows/System32/calc.exe')).toBe(false);
    expect(isWebUrl('javascript:alert(1)')).toBe(false);
    expect(isWebUrl('ms-settings:privacy')).toBe(false);
    expect(isWebUrl('not a url')).toBe(false);
    expect(isWebUrl('')).toBe(false);
  });
});
