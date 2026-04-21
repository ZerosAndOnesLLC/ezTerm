'use client';
import { useEffect, useRef, useState } from 'react';
import { CaseSensitive, ChevronDown, ChevronUp, Regex, X } from 'lucide-react';
import type { SearchAddon } from '@xterm/addon-search';

export function FindOverlay({ search, onClose }: { search: SearchAddon; onClose: () => void }) {
  const [q, setQ]   = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [re, setRe] = useState(false);
  const [result, setResult] = useState<{ idx: number; count: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Wire the search addon's result callback so the match counter reflects
  // reality. Guard the optional API — older versions of the addon don't
  // expose `onDidChangeResults`.
  useEffect(() => {
    const addon = search as unknown as {
      onDidChangeResults?: (cb: (r: { resultIndex: number; resultCount: number }) => void) => {
        dispose: () => void;
      };
    };
    if (!addon.onDidChangeResults) return;
    const sub = addon.onDidChangeResults(({ resultIndex, resultCount }) => {
      setResult(resultCount > 0 ? { idx: resultIndex + 1, count: resultCount } : null);
    });
    return () => sub.dispose();
  }, [search]);

  function runNext() {
    if (q) search.findNext(q, { caseSensitive, regex: re });
  }
  function runPrev() {
    if (q) search.findPrevious(q, { caseSensitive, regex: re });
  }

  return (
    <div className="absolute top-2 right-2 bg-surface border border-border rounded-md px-1.5 py-1 flex items-center gap-1 text-xs shadow-menu">
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) runPrev(); else runNext(); }
          if (e.key === 'Escape') onClose();
        }}
        placeholder="Find"
        aria-label="Find"
        className="bg-surface2 border border-border rounded-sm px-2 py-1 outline-none focus:border-accent w-44"
      />
      {q && (
        <span className="text-muted tabular-nums px-1 min-w-[48px] text-center">
          {result ? `${result.idx}/${result.count}` : '0/0'}
        </span>
      )}
      <button
        type="button"
        onClick={() => setCaseSensitive((v) => !v)}
        aria-pressed={caseSensitive}
        title="Case sensitive"
        className="icon-btn w-6 h-6"
      >
        <CaseSensitive size={13} />
      </button>
      <button
        type="button"
        onClick={() => setRe((v) => !v)}
        aria-pressed={re}
        title="Regular expression"
        className="icon-btn w-6 h-6"
      >
        <Regex size={13} />
      </button>
      <button type="button" onClick={runPrev} aria-label="Previous match" title="Previous (Shift+Enter)" className="icon-btn w-6 h-6">
        <ChevronUp size={13} />
      </button>
      <button type="button" onClick={runNext} aria-label="Next match" title="Next (Enter)" className="icon-btn w-6 h-6">
        <ChevronDown size={13} />
      </button>
      <button type="button" onClick={onClose} aria-label="Close find" title="Close (Esc)" className="icon-btn w-6 h-6">
        <X size={13} />
      </button>
    </div>
  );
}
