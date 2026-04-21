'use client';
import type { LucideIcon } from 'lucide-react';

interface Props {
  icon:  LucideIcon;
  title: string;
  body?: string;
  action?: { label: string; onClick: () => void };
  compact?: boolean;
}

export function EmptyState({ icon: Icon, title, body, action, compact }: Props) {
  const pad = compact ? 'py-6' : 'py-10';
  return (
    <div className={`h-full flex flex-col items-center justify-center text-center px-4 ${pad}`}>
      <Icon size={compact ? 24 : 32} className="text-muted mb-2" strokeWidth={1.5} />
      <div className="text-fg text-sm font-medium">{title}</div>
      {body && <div className="text-muted text-xs mt-1 max-w-[260px]">{body}</div>}
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="btn-primary mt-3 focus-ring"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
