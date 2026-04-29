'use client';
import { useEffect, useRef, useState } from 'react';
import { Terminal } from 'lucide-react';
import { useTabs } from '@/lib/tabs-store';
import { EmptyState } from './empty-state';
import { TabSlot } from './tab-slot';
import { MinimizedStrip } from './minimized-strip';

export function MdiArea() {
  const tabs      = useTabs((s) => s.tabs);
  const activeId  = useTabs((s) => s.activeId);
  const viewMode  = useTabs((s) => s.viewMode);
  const minimized = useTabs((s) => s.minimized);
  const tileGrid  = useTabs((s) => s.tileGrid);
  // Note: do NOT subscribe to s.cascade here. Each TabSlot reads its own
  // slice via useTabs((s) => s.cascade[tab.tabId]) so a cascade-drag at
  // 60Hz only re-renders the dragged slot, not every slot.

  // Cascade area metadata is hoisted here so it stays live across all view
  // modes. The MdiArea root div doubles as the cascade area for clamping.
  // In non-cascade modes setSize / dragging are still updated by the
  // ResizeObserver but nothing consumes them.
  const areaRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      // Skip the state write when dimensions are unchanged. ResizeObserver
      // fires for sub-pixel changes too, which would re-render every
      // TabSlot and re-fit every xterm via prop change.
      setSize((cur) => (cur.w === w && cur.h === h ? cur : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (tabs.length === 0) {
    return (
      <EmptyState
        icon={Terminal}
        title="Ready to connect"
        body="Double-click a session in the sidebar, or create a new one to get started."
      />
    );
  }

  // Root container styling depends on the layout direction needed by the
  // children. Tabs/cascade are absolutely-positioned children — the root is
  // a positioning context. Tile modes use flex/grid on the root.
  let rootClass = 'absolute inset-0';
  let rootStyle: React.CSSProperties = {};
  switch (viewMode) {
    case 'tabs':
      rootClass = 'absolute inset-0';
      break;
    case 'tile-h':
      rootClass = 'absolute inset-0 flex flex-col gap-px bg-borderStrong';
      break;
    case 'tile-v':
      rootClass = 'absolute inset-0 flex flex-row gap-px bg-borderStrong';
      break;
    case 'tile-grid':
    case 'auto': {
      const visibleCount = tabs.filter((t) => !minimized.has(t.tabId)).length;
      let rows: number;
      let cols: number;
      if (viewMode === 'auto') {
        const n = Math.max(1, visibleCount);
        cols = Math.ceil(Math.sqrt(n));
        rows = Math.ceil(n / cols);
      } else {
        ({ rows, cols } = tileGrid);
      }
      rootClass = 'absolute inset-0 grid gap-px bg-borderStrong overflow-auto';
      rootStyle = {
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridTemplateRows:    `repeat(${rows}, minmax(160px, 1fr))`,
        gridAutoRows:        'minmax(160px, 1fr)',
      };
      break;
    }
    case 'cascade':
      rootClass = 'absolute inset-0 bg-surface2/30';
      break;
  }

  // Strip reservation only depends on whether ANY tab is minimized. Pulling
  // a boolean keeps this from re-rendering on every status tick.
  const hasMinimized = minimized.size > 0;
  const stripH = viewMode === 'cascade' && hasMinimized ? 28 : 0;

  return (
    <div className="absolute inset-0">
      <div
        ref={areaRef}
        className={rootClass}
        style={{ ...rootStyle, bottom: stripH > 0 ? stripH : undefined }}
      >
        {tabs.map((t) => (
          <TabSlot
            key={t.tabId}
            tab={t}
            viewMode={viewMode}
            isActive={t.tabId === activeId}
            isMinimized={minimized.has(t.tabId)}
            cascadeAreaRef={areaRef}
            cascadeAreaW={size.w}
            cascadeAreaH={size.h}
            dragging={dragging}
            setDragging={setDragging}
          />
        ))}
      </div>
      {viewMode === 'cascade' && <MinimizedStrip />}
    </div>
  );
}
