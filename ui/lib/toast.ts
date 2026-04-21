import { create } from 'zustand';

export type ToastKind = 'success' | 'warning' | 'danger' | 'info';

export interface Toast {
  id: string;
  kind: ToastKind;
  title: string;
  body?: string;
  /** Milliseconds before auto-dismiss. 0 = persistent until user closes. */
  ttl: number;
  createdAt: number;
}

interface ToastState {
  toasts: Toast[];
  push:   (t: Omit<Toast, 'id' | 'createdAt'>) => string;
  close:  (id: string) => void;
  clear:  () => void;
}

function uid() { return Math.random().toString(36).slice(2, 10); }

const DEFAULT_TTL = 4000;

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (t) => {
    const id = uid();
    const toast: Toast = {
      id,
      createdAt: Date.now(),
      kind: t.kind,
      title: t.title,
      body: t.body,
      ttl: t.ttl ?? DEFAULT_TTL,
    };
    set((s) => ({ toasts: [...s.toasts, toast] }));
    if (toast.ttl > 0) {
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));
      }, toast.ttl);
    }
    return id;
  },
  close: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] }),
}));

// Convenience helpers matching the kind names so call sites stay compact.
export const toast = {
  success: (title: string, body?: string) =>
    useToasts.getState().push({ kind: 'success', title, body, ttl: DEFAULT_TTL }),
  warning: (title: string, body?: string) =>
    useToasts.getState().push({ kind: 'warning', title, body, ttl: 6000 }),
  danger:  (title: string, body?: string) =>
    useToasts.getState().push({ kind: 'danger', title, body, ttl: 8000 }),
  info:    (title: string, body?: string) =>
    useToasts.getState().push({ kind: 'info', title, body, ttl: DEFAULT_TTL }),
};
