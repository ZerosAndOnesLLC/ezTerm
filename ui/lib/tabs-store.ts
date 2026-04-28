import { create } from 'zustand';
import type { Session } from './types';

export type TabStatus = 'connecting' | 'connected' | 'closed' | 'error';

export type ViewMode =
  | 'tabs' | 'tile-h' | 'tile-v' | 'tile-grid' | 'cascade' | 'auto';

export interface CascadeGeometry {
  x: number; y: number; w: number; h: number;
  z: number;                    // higher = on top
  maximized: boolean;
  prevGeom?: { x: number; y: number; w: number; h: number };
}

export interface Tab {
  tabId:        string;
  session:      Session;
  connectionId: number | null;
  status:       TabStatus;
  errorMessage: string | null;
  sftpOpen:     boolean;
  cwd:          string;
}

const VIEW_MODE_KEY  = 'ezterm.viewMode';
const TILE_GRID_KEY  = 'ezterm.tileGrid';
const MINIMIZED_KEY  = 'ezterm.minimizedTabs';

const VIEW_MODES: readonly ViewMode[] = [
  'tabs', 'tile-h', 'tile-v', 'tile-grid', 'cascade', 'auto',
];

function readViewMode(): ViewMode {
  if (typeof window === 'undefined') return 'tabs';
  try {
    const v = localStorage.getItem(VIEW_MODE_KEY);
    return (VIEW_MODES as readonly string[]).includes(v ?? '') ? (v as ViewMode) : 'tabs';
  } catch { return 'tabs'; }
}

function readTileGrid(): { rows: number; cols: number } {
  if (typeof window === 'undefined') return { rows: 2, cols: 2 };
  try {
    const raw = localStorage.getItem(TILE_GRID_KEY);
    if (!raw) return { rows: 2, cols: 2 };
    const v = JSON.parse(raw) as { rows?: unknown; cols?: unknown };
    const r = Math.max(1, Math.min(8, Number(v.rows) || 2));
    const c = Math.max(1, Math.min(8, Number(v.cols) || 2));
    return { rows: r, cols: c };
  } catch { return { rows: 2, cols: 2 }; }
}

function readMinimized(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(MINIMIZED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []);
  } catch { return new Set(); }
}

interface TabsState {
  tabs:       Tab[];
  activeId:   string | null;
  sidebarCollapsed: boolean;

  viewMode:   ViewMode;
  tileGrid:   { rows: number; cols: number };
  cascade:    Record<string, CascadeGeometry>;
  minimized:  Set<string>;
  nextZ:      number;

  open:       (session: Session) => string;
  setStatus:  (tabId: string, status: TabStatus, errorMessage?: string | null) => void;
  setConnection: (tabId: string, connectionId: number) => void;
  setActive:  (tabId: string | null) => void;
  close:      (tabId: string) => void;
  clear:      () => void;
  setSftpOpen: (tabId: string, open: boolean) => void;
  setCwd:      (tabId: string, cwd: string) => void;
  setSession:  (tabId: string, session: Session) => void;
  setSidebarCollapsed: (v: boolean) => void;
  toggleSidebar:       () => void;

  setViewMode:    (m: ViewMode) => void;
  cycleViewMode:  () => void;
  setTileGrid:    (rows: number, cols: number) => void;
  setCascadeGeom: (tabId: string, g: Partial<CascadeGeometry>) => void;
  bringToFront:   (tabId: string) => void;
  minimize:       (tabId: string) => void;
  restore:        (tabId: string) => void;
  toggleMaximize: (tabId: string, areaW: number, areaH: number) => void;
}

function uid() {
  // Tab IDs are persisted in `ezterm.minimizedTabs` and used as object keys
  // throughout the cascade map. Use crypto.randomUUID for unique IDs that
  // don't collide and aren't predictable from the renderer.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2, 10);
}

const STAIRCASE_STEP = 30;
const DEFAULT_FRAME_W = 640;
const DEFAULT_FRAME_H = 400;

function staircaseInit(count: number, nextZ: number): CascadeGeometry {
  const offset = (count % 10) * STAIRCASE_STEP;
  return {
    x: offset, y: offset,
    w: DEFAULT_FRAME_W, h: DEFAULT_FRAME_H,
    z: nextZ,
    maximized: false,
  };
}

