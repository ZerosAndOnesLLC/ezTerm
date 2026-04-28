'use client';
import { AlertCircle } from 'lucide-react';
import type { TabStatus } from '@/lib/tabs-store';

interface Props { status: TabStatus; size?: number; }

export function StatusDot({ status, size = 11 }: Props) {
  if (status === 'error') {
    return <AlertCircle size={size} className="text-danger shrink-0" aria-label="error" />;
  }
  let cls = 'bg-muted';
  if (status === 'connected') cls = 'bg-success';
  else if (status === 'connecting') cls = 'bg-warning animate-pulse';
  else if (status === 'closed') cls = 'bg-muted/60';
  return <span className={`w-1.5 h-1.5 rounded-full ${cls} shrink-0`} aria-label={status} />;
}
