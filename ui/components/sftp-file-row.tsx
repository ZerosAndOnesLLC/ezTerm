'use client';
import { useState } from 'react';
import { File, FileSymlink, Folder } from 'lucide-react';
import type { SftpEntry } from '@/lib/types';

interface Props {
  entry: SftpEntry;
  selected?: boolean;
  onOpen:    (e: SftpEntry) => void;
  onContext: (e: SftpEntry, cx: number, cy: number) => void;
  /** Drop handler when this row is a folder. The caller routes the OS
   *  drop into a per-folder upload. Called with the row's full path.
   *  Undefined for non-folder rows. */
  onFolderDrop?: (entry: SftpEntry, ev: React.DragEvent) => void;
  /** Drag-out trigger for non-folder rows. Called once we detect the
   *  user has moved past a small threshold while holding the mouse
   *  button — that's the signal to start an OS-native OLE drag.
   *  Undefined for folder rows; HTML5 drag is deliberately NOT
   *  enabled on the row (we'd race the native drag init). */
  onDragOutStart?: (entry: SftpEntry) => void;
  /** Selection click. Fires on mousedown so the act of selecting can
   *  also be the start of a drag. The pane handles modifier keys
   *  (Ctrl, Shift) to compute the new selection set. */
  onSelectMouseDown?: (entry: SftpEntry, ev: React.MouseEvent) => void;
}

/** Distance in pixels the cursor must move with the mouse held before
 *  we commit to initiating a drag. Matches the OS hysteresis used by
 *  Explorer / native file managers; 5 px is the de-facto standard. */
const DRAG_THRESHOLD_PX = 5;

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

export function SftpFileRow({
  entry, selected, onOpen, onContext, onFolderDrop, onDragOutStart, onSelectMouseDown,
}: Props) {
  const [dragOver, setDragOver] = useState(false);

  // mousedown does two things: notifies the pane about selection
  // (immediately, so a subsequent drag carries the new selection) and
  // arms a hysteresis-threshold mousemove listener to detect drag-out.
  // The drag arming only fires for non-folder rows (folders can be
  // navigated by double-click and accept drops; dragging them out
  // would need recursive remote listing, which is a separate phase).
  function handleMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    onSelectMouseDown?.(entry, e);
    if (entry.is_dir || entry.is_symlink) return;
    if (!onDragOutStart) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let armed = true;
    const onMove = (ev: MouseEvent) => {
      if (!armed) return;
      const dx = ev.clientX - x0;
      const dy = ev.clientY - y0;
      if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
      armed = false;
      cleanup();
      onDragOutStart(entry);
    };
    const cleanup = () => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
    };
    const onUp = () => { armed = false; cleanup(); };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
  }

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
      onMouseDown={handleMouseDown}
      {...folderDnD}
      className={`grid grid-cols-[1fr_70px_72px] gap-2 px-2 h-6 items-center text-xs cursor-default select-none ${
        dragOver
          ? 'bg-accent/20 ring-1 ring-accent ring-inset'
          : selected
            ? 'bg-accent/15'
            : 'hover:bg-surface2/60'
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
