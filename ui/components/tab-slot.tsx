'use client';
import dynamic from 'next/dynamic';
import type { CSSProperties, RefObject } from 'react';
import { useTabs, type Tab, type ViewMode } from '@/lib/tabs-store';
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
  dragging: boolean;
  setDragging: (v: boolean) => void;
}

// One enum, one place to compute "what kind of slot is this in this render?"
// All other styling decisions are derived from this.
type SlotKind = 'hidden' | 'tabs' | 'tile-flex' | 'tile-grid' | 'cascade';

function classifySlot(viewMode: ViewMode, isActive: boolean, isMinimized: boolean): SlotKind {
  if (isMinimized) return 'hidden';
  if (viewMode === 'tabs') return isActive ? 'tabs' : 'hidden';
  if (viewMode === 'tile-h' || viewMode === 'tile-v') return 'tile-flex';
  if (viewMode === 'tile-grid' || viewMode === 'auto') return 'tile-grid';
  return 'cascade';
}

export function TabSlot({
  tab, viewMode, isActive, isMinimized,
  cascadeAreaRef, cascadeAreaW, cascadeAreaH,
  dragging, setDragging,
}: Props) {
  const setActive    = useTabs((s) => s.setActive);
  const bringToFront = useTabs((s) => s.bringToFront);
  // Per-tab cascade selector. Subscribing to s.cascade as a whole would
  // re-render every TabSlot at 60Hz during a drag (the map reference
  // changes every rAF in setCascadeGeom). Reading just our own slice
  // means only the dragged frame's slot re-renders.
  const cascadeGeom  = useTabs((s) => s.cascade[tab.tabId]);
  const kind = classifySlot(viewMode, isActive, isMinimized);

  // Same outer element type (a <div>) for every kind so React reconciliation
  // never unmounts the terminal-host child below.
  let slotClass: string;
  let slotStyle: CSSProperties;
  let canFocusOnMouseDown = false;
  switch (kind) {
    case 'hidden':
      slotClass = 'absolute inset-0';
      slotStyle = { visibility: 'hidden', pointerEvents: 'none' };
      break;
    case 'tabs':
      slotClass = 'absolute inset-0 flex';
      slotStyle = {};
      break;
    case 'tile-flex':
      // ring-inset on the active cell costs zero pixels (the ring lives
      // inside the box, doesn't push siblings) and gives the focused
      // terminal an obvious accent border in dark mode where the
      // bg-borderStrong divider alone is enough for spatial separation
      // but doesn't flag which cell has focus.
      slotClass = `flex-1 min-w-0 min-h-0 bg-bg relative ${
        isActive ? 'ring-1 ring-inset ring-accent' : ''
      }`;
      slotStyle = {};
      canFocusOnMouseDown = true;
      break;
    case 'tile-grid':
      slotClass = `min-w-0 min-h-0 bg-bg relative ${
        isActive ? 'ring-1 ring-inset ring-accent' : ''
      }`;
      slotStyle = {};
      canFocusOnMouseDown = true;
      break;
    case 'cascade': {
      // Display-only clamp so previously-stored geometry doesn't leak
      // off-screen after a window resize. We don't write back; user
      // dragging will normalise.
      const g = cascadeGeom;
      if (!g || cascadeAreaW === 0 || cascadeAreaH === 0) {
        // Defensive: cascade with no geometry yet — open() initialises
        // geometry at tab creation, so this should be unreachable.
        // Leave canFocusOnMouseDown = false so a stray click on the
        // invisible slot can't bring it to front.
        slotClass = 'absolute inset-0';
        slotStyle = { visibility: 'hidden', pointerEvents: 'none' };
        break;
      }
      const w = Math.min(g.w, Math.max(200, cascadeAreaW));
      const h = Math.min(g.h, Math.max(120, cascadeAreaH));
      const x = Math.max(0, Math.min(cascadeAreaW - w, g.x));
      const y = Math.max(0, Math.min(cascadeAreaH - h, g.y));
      // Inactive cascade frames now use borderStrong so they stay
      // visible against the cascade-area background in dark mode (the
      // default --border was tuned for chrome and washed out here).
      // Active frame keeps the accent border for "I have focus" signal.
      slotClass = `absolute bg-bg border rounded-md shadow-lg overflow-hidden ${
        isActive ? 'border-accent' : 'border-borderStrong'
      }`;
      slotStyle = { left: x, top: y, width: w, height: h, zIndex: g.z };
      canFocusOnMouseDown = true;
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
  const sftpVisible = kind === 'tabs' && tab.sftpOpen && tab.session.session_kind === 'ssh';
  const sftpMounted = tab.sftpOpen && tab.session.session_kind === 'ssh';

  // Terminal-host positioning:
  //   - tabs mode: real flex item next to the SftpPane (flex:1 fills the
  //     remaining width; min-w-0 / min-h-0 lets xterm shrink below intrinsic
  //     size). Crucially NOT absolute here — that would overlay SftpPane.
  //   - tile-flex / tile-grid: absolute inset-0 inside the slot, which is
  //     itself a flex/grid item driving its own size.
  //   - cascade: absolute with top:24 to leave room for the title bar.
  let hostStyle: CSSProperties;
  switch (kind) {
    case 'tabs':
      hostStyle = { flex: '1 1 0%', minWidth: 0, minHeight: 0, position: 'relative' };
      break;
    case 'cascade':
      hostStyle = { position: 'absolute', left: 0, right: 0, top: 24, bottom: 0 };
      break;
    default:
      hostStyle = { position: 'absolute', inset: 0 };
      break;
  }

  // pointer-events suppression on the terminal-host while a cascade drag is
  // in flight. Only matters in cascade mode; in other modes `dragging` is
  // always false so this is a no-op.
  const hostPointerEvents = dragging && kind === 'cascade' ? 'none' : 'auto';

  // Note: tab.session.name / .username / .host are user-controlled (typed
  // at session creation). Safe to interpolate into aria-label / title here
  // — React renders these as DOM text/attribute nodes without HTML parsing.
  // Any future refactor that pipes session.* into href / src /
  // dangerouslySetInnerHTML must add explicit escaping.
  return (
    <div
      className={slotClass}
      style={slotStyle}
      onMouseDown={canFocusOnMouseDown ? focusSlot : undefined}
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
          // while hiding it visually in non-tabs modes.
          style={{ display: sftpVisible ? 'flex' : 'none' }}
        >
          <SftpPane tab={tab} isVisible={sftpVisible} />
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
