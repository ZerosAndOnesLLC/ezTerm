'use client';
import { useEffect, useRef, useState } from 'react';
import type { SearchAddon } from '@xterm/addon-search';

export function FindOverlay({ search, onClose }: { search: SearchAddon; onClose: () => void }) {
  const [q, setQ]   = useState('');
  const [ci, setCi] = useState(false); // case-insensitive
  const [re, setRe] = useState(false); // regex
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  function runNext() {
    if (q) search.findNext(q, { caseSensitive: !ci, regex: re });
  }
  function runPrev() {
    if (q) search.findPrevious(q, { caseSensitive: !ci, regex: re });
  }

  return (
    <div className="absolute top-2 right-2 bg-surface2 border border-border rounded px-2 py-1 flex items-center gap-2 text-sm shadow-lg">
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? runPrev() : runNext(); }
          if (e.key === 'Escape') onClose();
        }}
        placeholder="Find"
        aria-label="Find"
        className="bg-surface border border-border rounded px-2 py-0.5 outline-none focus-visible:ring-1 focus-visible:ring-accent w-48"
      />
      <button
        type="button"
        onClick={() => setCi(!ci)}
        aria-pressed={!ci}
        title="Case sensitive"
        className={`px-1 rounded ${!ci ? 'bg-accent text-white' : 'hover:bg-surface'}`}
      >Aa</button>
      <button
        type="button"
        onClick={() => setRe(!re)}
        aria-pressed={re}
        title="Regex"
        className={`px-1 rounded ${re ? 'bg-accent text-white' : 'hover:bg-surface'}`}
      >.*</button>
      <button type="button" onClick={runPrev} aria-label="Previous" className="hover:text-fg">↑</button>
      <button type="button" onClick={runNext} aria-label="Next" className="hover:text-fg">↓</button>
      <button type="button" onClick={onClose} aria-label="Close" className="hover:text-fg">×</button>
    </div>
  );
}
