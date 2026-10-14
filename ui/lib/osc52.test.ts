import { describe, expect, it } from 'vitest';
import { MAX_OSC52_BYTES, parseOsc52 } from './osc52';

const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64');

describe('parseOsc52', () => {
  it('decodes a clipboard write', () => {
    expect(parseOsc52(`c;${b64('hello')}`)).toEqual({ kind: 'write', text: 'hello' });
  });

  it('decodes UTF-8 payloads', () => {
    const text = 'naïve — 日本語 🚀';
    expect(parseOsc52(`c;${b64(text)}`)).toEqual({ kind: 'write', text });
  });

  it('treats an empty selector as the clipboard', () => {
    expect(parseOsc52(`;${b64('x')}`)).toEqual({ kind: 'write', text: 'x' });
  });

  it('accepts primary / select selectors and multi-char selectors', () => {
    expect(parseOsc52(`p;${b64('x')}`).kind).toBe('write');
    expect(parseOsc52(`s;${b64('x')}`).kind).toBe('write');
    expect(parseOsc52(`pc;${b64('x')}`).kind).toBe('write');
  });

  it('ignores cut-buffer-only selectors', () => {
    expect(parseOsc52(`0;${b64('x')}`).kind).toBe('ignore');
    expect(parseOsc52(`q;${b64('x')}`).kind).toBe('ignore');
  });

  it('reports the read form instead of decoding it', () => {
    expect(parseOsc52('c;?')).toEqual({ kind: 'read' });
  });

  it('tolerates whitespace-wrapped base64', () => {
    const wrapped = b64('a somewhat longer string').replace(/(.{8})/g, '$1\n');
    expect(parseOsc52(`c;${wrapped}`)).toEqual({ kind: 'write', text: 'a somewhat longer string' });
  });

  it('accepts unpadded base64', () => {
    expect(parseOsc52('c;aGVsbG8')).toEqual({ kind: 'write', text: 'hello' });   // 'hello', pad stripped
    expect(parseOsc52('c;aGk')).toEqual({ kind: 'write', text: 'hi' });          // 2 chars of padding missing
  });

  it('strips NUL bytes from the decoded text', () => {
    expect(parseOsc52(`c;${b64('ab\0cd')}`)).toEqual({ kind: 'write', text: 'abcd' });
  });

  it('ignores malformed input without throwing', () => {
    expect(parseOsc52('c').kind).toBe('ignore');
    expect(parseOsc52('c;').kind).toBe('ignore');
    expect(parseOsc52('c;not base64!').kind).toBe('ignore');
    expect(parseOsc52('c;abcde').kind).toBe('ignore'); // length 1 mod 4
  });

  it('refuses payloads over the size cap before decoding', () => {
    const chars = Math.ceil(MAX_OSC52_BYTES / 3) * 4 + 4;
    expect(parseOsc52(`c;${'A'.repeat(chars)}`).kind).toBe('ignore');
  });
});
