'use client';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useToasts, type ToastKind } from '@/lib/toast';

const KIND: Record<ToastKind, { Icon: LucideIcon; bar: string; fg: string }> = {
  success: { Icon: CheckCircle2,  bar: 'bg-success', fg: 'text-success' },
  warning: { Icon: AlertTriangle, bar: 'bg-warning', fg: 'text-warning' },
  danger:  { Icon: AlertCircle,   bar: 'bg-danger',  fg: 'text-danger' },
  info:    { Icon: Info,          bar: 'bg-accent',  fg: 'text-accent' },
};

export function ToastRegion() {
  const toasts = useToasts((s) => s.toasts);
  const close  = useToasts((s) => s.close);

  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="fixed bottom-8 right-3 z-50 flex flex-col gap-2 w-[320px] max-w-[calc(100vw-24px)] pointer-events-none"
    >
      {toasts.map((t) => {
        const { Icon, bar, fg } = KIND[t.kind];
        return (
          <div
            key={t.id}
            role="status"
            className="pointer-events-auto bg-surface border border-border rounded shadow-menu flex items-stretch text-xs overflow-hidden dialog-in"
          >
            <div className={`w-0.5 ${bar}`} aria-hidden />
            <div className="flex-1 p-2.5 flex gap-2 min-w-0">
              <Icon size={14} className={`${fg} shrink-0 mt-0.5`} />
              <div className="flex-1 min-w-0">
                <div className="text-fg font-medium truncate">{t.title}</div>
                {t.body && <div className="text-muted mt-0.5 break-words">{t.body}</div>}
              </div>
              <button
                type="button"
                onClick={() => close(t.id)}
                aria-label="Dismiss"
                className="icon-btn w-5 h-5 shrink-0"
              >
                <X size={12} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
