'use client';

interface Props {
  path: string;
  onNavigate: (p: string) => void;
}

/// Path breadcrumb. Clicking `/` jumps to root; clicking any later segment
/// navigates to that ancestor. Horizontal scrolls on overflow so deep trees
/// don't blow the 256px pane width.
export function SftpBreadcrumb({ path, onNavigate }: Props) {
  const parts = path === '/' ? [] : path.split('/').filter(Boolean);
  return (
    <nav
      aria-label="Remote path"
      className="flex items-center text-xs text-muted gap-1 overflow-x-auto whitespace-nowrap flex-1 min-w-0"
    >
      <button
        type="button"
        onClick={() => onNavigate('/')}
        className="hover:text-fg px-1 rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        /
      </button>
      {parts.map((seg, i) => {
        const full = '/' + parts.slice(0, i + 1).join('/');
        return (
          <span key={full} className="flex items-center gap-1">
            <span aria-hidden>›</span>
            <button
              type="button"
              onClick={() => onNavigate(full)}
              className="hover:text-fg px-1 rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              {seg}
            </button>
          </span>
        );
      })}
    </nav>
  );
}
