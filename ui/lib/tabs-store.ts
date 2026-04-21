import { create } from 'zustand';
import type { Session } from './types';

export type TabStatus = 'connecting' | 'connected' | 'closed' | 'error';

export interface Tab {
  tabId:        string;       // uuid-ish local id
  session:      Session;
  connectionId: number | null;
  status:       TabStatus;
  errorMessage: string | null;
  sftpOpen:     boolean;
  cwd:          string;       // remote working dir, default "/"
}

interface TabsState {
  tabs:       Tab[];
  activeId:   string | null;
  // Persistent UI chrome state. Starts collapsed so the terminal gets the
  // full window on launch; user expands via the rail button. Opening a
  // session also collapses it (mirrors MobaXterm's "focus the work" flow).
  sidebarCollapsed: boolean;
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
}

function uid() { return Math.random().toString(36).slice(2, 10); }

export const useTabs = create<TabsState>((set) => ({
  tabs: [],
  activeId: null,
  sidebarCollapsed: false,
  open: (session) => {
    const tabId = uid();
    set((s) => ({
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
      // Auto-collapse the sidebar on every connect. Once at least one tab
      // exists the user's attention belongs on the terminal; they can
      // re-expand from the rail button to launch another session.
      sidebarCollapsed: true,
    }));
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
      return { tabs, activeId };
    }),
  clear: () => set({ tabs: [], activeId: null }),
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
}));
