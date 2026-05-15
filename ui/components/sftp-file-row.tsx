'use client';
import { useState } from 'react';
import { File, FileSymlink, Folder } from 'lucide-react';
import type { SftpEntry } from '@/lib/types';

interface Props {
  entry: SftpEntry;
  onOpen:    (e: SftpEntry) => void;
  onContext: (e: SftpEntry, cx: number, cy: number) => void;
  /** Drop handler when this row is a folder. The caller routes the OS
   *  drop into a per-folder upload. Called with the row's full path.
   *  Undefined for non-folder rows. */
  onFolderDrop?: (entry: SftpEntry, ev: React.DragEvent) => void;
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

export function SftpFileRow({ entry, onOpen, onContext, onFolderDrop }: Props) {
  const [dragOver, setDragOver] = useState(false);

  let Icon = File;
  let iconCls = 'text-muted';
  if (entry.is_dir) { Icon = Folder; iconCls = 'text-accent'; }
  else if (entry.is_symlink) { Icon = FileSymlink; iconCls = 'text-warning'; }

  // Per-folder drop wiring. We stop propagation so the pane-wide
  // handler in SftpPane doesn't ALSO see the drop and double-upload.
  // Files-only rows ignore drag events entirely so the OS keeps
  // showing the "no-drop" cursor over them.
  const folderDnD = entry.is_dir && onFolderDrop ? {
    onDragOver: (ev: React.DragEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (!dragOver) setDragOver(true);
    },
    onDragLeave: () => setDragOver(false),
    onDrop: (ev: React.DragEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      setDragOver(false);
      onFolderDrop(entry, ev);
    },
  } : {};

  return (
    <div
      role="row"
      onDoubleClick={() => onOpen(entry)}
      onContextMenu={(e) => { e.preventDefault(); onContext(entry, e.clientX, e.clientY); }}
      {...folderDnD}
      className={`grid grid-cols-[1fr_70px_72px] gap-2 px-2 h-6 items-center text-xs cursor-default select-none ${
        dragOver ? 'bg-accent/20 ring-1 ring-accent ring-inset' : 'hover:bg-surface2/60'
      }`}
    >
      <span className="truncate flex items-center gap-1.5 min-w-0">
        <Icon size={13} className={`${iconCls} shrink-0`} />
        <span className="truncate">{entry.name}</span>
      </span>
      <span className="text-muted text-right tabular-nums">
        {entry.is_dir ? '' : formatSize(entry.size)}
      </span>
      <span className="text-muted font-mono">{formatMode(entry.mode)}</span>
    </div>
  );
}