export const useTabs = create<TabsState>((set, get) => ({
  tabs: [],
  activeId: null,
  sidebarCollapsed: false,

  viewMode:  readViewMode(),
  tileGrid:  readTileGrid(),
  cascade:   {},
  minimized: readMinimized(),
  nextZ:     1,

  open: (session) => {
    const tabId = uid();
    set((s) => {
      const newZ = s.nextZ + 1;
      const cascade = {
        ...s.cascade,
        [tabId]: staircaseInit(Object.keys(s.cascade).length, newZ),
      };
      return {
        tabs: [
          ...s.tabs,
          {
            tabId,
            session,
            connectionId: null,
            status: 'connecting',
            errorMessage: null,
            sftpOpen: false,
            cwd: '/',
          },
        ],
        activeId: tabId,
        sidebarCollapsed: true,
        cascade,
        nextZ: newZ,
      };
    });
    return tabId;
  },
  setStatus: (tabId, status, errorMessage = null) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.tabId === tabId ? { ...t, status, errorMessage } : t)),
    })),
  setConnection: (tabId, connectionId) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.tabId === tabId ? { ...t, connectionId } : t)),
    })),
  setActive: (activeId) => set({ activeId }),
  close: (tabId) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.tabId !== tabId);
      const activeId = s.activeId === tabId ? (tabs[tabs.length - 1]?.tabId ?? null) : s.activeId;
      const { [tabId]: _drop, ...cascade } = s.cascade;
      const minimized = new Set(s.minimized);
      minimized.delete(tabId);
      return { tabs, activeId, cascade, minimized };
    }),
  clear: () => set({ tabs: [], activeId: null, cascade: {}, minimized: new Set() }),
  setSftpOpen: (tabId, open) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.tabId === tabId ? { ...t, sftpOpen: open } : t)),
    })),
  setCwd: (tabId, cwd) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.tabId === tabId ? { ...t, cwd } : t)),
    })),
  setSession: (tabId, session) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.tabId === tabId ? { ...t, session } : t)),
    })),
  setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
  toggleSidebar:       () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  setViewMode: (m) => set({ viewMode: m }),
  cycleViewMode: () => {
    const cur = get().viewMode;
    const idx = VIEW_MODES.indexOf(cur);
    const next = VIEW_MODES[(idx + 1) % VIEW_MODES.length];
    set({ viewMode: next });
  },
  setTileGrid: (rows, cols) => set({
    tileGrid: {
      rows: Math.max(1, Math.min(8, rows | 0)),
      cols: Math.max(1, Math.min(8, cols | 0)),
    },
  }),
  setCascadeGeom: (tabId, g) =>
    set((s) => {
      const cur = s.cascade[tabId];
      if (!cur) return {};
      return { cascade: { ...s.cascade, [tabId]: { ...cur, ...g } } };
    }),
  bringToFront: (tabId) =>
    set((s) => {
      const cur = s.cascade[tabId];
      if (!cur) return {};
      const nextZ = s.nextZ + 1;
      return {
        nextZ,
        cascade: { ...s.cascade, [tabId]: { ...cur, z: nextZ } },
      };
    }),
  minimize: (tabId) =>
    set((s) => {
      const minimized = new Set(s.minimized);
      minimized.add(tabId);
      return { minimized };
    }),
  restore: (tabId) =>
    set((s) => {
      const minimized = new Set(s.minimized);
      minimized.delete(tabId);
      const cur = s.cascade[tabId];
      if (!cur) return { minimized };
      const nextZ = s.nextZ + 1;
      return {
        minimized,
        nextZ,
        cascade: { ...s.cascade, [tabId]: { ...cur, z: nextZ } },
      };
    }),
  toggleMaximize: (tabId, areaW, areaH) =>
    set((s) => {
      const cur = s.cascade[tabId];
      if (!cur) return {};
      if (cur.maximized && cur.prevGeom) {
        const { prevGeom, ...rest } = cur;
        return {
          cascade: {
            ...s.cascade,
            [tabId]: { ...rest, ...prevGeom, maximized: false },
          },
        };
      }
      return {
        cascade: {
          ...s.cascade,
          [tabId]: {
            ...cur,
            prevGeom: { x: cur.x, y: cur.y, w: cur.w, h: cur.h },
            x: 0, y: 0, w: areaW, h: areaH,
            maximized: true,
          },
        },
      };
    }),
}));

if (typeof window !== 'undefined') {
  useTabs.subscribe((s, prev) => {
    try {
      if (s.viewMode !== prev.viewMode) {
        localStorage.setItem(VIEW_MODE_KEY, s.viewMode);
      }
      if (s.tileGrid !== prev.tileGrid) {
        localStorage.setItem(TILE_GRID_KEY, JSON.stringify(s.tileGrid));
      }
      if (s.minimized !== prev.minimized) {
        localStorage.setItem(MINIMIZED_KEY, JSON.stringify(Array.from(s.minimized)));
      }
    } catch { /* localStorage may be disabled — silently skip */ }
  });
}
