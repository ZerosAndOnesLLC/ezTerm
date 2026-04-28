'use client';
import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';
import { Terminal } from 'lucide-react';
import { useTabs, type Tab } from '@/lib/tabs-store';
import { EmptyState } from './empty-state';
import { SftpPane } from './sftp-pane';
import { MdiFrame } from './mdi-frame';
import { MinimizedStrip } from './minimized-strip';

const TerminalView = dynamic(
  () => import('./terminal').then((m) => m.TerminalView),
  { ssr: false },
);

export function MdiArea() {
  const tabs      = useTabs((s) => s.tabs);
  const activeId  = useTabs((s) => s.activeId);
  const viewMode  = useTabs((s) => s.viewMode);
  const minimized = useTabs((s) => s.minimized);

  if (tabs.length === 0) {
    return (
      <EmptyState
        icon={Terminal}
        title="Ready to connect"
        body="Double-click a session in the sidebar, or create a new one to get started."
      />
    );
  }

  if (viewMode === 'tabs') {
    return <TabsLayout tabs={tabs} activeId={activeId} />;
  }

  const visible = tabs.filter((t) => !minimized.has(t.tabId));

  if (viewMode === 'tile-h' || viewMode === 'tile-v') {
    return <TileFlexLayout tabs={visible} dir={viewMode === 'tile-h' ? 'col' : 'row'} />;
  }
  if (viewMode === 'tile-grid' || viewMode === 'auto') {
    return <TileGridLayout tabs={visible} mode={viewMode} />;
  }
  // 'cascade' is the last ViewMode; the union is exhausted above.
  return <CascadeLayout tabs={visible} />;
}

function TabsLayout({ tabs, activeId }: { tabs: Tab[]; activeId: string | null }) {
  return (
    <div className="absolute inset-0">
      {tabs.map((t) => {
        const active = t.tabId === activeId;
        return (
          <div
            key={t.tabId}
            className="absolute inset-0 flex"
            style={{
              visibility: active ? 'visible' : 'hidden',
              pointerEvents: active ? 'auto' : 'none',
            }}
            aria-hidden={!active}
          >
            {t.sftpOpen && t.session.session_kind === 'ssh' && <SftpPane tab={t} />}
            <div className="flex-1 min-h-0 relative">
              <TerminalView tab={t} visible={active} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TileFlexLayout({ tabs, dir }: { tabs: Tab[]; dir: 'row' | 'col' }) {
  const setActive = useTabs((s) => s.setActive);
  return (
    <div className={`absolute inset-0 flex ${dir === 'col' ? 'flex-col' : 'flex-row'} gap-px bg-border`}>
      {tabs.map((t) => (
        <div
          key={t.tabId}
          className="flex-1 min-w-0 min-h-0 bg-bg relative"
          onMouseDown={() => setActive(t.tabId)}
        >
          <TerminalView tab={t} visible={true} />
        </div>
      ))}
    </div>
  );
}

function TileGridLayout({ tabs, mode }: { tabs: Tab[]; mode: 'tile-grid' | 'auto' }) {
  const setActive = useTabs((s) => s.setActive);
  const tileGrid  = useTabs((s) => s.tileGrid);

  let rows: number;
  let cols: number;
  if (mode === 'auto') {
    const n = Math.max(1, tabs.length);
    cols = Math.ceil(Math.sqrt(n));
    rows = Math.ceil(n / cols);
  } else {
    ({ rows, cols } = tileGrid);
  }

  return (
    <div
      className="absolute inset-0 grid gap-px bg-border overflow-auto"
      style={{
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridTemplateRows:    `repeat(${rows}, minmax(160px, 1fr))`,
        gridAutoRows:        'minmax(160px, 1fr)',
      }}
    >
      {tabs.map((t) => (
        <div
          key={t.tabId}
          className="min-w-0 min-h-0 bg-bg relative"
          onMouseDown={() => setActive(t.tabId)}
        >
          <TerminalView tab={t} visible={true} />
        </div>
      ))}
    </div>
  );
}

function CascadeLayout({ tabs }: { tabs: Tab[] }) {
  const areaRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [dragging, setDragging] = useState(false);
  // Strip reservation only depends on whether ANY tab is minimized — pulling
  // a boolean keeps this layout from re-rendering on every status tick.
  const hasMinimized = useTabs((s) => s.minimized.size > 0);

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      // Skip the state write when the dimensions haven't actually changed.
      // ResizeObserver fires for sub-pixel changes too, which would otherwise
      // re-render every MdiFrame and re-fit every xterm via prop change.
      setSize((cur) => (cur.w === w && cur.h === h ? cur : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 28px reserve for the strip when at least one tab is minimized.
  const stripH = hasMinimized ? 28 : 0;

  return (
    <div className="absolute inset-0 bg-surface2/30">
      <div
        ref={areaRef}
        className="absolute left-0 right-0 top-0"
        style={{ bottom: stripH }}
      >
        <div
          className="absolute inset-0"
          style={{ pointerEvents: dragging ? 'none' : 'auto' }}
        >
          {size.w > 0 && size.h > 0 && tabs.map((t) => (
            <MdiFrame
              key={t.tabId}
              tab={t}
              areaRef={areaRef}
              areaW={size.w}
              areaH={size.h}
              setDragging={setDragging}
            />
          ))}
        </div>
      </div>
      <MinimizedStrip />
    </div>
  );
}

