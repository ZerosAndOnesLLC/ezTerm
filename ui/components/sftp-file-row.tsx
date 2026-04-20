'use client';
import type { SftpEntry } from '@/lib/types';

interface Props {
  entry: SftpEntry;
  onOpen:    (e: SftpEntry) => void;
  onContext: (e: SftpEntry, cx: number, cy: number) => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/// Decode rwxrwxrwx from the lower nine mode bits. We don't show setuid/
/// setgid/sticky — those land in v0.4 with a proper chmod dialog.
function formatMode(mode: number): string {
  const bits = ['r', 'w', 'x'];
  let out = '';
  for (let shift = 6; shift >= 0; shift -= 3) {
    for (let b = 0; b < 3; b++) {
      out += (mode >> (shift + 2 - b)) & 1 ? bits[b] : '-';
    }
  }
  return out;
}

export function SftpFileRow({ entry, onOpen, onContext }: Props) {
  return (
    <div
      role="row"
      onDoubleClick={() => onOpen(entry)}
      onContextMenu={(e) => { e.preventDefault(); onContext(entry, e.clientX, e.clientY); }}
      className="grid grid-cols-[1fr_70px_72px] gap-2 px-2 py-1 text-xs hover:bg-surface2 cursor-default select-none"
    >
      <span className="truncate flex items-center gap-2">
        <span aria-hidden>{entry.is_dir ? '▸' : entry.is_symlink ? '↪' : '·'}</span>
        <span className="truncate">{entry.name}</span>
      </span>
      <span className="text-muted text-right tabular-nums">{entry.is_dir ? '' : formatSize(entry.size)}</span>
      <span className="text-muted font-mono">{formatMode(entry.mode)}</span>
    </div>
  );
}
