'use client';
import { Maximize2, Minimize2, Minus, X } from 'lucide-react';
import type { RefObject } from 'react';
import { useTabs, type Tab } from '@/lib/tabs-store';
import { useMdiDrag } from '@/lib/use-mdi-drag';
import { useMdiResize, type ResizeEdge } from '@/lib/use-mdi-resize';
import { StatusDot } from './status-dot';

interface Props {
  tab: Tab;
  areaRef: RefObject<HTMLDivElement | null>;
  areaW: number;
  areaH: number;
  setDragging: (v: boolean) => void;
  maximized: boolean;
}

const HANDLES: readonly { edge: ResizeEdge; cls: string; cursor: string }[] = [
  { edge: 'n',  cls: 'top-0 left-2 right-2 h-1',    cursor: 'ns-resize'   },
  { edge: 's',  cls: 'bottom-0 left-2 right-2 h-1', cursor: 'ns-resize'   },
  { edge: 'e',  cls: 'top-2 bottom-2 right-0 w-1',  cursor: 'ew-resize'   },
  { edge: 'w',  cls: 'top-2 bottom-2 left-0 w-1',   cursor: 'ew-resize'   },
  { edge: 'ne', cls: 'top-0 right-0 w-2 h-2',       cursor: 'nesw-resize' },
  { edge: 'nw', cls: 'top-0 left-0 w-2 h-2',        cursor: 'nwse-resize' },
  { edge: 'se', cls: 'bottom-0 right-0 w-2 h-2',    cursor: 'nwse-resize' },
  { edge: 'sw', cls: 'bottom-0 left-0 w-2 h-2',     cursor: 'nesw-resize' },
];

export function CascadeChrome({ tab, areaRef, areaW, areaH, setDragging, maximized }: Props) {
  const minimize  = useTabs((s) => s.minimize);
  const toggleMax = useTabs((s) => s.toggleMaximize);
  const close     = useTabs((s) => s.close);

  const drag = useMdiDrag({
    tabId: tab.tabId, areaRef,
    onDragStart: () => setDragging(true),
    onDragEnd:   () => setDragging(false),
  });

  return (
    <>
      {/* Title bar — drag handle for the frame; double-click toggles maximize. */}
      <div
        className="absolute left-0 right-0 top-0 h-6 flex items-center gap-2 px-2 select-none cursor-move border-b border-border bg-surface/95"
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
          title={maximized ? 'Restore' : 'Maximize'}
          aria-label={maximized ? 'Restore' : 'Maximize'}
          className="icon-btn w-5 h-5"
        >
          {maximized ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
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
      {/* Resize handles only when the frame can actually resize. */}
      {!maximized && HANDLES.map((h) => (
        <ResizeHandle
          key={h.edge}
          tabId={tab.tabId}
          areaRef={areaRef}
          edge={h.edge}
          cls={h.cls}
          cursor={h.cursor}
          setDragging={setDragging}
        />
      ))}
    </>
  );
}

interface HandleProps {
  tabId: string;
  areaRef: RefObject<HTMLDivElement | null>;
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
