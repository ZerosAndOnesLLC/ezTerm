'use client';
import { ChevronRight, Slash } from 'lucide-react';

interface Props {
  path: string;
  onNavigate: (p: string) => void;
}

/// Path breadcrumb. Clicking the root icon jumps to `/`; clicking any later
/// segment navigates to that ancestor. Horizontal scrolls on overflow so deep
/// trees don't blow the pane width.
export function SftpBreadcrumb({ path, onNavigate }: Props) {
  const parts = path === '/' ? [] : path.split('/').filter(Boolean);
  return (
    <nav
      aria-label="Remote path"
      className="flex items-center text-xs text-muted overflow-x-auto whitespace-nowrap min-w-0 font-mono"
    >
      <button
        type="button"
        onClick={() => onNavigate('/')}
        title="Root"
        aria-label="Root"
        className="hover:text-fg px-1 h-6 flex items-center rounded focus-ring"
      >
        <Slash size={12} />
      </button>
      {parts.map((seg, i) => {
        const full = '/' + parts.slice(0, i + 1).join('/');
        const last = i === parts.length - 1;
        return (
          <span key={full} className="flex items-center">
            <ChevronRight size={12} className="text-muted/60 shrink-0" />
            <button
              type="button"
              onClick={() => onNavigate(full)}
              className={`px-1 h-6 flex items-center rounded focus-ring hover:text-fg ${
                last ? 'text-fg' : 'text-muted'
              }`}
            >
              {seg}
            </button>
          </span>
        );
      })}
    </nav>
  );
}
