'use client';
import { ContextMenu, type MenuItem } from './context-menu';

export interface TerminalMenuProps {
  x: number; y: number;
  hasSelection: boolean;
  onCopy:       () => void;
  onPaste:      () => void;
  onSelectAll:  () => void;
  onClear:      () => void;
  onFind:       () => void;
  onClose:      () => void;
}

export function TerminalContextMenu(p: TerminalMenuProps) {
  const items: MenuItem[] = [
    { label: 'Copy',             shortcut: 'Ctrl+Shift+C', disabled: !p.hasSelection, onClick: p.onCopy },
    { label: 'Paste',            shortcut: 'Shift+Insert', onClick: p.onPaste },
    { label: 'Select All',       onClick: p.onSelectAll },
    { label: 'Find…',            shortcut: 'Ctrl+Shift+F', onClick: p.onFind },
    { label: 'Clear scrollback', onClick: p.onClear },
  ];
  return <ContextMenu x={p.x} y={p.y} items={items} onClose={p.onClose} />;
}
