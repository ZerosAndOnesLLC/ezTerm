import { describe, expect, it } from 'vitest';
import { isWebUrl, linkClickAction, type LinkClickEvent } from './links';

const click = (over: Partial<LinkClickEvent> = {}): LinkClickEvent => ({
  button: 0, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...over,
});

describe('linkClickAction', () => {
  it('offers the menu on a plain left click', () => {
    expect(linkClickAction(click(), false)).toBe('menu');
  });

  it('opens directly on Ctrl+left click', () => {
    expect(linkClickAction(click({ ctrlKey: true }), false)).toBe('open');
  });

  it('ignores right and middle clicks so copy / paste keep working', () => {
    expect(linkClickAction(click({ button: 2 }), false)).toBeNull();
    expect(linkClickAction(click({ button: 1 }), false)).toBeNull();
    expect(linkClickAction(click({ button: 2, ctrlKey: true }), false)).toBeNull();
  });

  it('ignores the mouse-up that ends a drag-selection', () => {
    expect(linkClickAction(click(), true)).toBeNull();
    expect(linkClickAction(click({ ctrlKey: true }), true)).toBeNull();
  });

  it('leaves selection modifiers alone', () => {
    expect(linkClickAction(click({ shiftKey: true }), false)).toBeNull();
    expect(linkClickAction(click({ altKey: true }), false)).toBeNull();
    expect(linkClickAction(click({ metaKey: true }), false)).toBeNull();
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
