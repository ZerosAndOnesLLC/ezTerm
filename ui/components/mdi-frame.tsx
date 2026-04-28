'use client';
import dynamic from 'next/dynamic';
import { Maximize2, Minimize2, Minus, X } from 'lucide-react';
import type { RefObject } from 'react';
import { useTabs, type Tab } from '@/lib/tabs-store';
import { useMdiDrag } from '@/lib/use-mdi-drag';
import { useMdiResize, type ResizeEdge } from '@/lib/use-mdi-resize';
import { StatusDot } from './status-dot';

const TerminalView = dynamic(
  () => import('./terminal').then((m) => m.TerminalView),
  { ssr: false },
);

interface Props {
  tab:     Tab;
  areaRef: RefObject<HTMLDivElement>;
  areaW:   number;
  areaH:   number;
  setDragging: (v: boolean) => void;
}

const HANDLES: readonly { edge: ResizeEdge; cls: string; cursor: string }[] = [
  { edge: 'n',  cls: 'top-0 left-2 right-2 h-1',                cursor: 'ns-resize' },
  { edge: 's',  cls: 'bottom-0 left-2 right-2 h-1',             cursor: 'ns-resize' },
  { edge: 'e',  cls: 'top-2 bottom-2 right-0 w-1',              cursor: 'ew-resize' },
  { edge: 'w',  cls: 'top-2 bottom-2 left-0 w-1',               cursor: 'ew-resize' },
  { edge: 'ne', cls: 'top-0 right-0 w-2 h-2',                   cursor: 'nesw-resize' },
  { edge: 'nw', cls: 'top-0 left-0 w-2 h-2',                    cursor: 'nwse-resize' },
  { edge: 'se', cls: 'bottom-0 right-0 w-2 h-2',                cursor: 'nwse-resize' },
  { edge: 'sw', cls: 'bottom-0 left-0 w-2 h-2',                 cursor: 'nesw-resize' },
];

export function MdiFrame({ tab, areaRef, areaW, areaH, setDragging }: Props) {
  const cascade  = useTabs((s) => s.cascade[tab.tabId]);
  const activeId = useTabs((s) => s.activeId);
  const setActive     = useTabs((s) => s.setActive);
  const bringToFront  = useTabs((s) => s.bringToFront);
  const minimize      = useTabs((s) => s.minimize);
  const toggleMax     = useTabs((s) => s.toggleMaximize);
  const close         = useTabs((s) => s.close);

  const drag = useMdiDrag({
    tabId: tab.tabId, areaRef,
    onDragStart: () => setDragging(true),
    onDragEnd:   () => setDragging(false),
  });

  if (!cascade) return null;

  // Display-only clamp so a previously-stored geometry doesn't leak off-screen
  // after a window resize. We don't write back; user dragging will normalise.
  const w = Math.min(cascade.w, Math.max(200, areaW));
  const h = Math.min(cascade.h, Math.max(120, areaH));
  const x = Math.max(0, Math.min(areaW - w, cascade.x));
  const y = Math.max(0, Math.min(areaH - h, cascade.y));

  const isActive = tab.tabId === activeId;

  function focusFrame() {
    if (tab.tabId !== activeId) setActive(tab.tabId);
    bringToFront(tab.tabId);
  }

  return (
    <div
      className={`absolute bg-bg border rounded-md shadow-lg flex flex-col overflow-hidden ${
        isActive ? 'border-accent' : 'border-border'
      }`}
      style={{ left: x, top: y, width: w, height: h, zIndex: cascade.z }}
      onMouseDown={focusFrame}
      role="group"
      aria-label={`${tab.session.name} window`}
    >
      <div
        className={`h-6 flex items-center gap-2 px-2 select-none cursor-move border-b border-border ${
          isActive ? 'bg-surface' : 'bg-surface/70'
        }`}
        onMouseDown={drag.onMouseDown}
        onDoubleClick={() => toggleMax(tab.tabId, areaW, areaH)}
      >
        <StatusDot status={tab.status} />
        <span className="truncate text-xs flex-1" title={`${tab.session.username}@${tab.session.host}`}>
          {tab.session.name}
        </span>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); minimize(tab.tabId); }}
          title="Minimize"
          aria-label="Minimize"
          className="icon-btn w-5 h-5"
        >
          <Minus size={11} />
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); toggleMax(tab.tabId, areaW, areaH); }}
          title={cascade.maximized ? 'Restore' : 'Maximize'}
          aria-label={cascade.maximized ? 'Restore' : 'Maximize'}
          className="icon-btn w-5 h-5"
        >
          {cascade.maximized ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); close(tab.tabId); }}
          title="Close"
          aria-label="Close"
          className="icon-btn w-5 h-5 hover:text-danger"
        >
          <X size={11} />
        </button>
      </div>
      <div className="flex-1 min-h-0 relative">
        <TerminalView tab={tab} visible={true} />
      </div>
      {!cascade.maximized && HANDLES.map((h) => (
        <ResizeHandle key={h.edge} tabId={tab.tabId} areaRef={areaRef} edge={h.edge}
                      cls={h.cls} cursor={h.cursor} setDragging={setDragging} />
      ))}
    </div>
  );
}

interface HandleProps {
  tabId: string;
  areaRef: RefObject<HTMLDivElement>;
  edge: ResizeEdge;
  cls: string;
  cursor: string;
  setDragging: (v: boolean) => void;
}

function ResizeHandle({ tabId, areaRef, edge, cls, cursor, setDragging }: HandleProps) {
  const r = useMdiResize({
    tabId, edge, areaRef,
    onDragStart: () => setDragging(true),
    onDragEnd:   () => setDragging(false),
  });
  return (
    <div
      className={`absolute ${cls}`}
      style={{ cursor }}
      onMouseDown={r.onMouseDown}
      aria-hidden
    />
  );
}
