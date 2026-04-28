'use client';
import dynamic from 'next/dynamic';
import type { CSSProperties, RefObject } from 'react';
import { useTabs, type Tab, type ViewMode, type CascadeGeometry } from '@/lib/tabs-store';
import { CascadeChrome } from './cascade-chrome';
import { SftpPane } from './sftp-pane';

const TerminalView = dynamic(
  () => import('./terminal').then((m) => m.TerminalView),
  { ssr: false },
);

interface Props {
  tab: Tab;
  viewMode: ViewMode;
  isActive: boolean;
  isMinimized: boolean;
  cascadeAreaRef: RefObject<HTMLDivElement | null>;
  cascadeAreaW: number;
  cascadeAreaH: number;
  cascadeGeom?: CascadeGeometry;
  dragging: boolean;
  setDragging: (v: boolean) => void;
}

// One enum, one place to compute "what kind of slot is this in this render?"
// All other styling decisions are derived from this.
type SlotKind = 'hidden' | 'tabs-active' | 'tile-flex' | 'tile-grid' | 'cascade';

function classifySlot(viewMode: ViewMode, isActive: boolean, isMinimized: boolean): SlotKind {
  if (isMinimized) return 'hidden';
  if (viewMode === 'tabs') return isActive ? 'tabs-active' : 'hidden';
  if (viewMode === 'tile-h' || viewMode === 'tile-v') return 'tile-flex';
  if (viewMode === 'tile-grid' || viewMode === 'auto') return 'tile-grid';
  return 'cascade';
}

export function TabSlot({
  tab, viewMode, isActive, isMinimized,
  cascadeAreaRef, cascadeAreaW, cascadeAreaH, cascadeGeom,
  dragging, setDragging,
}: Props) {
  const setActive    = useTabs((s) => s.setActive);
  const bringToFront = useTabs((s) => s.bringToFront);
  const kind = classifySlot(viewMode, isActive, isMinimized);

  // Same outer element type (a <div>) for every kind so React reconciliation
  // never unmounts the terminal-host child below.
  let slotClass: string;
  let slotStyle: CSSProperties;
  switch (kind) {
    case 'hidden':
      slotClass = 'absolute inset-0';
      slotStyle = { visibility: 'hidden', pointerEvents: 'none' };
      break;
    case 'tabs-active':
      slotClass = 'absolute inset-0 flex';
      slotStyle = {};
      break;
    case 'tile-flex':
      slotClass = 'flex-1 min-w-0 min-h-0 bg-bg relative';
      slotStyle = {};
      break;
    case 'tile-grid':
      slotClass = 'min-w-0 min-h-0 bg-bg relative';
      slotStyle = {};
      break;
    case 'cascade': {
      // Display-only clamp so previously-stored geometry doesn't leak
      // off-screen after a window resize. We don't write back; user
      // dragging will normalise.
      const g = cascadeGeom;
      if (!g || cascadeAreaW === 0 || cascadeAreaH === 0) {
        // Defensive: cascade with no geometry yet — open() initialises
        // geometry at tab creation, so this should be unreachable.
        slotClass = 'absolute inset-0';
        slotStyle = { visibility: 'hidden', pointerEvents: 'none' };
        break;
      }
      const w = Math.min(g.w, Math.max(200, cascadeAreaW));
      const h = Math.min(g.h, Math.max(120, cascadeAreaH));
      const x = Math.max(0, Math.min(cascadeAreaW - w, g.x));
      const y = Math.max(0, Math.min(cascadeAreaH - h, g.y));
      slotClass = `absolute bg-bg border rounded-md shadow-lg overflow-hidden ${
        isActive ? 'border-accent' : 'border-border'
      }`;
      slotStyle = { left: x, top: y, width: w, height: h, zIndex: g.z };
      break;
    }
  }

  function focusSlot() {
    if (!isActive) setActive(tab.tabId);
    if (kind === 'cascade') bringToFront(tab.tabId);
  }

  // Chrome and SFTP rendering rules:
  //   - Cascade chrome only for visible cascade slots.
  //   - SftpPane mounted whenever tab.sftpOpen, but hidden via display:none
  //     in non-tabs modes. Mount/unmount only on the explicit user toggle,
  //     never on a mode switch — preserves the pane's local state across
  //     mode flips.
  const showCascadeChrome = kind === 'cascade';
  const sftpVisible = kind === 'tabs-active' && tab.sftpOpen && tab.session.session_kind === 'ssh';
  const sftpMounted = tab.sftpOpen && tab.session.session_kind === 'ssh';

  // Terminal-host positioning differs in cascade (room for title bar) vs
  // every other mode (fill the slot).
  const hostStyle: CSSProperties = kind === 'cascade'
    ? { position: 'absolute', left: 0, right: 0, top: 24, bottom: 0 }
    : { position: 'absolute', inset: 0 };

  // pointer-events suppression on the terminal-host while a cascade drag is
  // in flight. Only matters in cascade mode; in other modes `dragging` is
  // always false so this is a no-op.
  const hostPointerEvents = dragging && kind === 'cascade' ? 'none' : 'auto';

  return (
    <div
      className={slotClass}
      style={slotStyle}
      onMouseDown={kind === 'cascade' || kind === 'tile-flex' || kind === 'tile-grid' ? focusSlot : undefined}
      role="group"
      aria-label={kind === 'cascade' ? `${tab.session.name} window` : undefined}
      aria-hidden={kind === 'hidden' || undefined}
    >
      {showCascadeChrome && (
        <CascadeChrome
          key="chrome"
          tab={tab}
          areaRef={cascadeAreaRef}
          areaW={cascadeAreaW}
          areaH={cascadeAreaH}
          setDragging={setDragging}
          maximized={!!cascadeGeom?.maximized}
        />
      )}
      {sftpMounted && (
        <div
          key="sftp"
          // display:none keeps SftpPane mounted (preserves local state)
          // while hiding it visually in non-tabs modes. The user can flip
          // back to tabs and find the pane in the same state they left it.
          style={{ display: sftpVisible ? 'flex' : 'none' }}
        >
          <SftpPane tab={tab} />
        </div>
      )}
      <div
        key="terminal-host"
        className="bg-bg"
        style={{ ...hostStyle, pointerEvents: hostPointerEvents }}
      >
        <TerminalView tab={tab} visible={kind !== 'hidden'} />
      </div>
    </div>
  );
}
