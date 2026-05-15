'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FileInput,
  Folder,
  FolderOpen,
  FolderPlus,
  MonitorDot,
  PanelLeftClose,
  Plus,
  Server,
  SquareTerminal,
  Terminal,
  Trash2,
} from 'lucide-react';

/** Default tile backgrounds per session kind when the user hasn't set a
 *  per-session colour. Routes through theme tokens so dark/light flips
 *  are automatic — never hard-code hexes here. */
const KIND_DEFAULT_TILE: Record<'ssh' | 'wsl' | 'local', string> = {
  ssh:   'rgb(var(--accent))',
  wsl:   'rgb(var(--warning))',
  local: 'rgb(var(--success))',
};

/** 2px horizontal accent line at the top or bottom of a row — shown
 *  while dragging to signal "drop lands here". `pointer-events-none`
 *  so it never steals the drop from the row itself. */
function DropLine({ edge }: { edge: 'top' | 'bottom' }) {
  const pos = edge === 'top' ? '-top-[1px]' : '-bottom-[1px]';
  return (
    <span
      aria-hidden
      className={`absolute left-0 right-0 ${pos} h-[2px] bg-accent rounded-sm pointer-events-none`}
    />
  );
}
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { api, errMessage } from '@/lib/tauri';
import type { Folder as TFolder, Session } from '@/lib/types';
import { useTabs } from '@/lib/tabs-store';
import { toast } from '@/lib/toast';
import { ContextMenu, type MenuItem } from './context-menu';
import { ConfirmDialog } from './confirm-dialog';
import { PromptDialog } from './prompt-dialog';
import { EmptyState } from './empty-state';
import { SessionDialog } from './session-dialog';
import { ImportMobaxtermDialog } from './import-mobaxterm-dialog';
import { BackupDialog } from './backup-dialog';
import { RestoreDialog } from './restore-dialog';
import { SyncDialog } from './sync-dialog';
import { MoveToFolderDialog } from './move-to-folder-dialog';

interface TreeNode {
  folder: TFolder | null; // null = root
  folders: TreeNode[];
  sessions: Session[];
}

function countDescendantSessions(node: TreeNode): number {
  let n = node.sessions.length;
  for (const c of node.folders) n += countDescendantSessions(c);
  return n;
}

function buildTree(folders: TFolder[], sessions: Session[]): TreeNode {
  const byParent = new Map<number | null, TFolder[]>();
  for (const f of folders) {
    const k = f.parent_id;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k)!.push(f);
  }
  const sessByFolder = new Map<number | null, Session[]>();
  for (const s of sessions) {
    if (!sessByFolder.has(s.folder_id)) sessByFolder.set(s.folder_id, []);
    sessByFolder.get(s.folder_id)!.push(s);
  }
  function build(parent: TFolder | null): TreeNode {
    const pid = parent ? parent.id : null;
    return {
      folder: parent,
      folders: (byParent.get(pid) ?? []).map((f) => build(f)),
      sessions: sessByFolder.get(pid) ?? [],
    };
  }
  return build(null);
}

type SessionDlgState =
  | { mode: 'create'; folderId: number | null }
  | { mode: 'edit'; session: Session };

type PendingPrompt =
  | { kind: 'new-folder'; parentId: number | null }
  | { kind: 'rename-folder'; folder: TFolder };

type PendingConfirm =
  | { kind: 'delete-folder'; folder: TFolder }
  | { kind: 'delete-session'; session: Session };

/** Where a drag-in-progress will land. The `edge`-carrying variants draw
 *  a horizontal line indicator at the named edge; the `into-*` variants
 *  highlight the whole row. */
type DropSlot =
  | { kind: 'into-root' }
  | { kind: 'into-folder'; folderId: number }
  | { kind: 'before-session'; sessionId: number }
  | { kind: 'after-session';  sessionId: number }
  | { kind: 'before-folder';  folderId: number }
  | { kind: 'after-folder';   folderId: number };

function slotsEqual(a: DropSlot | null, b: DropSlot | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'into-root':
      return true;
    case 'into-folder':
      return a.folderId === (b as { folderId: number }).folderId;
    case 'before-session':
    case 'after-session':
      return a.sessionId === (b as { sessionId: number }).sessionId;
    case 'before-folder':
    case 'after-folder':
      return a.folderId === (b as { folderId: number }).folderId;
  }
}

export function SessionsSidebar() {
  const [folders, setFolders] = useState<TFolder[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [dialog, setDialog] = useState<SessionDlgState | null>(null);
  const [prompt, setPrompt] = useState<PendingPrompt | null>(null);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [importPath, setImportPath] = useState<string | null>(null);
  const [backupOpen, setBackupOpen] = useState(false);
  const [restorePath, setRestorePath] = useState<string | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  const [moveSession, setMoveSession] = useState<Session | null>(null);
  const [moveFolder, setMoveFolder] = useState<TFolder | null>(null);
  // Drag-and-drop state: `drag` is the row being dragged (opacity-50 on the
  // source); `dragTarget` is the hovered drop slot — see `DropSlot` below.
  // null when nothing is being dragged-over. Slots describe *where* the
  // drop will land (into a folder / before or after a sibling) so the same
  // state drives both the visual indicator and the drop handler.
  const [drag, setDrag] = useState<{ kind: 'session' | 'folder'; id: number } | null>(null);
  const [dragTarget, setDragTarget] = useState<DropSlot | null>(null);

  const openTabAction   = useTabs((s) => s.open);
  const openTabs        = useTabs((s) => s.tabs);
  const toggleSidebar   = useTabs((s) => s.toggleSidebar);
  const connectedSessionIds = useMemo(
    () => new Set(openTabs.filter((t) => t.status === 'connected').map((t) => t.session.id)),
    [openTabs],
  );

  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (e) {
      toast.danger('Action failed', errMessage(e));
      return undefined;
    }
  }

  async function reload() {
    const [f, s] = await Promise.all([api.folderList(), api.sessionList()]);
    setFolders(f);
    setSessions(s);
  }

  useEffect(() => { reload(); }, []);

  // Auto-expand a folder that has children on first render so new users
  // immediately see what's inside. Tracked lazily: we only do it once per
  // folder id (we never auto-collapse what a user explicitly opened).
  useEffect(() => {
    if (folders.length === 0) return;
    setExpanded((cur) => {
      if (cur.size > 0) return cur;
      const next = new Set(cur);
      for (const f of folders) next.add(f.id);
      return next;
    });
  }, [folders]);

  const tree = useMemo(() => buildTree(folders, sessions), [folders, sessions]);

  function toggleFolder(id: number) {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function openFolderMenu(e: React.MouseEvent, f: TFolder | null) {
    e.preventDefault();
    const id = f?.id ?? null;
    const hasChildrenToSort =
      folders.filter((x) => x.parent_id === id).length
      + sessions.filter((s) => s.folder_id === id).length
      > 1;
    const items: MenuItem[] = [
      { label: 'New Session', onClick: () => setDialog({ mode: 'create', folderId: id }) },
      { label: 'New Folder', onClick: () => setPrompt({ kind: 'new-folder', parentId: id }) },
      { separator: true },
      { label: 'Sort A \u2192 Z', disabled: !hasChildrenToSort, onClick: () => sortChildren(id, 'asc') },
      { label: 'Sort Z \u2192 A', disabled: !hasChildrenToSort, onClick: () => sortChildren(id, 'desc') },
    ];
    if (f) {
      items.push(
        { separator: true },
        { label: 'Move to folder\u2026', onClick: () => setMoveFolder(f) },
        { label: 'Rename', onClick: () => setPrompt({ kind: 'rename-folder', folder: f }) },
        { label: 'Delete', danger: true, onClick: () => setConfirm({ kind: 'delete-folder', folder: f }) },
      );
    } else {
      items.push(
        { separator: true },
        { label: 'Import from MobaXterm\u2026', onClick: pickMobaXtermFile },
        { separator: true },
        { label: 'Backup\u2026',  onClick: () => setBackupOpen(true) },
        { label: 'Restore\u2026', onClick: pickRestoreFile },
        { separator: true },
        { label: 'Cloud sync\u2026', onClick: () => setSyncOpen(true) },
      );
    }
    setMenu({ x: e.clientX, y: e.clientY, items });
  }

  /** Sort a folder's *immediate* children alphabetically. Folders and
   *  sessions are sorted independently \u2014 folders stay rendered above
   *  sessions per the existing tree layout. `null` parent = root. */
  async function sortChildren(parentId: number | null, dir: 'asc' | 'desc') {
    const cmp = (a: string, b: string) => {
      const c = a.localeCompare(b, undefined, { sensitivity: 'base' });
      return dir === 'asc' ? c : -c;
    };
    const childFolders = folders
      .filter((x) => x.parent_id === parentId)
      .slice()
      .sort((a, b) => cmp(a.name, b.name));
    const childSessions = sessions
      .filter((s) => s.folder_id === parentId)
      .slice()
      .sort((a, b) => cmp(a.name, b.name));
    if (childFolders.length <= 1 && childSessions.length <= 1) return;

    await run(async () => {
      const ops: Promise<void>[] = [];
      if (childFolders.length > 1) {
        ops.push(api.folderReorder(parentId, childFolders.map((f) => f.id)));
      }
      if (childSessions.length > 1) {
        ops.push(api.sessionReorder(parentId, childSessions.map((s) => s.id)));
      }
      await Promise.all(ops);
    });
    reload();
    toast.success('Sorted', dir === 'asc' ? 'A \u2192 Z' : 'Z \u2192 A');
  }

  /** Folder ids that would create a cycle if used as `f`'s new parent \u2014
   *  i.e. `f` itself plus every descendant. Used by the move-folder
   *  picker to disable invalid destinations. */
  function descendantFolderIds(f: TFolder): Set<number> {
    const out = new Set<number>([f.id]);
    let frontier = [f.id];
    while (frontier.length > 0) {
      const next: number[] = [];
      for (const pid of frontier) {
        for (const child of folders) {
          if (child.parent_id === pid && !out.has(child.id)) {
            out.add(child.id);
            next.push(child.id);
          }
        }
      }
      frontier = next;
    }
    return out;
  }

  async function pickRestoreFile() {
    try {
      const picked = await openDialog({
        multiple: false,
        directory: false,
        title: 'Restore ezTerm backup',
        filters: [{ name: 'ezTerm backup', extensions: ['json'] }],
      });
      if (typeof picked === 'string' && picked) setRestorePath(picked);
    } catch (e) {
      toast.danger('Restore failed', errMessage(e));
    }
  }

  async function pickMobaXtermFile() {
    try {
      const picked = await openDialog({
        multiple: false,
        directory: false,
        title: 'Import MobaXterm sessions',
        filters: [
          { name: 'MobaXterm sessions', extensions: ['mxtsessions', 'ini'] },
          { name: 'All files', extensions: ['*'] },
        ],
      });
      if (typeof picked === 'string' && picked) {
        setImportPath(picked);
      }
    } catch (e) {
      toast.danger('Import failed', errMessage(e));
    }
  }

  // --- Drag & drop ------------------------------------------------------
  //
  // HTML5 DnD. The dragged row puts {kind,id} into dataTransfer so the drop
  // handler can route to api.sessionMove / folderMove. Sort is always 0 on
  // drop (new-top-of-folder); intra-folder reordering is a separate pass.
  //
  // React 19 batches setState more aggressively than 18, so the first few
  // `dragover` events fire before the `drag` state update from `dragstart`
  // has rendered — gating `preventDefault()` on the state value left the
  // browser marking the target as a non-drop zone, and `drop` never fired.
  // Mirror the drag source into a ref for synchronous access; state is
  // still used for the opacity / highlight visuals.
  const dragSourceRef = useRef<{ kind: 'session' | 'folder'; id: number } | null>(null);

  function handleDragStart(
    e: React.DragEvent,
    kind: 'session' | 'folder',
    id: number,
  ) {
    e.stopPropagation();
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/json', JSON.stringify({ kind, id }));
    dragSourceRef.current = { kind, id };
    setDrag({ kind, id });
  }

  function handleDragEnd() {
    dragSourceRef.current = null;
    setDrag(null);
    setDragTarget(null);
  }

  function setDragTargetIfChanged(next: DropSlot | null) {
    if (!slotsEqual(dragTarget, next)) setDragTarget(next);
  }

  /** Compute the slot for a row-aware drag.
   *
   *  Sessions split 50/50 above/below for sibling reorder.
   *
   *  Folder rows depend on the drag source:
   *  - **Folder source**: split 25 / 50 / 25 (above / into / below) so a
   *    user can both nest one folder inside another *and* reorder folders
   *    from the same row.
   *  - **Session source**: the entire row is `into-folder`. Reordering a
   *    folder by dropping a session next to it isn't a real use case, and
   *    the narrow ~14px middle band (25% of a 28px row) made dropping a
   *    session *into* a folder feel broken — see #72. */
  function slotForRow(
    e: React.DragEvent,
    row: 'session' | 'folder',
    id: number,
  ): DropSlot {
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const ratio = rect.height > 0 ? y / rect.height : 0.5;
    if (row === 'session') {
      return ratio < 0.5
        ? { kind: 'before-session', sessionId: id }
        : { kind: 'after-session', sessionId: id };
    }
    if (dragSourceRef.current?.kind === 'session') {
      return { kind: 'into-folder', folderId: id };
    }
    if (ratio < 0.25) return { kind: 'before-folder', folderId: id };
    if (ratio > 0.75) return { kind: 'after-folder', folderId: id };
    return { kind: 'into-folder', folderId: id };
  }

  function handleDragOver(e: React.DragEvent, slot: DropSlot) {
    const src = dragSourceRef.current;
    if (src) {
      // Can't drop a folder into itself (either as a parent or as its own
      // sibling-edge). before/after-folder on self is a no-op drop, but we
      // still reject to avoid a confusing indicator line.
      if (src.kind === 'folder' && slot.kind === 'into-folder' && slot.folderId === src.id) return;
      if (src.kind === 'folder' && (slot.kind === 'before-folder' || slot.kind === 'after-folder') && slot.folderId === src.id) return;
    }
    // Always preventDefault so the browser keeps treating us as a valid
    // drop target. The full-payload validity check happens at drop time.
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setDragTargetIfChanged(slot);
  }

  async function handleDrop(e: React.DragEvent, slot: DropSlot) {
    e.preventDefault();
    e.stopPropagation();
    const raw = e.dataTransfer.getData('application/json');
    dragSourceRef.current = null;
    setDrag(null);
    setDragTarget(null);
    if (!raw) return;
    let payload: { kind: 'session' | 'folder'; id: number };
    try { payload = JSON.parse(raw); } catch { return; }

    try {
      if (payload.kind === 'session') {
        await dropSession(payload.id, slot);
      } else {
        await dropFolder(payload.id, slot);
      }
      reload();
    } catch (err) {
      toast.danger('Move failed', errMessage(err));
    }
  }

  async function dropSession(sessionId: number, slot: DropSlot) {
    // Destination folder for the session after the drop. `into-*` moves
    // into the folder at position 0. `before-session` / `after-session`
    // adopt the target session's folder (so cross-folder drop + reorder
    // in one gesture works). Folder-edge drops aren't a valid destination
    // for a session; treat them as "move into that folder's parent and
    // reorder" — we position just above/below the folder in its parent.
    const cur = sessions.find((s) => s.id === sessionId);
    if (!cur) return;

    const destFolderId = resolveDestFolderId(slot);
    if (destFolderId === undefined) return;

    // Expand the destination folder so the user sees where their drop
    // landed, matching MobaXterm's feedback.
    if (destFolderId !== null) {
      setExpanded((prev) => new Set(prev).add(destFolderId));
    }

    // When the drop slot requests a specific position (before/after a
    // sibling), reorder via the full-list API. For plain "into-folder"
    // / "into-root" drops we keep the existing mv-to-sort-0 shortcut
    // to preserve current UX (new item at top of folder).
    if (slot.kind === 'into-folder' || slot.kind === 'into-root') {
      if (cur.folder_id === destFolderId) return;
      await api.sessionMove(sessionId, destFolderId, 0);
      return;
    }

    const crossFolder = cur.folder_id !== destFolderId;
    if (crossFolder) {
      await api.sessionMove(sessionId, destFolderId, 0);
    }
    // Build new order among sessions in destFolderId.
    const existingInDest = sessions
      .filter((s) => s.folder_id === destFolderId && s.id !== sessionId)
      .sort((a, b) => a.sort - b.sort || a.id - b.id)
      .map((s) => s.id);

    const ordered = buildOrderForSessionDrop(existingInDest, sessionId, slot);
    if (ordered.length <= 1 && !crossFolder) return;
    await api.sessionReorder(destFolderId, ordered);
  }

  async function dropFolder(folderId: number, slot: DropSlot) {
    const cur = folders.find((f) => f.id === folderId);
    if (!cur) return;
    if (slot.kind === 'into-folder' && slot.folderId === folderId) return;

    // Destination parent for the folder.
    const destParentId = resolveDestFolderId(slot);
    if (destParentId === undefined) return;
    // Can't make a folder its own ancestor — the backend will reject
    // the cycle anyway but we short-circuit here for a cleaner UX.
    if (destParentId === folderId) return;

    if (slot.kind === 'into-folder' || slot.kind === 'into-root') {
      if (cur.parent_id === destParentId) return;
      await api.folderMove(folderId, destParentId, 0);
      if (destParentId !== null) {
        setExpanded((prev) => new Set(prev).add(destParentId));
      }
      return;
    }

    const crossParent = cur.parent_id !== destParentId;
    if (crossParent) {
      await api.folderMove(folderId, destParentId, 0);
    }
    const existingInDest = folders
      .filter((f) => f.parent_id === destParentId && f.id !== folderId)
      .sort((a, b) => a.sort - b.sort || a.id - b.id)
      .map((f) => f.id);
    const ordered = buildOrderForFolderDrop(existingInDest, folderId, slot);
    if (ordered.length <= 1 && !crossParent) return;
    await api.folderReorder(destParentId, ordered);
  }

  function resolveDestFolderId(slot: DropSlot): number | null | undefined {
    switch (slot.kind) {
      case 'into-root':
        return null;
      case 'into-folder':
        return slot.folderId;
      case 'before-session':
      case 'after-session': {
        const sib = sessions.find((s) => s.id === slot.sessionId);
        return sib ? sib.folder_id : undefined;
      }
      case 'before-folder':
      case 'after-folder': {
        const sib = folders.find((f) => f.id === slot.folderId);
        return sib ? sib.parent_id : undefined;
      }
    }
  }

  function buildOrderForSessionDrop(
    existingInDest: number[],
    draggedId: number,
    slot: DropSlot,
  ): number[] {
    if (slot.kind === 'before-session' || slot.kind === 'after-session') {
      const anchor = slot.sessionId;
      const idx = existingInDest.indexOf(anchor);
      if (idx < 0) return [draggedId, ...existingInDest];
      const insertAt = slot.kind === 'before-session' ? idx : idx + 1;
      return [
        ...existingInDest.slice(0, insertAt),
        draggedId,
        ...existingInDest.slice(insertAt),
      ];
    }
    // before-folder / after-folder from a session drag: drop at the top
    // of the folder's parent's session list. Rare; we just prepend.
    return [draggedId, ...existingInDest];
  }

  function buildOrderForFolderDrop(
    existingInDest: number[],
    draggedId: number,
    slot: DropSlot,
  ): number[] {
    if (slot.kind === 'before-folder' || slot.kind === 'after-folder') {
      const anchor = slot.folderId;
      const idx = existingInDest.indexOf(anchor);
      if (idx < 0) return [draggedId, ...existingInDest];
      const insertAt = slot.kind === 'before-folder' ? idx : idx + 1;
      return [
        ...existingInDest.slice(0, insertAt),
        draggedId,
        ...existingInDest.slice(insertAt),
      ];
    }
    // before-session / after-session isn't a valid folder drop slot; the
    // caller sorted this out by resolving destFolderId. Prepend fallback.
    return [draggedId, ...existingInDest];
  }

  function openSessionMenu(e: React.MouseEvent, s: Session) {
    e.preventDefault();
    setSelectedId(s.id);
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Connect', onClick: () => openTabAction(s) },
        { label: 'Edit', onClick: () => setDialog({ mode: 'edit', session: s }) },
        {
          label: 'Duplicate',
          onClick: async () => {
            await run(() => api.sessionDuplicate(s.id));
            reload();
          },
        },
        { separator: true },
        { label: 'Move to folder…', onClick: () => setMoveSession(s) },
        { separator: true },
        { label: 'Delete', danger: true, onClick: () => setConfirm({ kind: 'delete-session', session: s }) },
      ],
    });
  }

  function NodeView({ node, depth }: { node: TreeNode; depth: number }) {
    const isOpen = node.folder ? expanded.has(node.folder.id) : true;
    const FolderIcon = isOpen ? FolderOpen : Folder;
    const folderId = node.folder?.id ?? null;
    const isDragSource = !!(
      node.folder && drag?.kind === 'folder' && drag.id === node.folder.id
    );
    const isIntoTarget =
      node.folder != null
      && dragTarget?.kind === 'into-folder'
      && dragTarget.folderId === node.folder.id;
    const hasBeforeEdge =
      node.folder != null
      && dragTarget?.kind === 'before-folder'
      && dragTarget.folderId === node.folder.id;
    const hasAfterEdge =
      node.folder != null
      && dragTarget?.kind === 'after-folder'
      && dragTarget.folderId === node.folder.id;
    const sessionCount = countDescendantSessions(node);
    return (
      <div>
        {node.folder && (
          <div
            draggable
            onDragStart={(e) => handleDragStart(e, 'folder', node.folder!.id)}
            onDragEnd={handleDragEnd}
            onDragOver={(e) => handleDragOver(e, slotForRow(e, 'folder', node.folder!.id))}
            onDrop={(e) => handleDrop(e, slotForRow(e, 'folder', node.folder!.id))}
            onClick={() => toggleFolder(node.folder!.id)}
            onContextMenu={(e) => openFolderMenu(e, node.folder!)}
            className={`group relative h-7 flex items-center gap-1.5 cursor-default select-none pr-2 transition-colors ${
              isIntoTarget
                ? 'bg-accent/20 outline outline-1 outline-accent/60 text-fg'
                : 'text-fg/80 hover:text-fg hover:bg-surface2/70'
            } ${isDragSource ? 'opacity-50' : ''}`}
            style={{ paddingLeft: 6 + depth * 12 }}
            role="treeitem"
            aria-expanded={isOpen}
            aria-selected={false}
          >
            {hasBeforeEdge && <DropLine edge="top" />}
            {hasAfterEdge  && <DropLine edge="bottom" />}
            <span className="w-3 h-3 flex items-center justify-center text-muted/80 shrink-0">
              {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            </span>
            <FolderIcon
              size={14}
              className={`shrink-0 ${isOpen ? 'text-accent' : 'text-accent/70'}`}
              strokeWidth={2}
            />
            <span className="truncate text-xs font-medium flex-1">{node.folder.name}</span>
            {sessionCount > 0 && (
              <span
                className="shrink-0 text-[10px] font-mono tabular-nums px-1.5 py-[1px] rounded-sm bg-surface2/80 text-muted group-hover:bg-surface2 group-hover:text-fg/80"
                title={`${sessionCount} session${sessionCount === 1 ? '' : 's'}`}
              >
                {sessionCount}
              </span>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setConfirm({ kind: 'delete-folder', folder: node.folder! });
              }}
              aria-label={`Delete folder ${node.folder.name}`}
              title="Delete folder"
              className="shrink-0 w-5 h-5 flex items-center justify-center rounded-sm opacity-0 group-hover:opacity-100 text-muted hover:text-danger hover:bg-danger/10"
            >
              <Trash2 size={11} />
            </button>
          </div>
        )}
        {isOpen && (
          <>
            {/* Folders BEFORE sessions at every depth (implementation-notes §2). */}
            {node.folders.map((child) => (
              <NodeView key={child.folder!.id} node={child} depth={depth + 1} />
            ))}
            {node.sessions.map((s) => {
              const isSelected  = selectedId === s.id;
              const isConnected = connectedSessionIds.has(s.id);
              const isSrc = drag?.kind === 'session' && drag.id === s.id;
              const sessionHasBefore = dragTarget?.kind === 'before-session' && dragTarget.sessionId === s.id;
              const sessionHasAfter  = dragTarget?.kind === 'after-session'  && dragTarget.sessionId === s.id;
              // Left-rail colour priority: connected green > selected accent
              // > session's own colour > transparent.
              const rail = isConnected
                ? 'rgb(var(--success))'
                : isSelected
                  ? 'rgb(var(--accent))'
                  : s.color ?? 'transparent';
              return (
                <div
                  key={s.id}
                  draggable
                  onDragStart={(e) => handleDragStart(e, 'session', s.id)}
                  onDragEnd={handleDragEnd}
                  onClick={() => setSelectedId(s.id)}
                  onContextMenu={(e) => openSessionMenu(e, s)}
                  onDoubleClick={() => openTabAction(s)}
                  onDragOver={(e) => {
                    if (!drag) return;
                    // Split the row 50/50: top half places the dragged item
                    // *before* this session, bottom half *after*. Works for
                    // both same-folder reordering and cross-folder moves
                    // (the drop handler resolves destFolderId from the
                    // anchor session's folder).
                    handleDragOver(e, slotForRow(e, 'session', s.id));
                  }}
                  onDrop={(e) => {
                    if (!drag) return;
                    handleDrop(e, slotForRow(e, 'session', s.id));
                  }}
                  className={`group relative h-7 flex items-center gap-2 cursor-default select-none pr-2 transition-colors ${
                    isSelected
                      ? 'bg-accent/18 text-fg'
                      : 'hover:bg-surface2/70 text-fg/90 hover:text-fg'
                  } ${isSrc ? 'opacity-50' : ''}`}
                  style={{ paddingLeft: 6 + (depth + 1) * 12 }}
                  role="treeitem"
                  aria-selected={isSelected}
                  title={`${s.username}@${s.host}${s.port !== 22 ? `:${s.port}` : ''}`}
                >
                  {sessionHasBefore && <DropLine edge="top" />}
                  {sessionHasAfter  && <DropLine edge="bottom" />}
                  <span
                    className={`absolute left-0 top-1 bottom-1 w-[3px] rounded-r-sm ${
                      isConnected ? 'animate-pulse' : ''
                    }`}
                    style={{ background: rail }}
                    aria-hidden
                  />
                  {(() => {
                    const KindIcon =
                      s.session_kind === 'wsl' ? SquareTerminal :
                      s.session_kind === 'local' ? MonitorDot :
                      Server;
                    // Tile priority: connected green > per-session colour >
                    // kind default. Keeps user branding visible when idle,
                    // flips to a clear "live" signal while connected.
                    const tileBg = isConnected
                      ? 'rgb(var(--success))'
                      : (s.color ?? KIND_DEFAULT_TILE[s.session_kind]);
                    return (
                      <span
                        className="shrink-0 w-[18px] h-[18px] rounded-sm flex items-center justify-center"
                        style={{ background: tileBg }}
                        aria-hidden
                      >
                        <KindIcon
                          size={11}
                          className="text-white"
                          strokeWidth={2.25}
                        />
                      </span>
                    );
                  })()}
                  <span className={`truncate text-xs flex-1 ${isSelected ? 'font-medium' : ''}`}>
                    {s.name}
                  </span>
                </div>
              );
            })}
          </>
        )}
      </div>
    );
  }

  const empty = folders.length === 0 && sessions.length === 0;

  return (
    <>
      {/* Toolbar: actions left, collapse right. One 28px row, no separate
          label — the tree itself is self-explanatory and MobaXterm keeps
          this row tight. */}
      <div className="h-7 px-1.5 flex items-center gap-0.5 border-b border-border shrink-0">
        <button
          type="button"
          onClick={() => setDialog({ mode: 'create', folderId: null })}
          aria-label="New session"
          title="New session"
          className="icon-btn"
        >
          <Plus size={14} />
        </button>
        <button
          type="button"
          onClick={() => setPrompt({ kind: 'new-folder', parentId: null })}
          aria-label="New folder"
          title="New folder"
          className="icon-btn"
        >
          <FolderPlus size={14} />
        </button>
        <button
          type="button"
          onClick={pickMobaXtermFile}
          aria-label="Import from MobaXterm"
          title="Import from MobaXterm"
          className="icon-btn"
        >
          <FileInput size={14} />
        </button>
        <span className="flex-1" />
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label="Hide sessions sidebar"
          title="Hide sessions (Ctrl+B)"
          className="icon-btn"
        >
          <PanelLeftClose size={14} />
        </button>
      </div>

      {/* Tree — the whole container is a drop zone for "move to root".
          Individual rows have their own onDragOver that stops propagation
          for folder drops, so this only fires when the user hovers open
          whitespace or a root-level row while dragging. */}
      <div
        className={`flex-1 min-h-0 overflow-auto py-1 transition-colors ${
          drag && dragTarget?.kind === 'into-root' ? 'bg-accent/10 outline outline-1 outline-accent/40 -outline-offset-1' : ''
        }`}
        role="tree"
        aria-label="Sessions"
        onContextMenu={(e) => { if (e.target === e.currentTarget) openFolderMenu(e, null); }}
        onDragOver={(e) => handleDragOver(e, { kind: 'into-root' })}
        onDrop={(e) => handleDrop(e, { kind: 'into-root' })}
      >
        {empty ? (
          <EmptyState
            icon={Terminal}
            title="No sessions yet"
            body="Create your first saved connection."
            action={{ label: 'New session', onClick: () => setDialog({ mode: 'create', folderId: null }) }}
            compact
          />
        ) : (
          <NodeView node={tree} depth={0} />
        )}
      </div>

      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}

      {dialog && (
        <SessionDialog
          {...(dialog.mode === 'create'
            ? { mode: 'create' as const, folderId: dialog.folderId }
            : { mode: 'edit' as const, session: dialog.session })}
          folders={folders}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            reload();
            toast.success(
              dialog.mode === 'edit' ? 'Session saved' : 'Session created',
            );
          }}
        />
      )}

      {prompt?.kind === 'new-folder' && (
        <PromptDialog
          title="New folder"
          label="Folder name"
          placeholder="My servers"
          confirmText="Create"
          onCancel={() => setPrompt(null)}
          onConfirm={async (name) => {
            await run(() => api.folderCreate(prompt.parentId, name));
            setPrompt(null);
            reload();
            toast.success('Folder created', name);
          }}
        />
      )}

      {prompt?.kind === 'rename-folder' && (
        <PromptDialog
          title={`Rename "${prompt.folder.name}"`}
          label="Folder name"
          initialValue={prompt.folder.name}
          confirmText="Rename"
          onCancel={() => setPrompt(null)}
          onConfirm={async (name) => {
            await run(() => api.folderRename(prompt.folder.id, name));
            setPrompt(null);
            reload();
            toast.success('Folder renamed');
          }}
        />
      )}

      {confirm?.kind === 'delete-folder' && (
        <ConfirmDialog
          kind="danger"
          title={`Delete folder "${confirm.folder.name}"?`}
          body="Subfolders will be deleted. Sessions inside will be moved to the root."
          confirmText="Delete"
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            await run(() => api.folderDelete(confirm.folder.id));
            setConfirm(null);
            reload();
            toast.success('Folder deleted', confirm.folder.name);
          }}
        />
      )}

      {syncOpen && (
        <SyncDialog
          onClose={() => setSyncOpen(false)}
          onPullToRestore={(tempPath) => {
            setSyncOpen(false);
            setRestorePath(tempPath);
          }}
        />
      )}

      {backupOpen && (
        <BackupDialog
          onCancel={() => setBackupOpen(false)}
          onDone={(summary) => {
            setBackupOpen(false);
            const parts = [
              summary.sessions && `${summary.sessions} session${summary.sessions === 1 ? '' : 's'}`,
              summary.credentials && `${summary.credentials} credential${summary.credentials === 1 ? '' : 's'}`,
              summary.folders && `${summary.folders} folder${summary.folders === 1 ? '' : 's'}`,
              summary.known_hosts && `${summary.known_hosts} known host${summary.known_hosts === 1 ? '' : 's'}`,
            ].filter(Boolean).join(', ');
            toast.success('Backup saved', parts || 'empty backup');
          }}
        />
      )}

      {restorePath && (
        <RestoreDialog
          filePath={restorePath}
          onCancel={() => setRestorePath(null)}
          onDone={(summary) => {
            setRestorePath(null);
            reload();
            const parts = [
              summary.sessions_created && `${summary.sessions_created} session${summary.sessions_created === 1 ? '' : 's'}`,
              summary.credentials_created && `${summary.credentials_created} credential${summary.credentials_created === 1 ? '' : 's'}`,
              summary.folders_created && `${summary.folders_created} folder${summary.folders_created === 1 ? '' : 's'}`,
              summary.known_hosts_upserted && `${summary.known_hosts_upserted} host${summary.known_hosts_upserted === 1 ? '' : 's'}`,
              summary.settings_applied && `${summary.settings_applied} setting${summary.settings_applied === 1 ? '' : 's'}`,
            ].filter(Boolean).join(', ');
            toast.success('Restore complete', parts || 'nothing imported');
          }}
        />
      )}

      {importPath && (
        <ImportMobaxtermDialog
          filePath={importPath}
          onCancel={() => setImportPath(null)}
          onDone={(result) => {
            setImportPath(null);
            reload();
            const parts = [
              result.created && `${result.created} created`,
              result.updated && `${result.updated} updated`,
              result.skipped_duplicate && `${result.skipped_duplicate} skipped`,
              result.created_folders && `${result.created_folders} folder${result.created_folders === 1 ? '' : 's'}`,
              result.imported_keys.length && `${result.imported_keys.length} key${result.imported_keys.length === 1 ? '' : 's'}`,
            ].filter(Boolean).join(', ');
            const body = parts || 'Nothing to import';
            if (result.missing_keys.length > 0) {
              toast.danger(
                'Import complete with missing keys',
                `${body}. Could not read: ${result.missing_keys.slice(0, 5).join(', ')}${
                  result.missing_keys.length > 5 ? ` (+${result.missing_keys.length - 5} more)` : ''
                }`,
              );
            } else {
              toast.success('Import complete', body);
            }
          }}
        />
      )}

      {moveSession && (
        <MoveToFolderDialog
          title={`Move "${moveSession.name}" to…`}
          folders={folders}
          currentFolderId={moveSession.folder_id}
          onCancel={() => setMoveSession(null)}
          onConfirm={async (folderId) => {
            const s = moveSession;
            await run(() => api.sessionMove(s.id, folderId, 0));
            setMoveSession(null);
            if (folderId !== null) {
              setExpanded((prev) => new Set(prev).add(folderId));
            }
            reload();
            toast.success('Session moved', s.name);
          }}
        />
      )}

      {moveFolder && (
        <MoveToFolderDialog
          title={`Move folder "${moveFolder.name}" to…`}
          folders={folders}
          currentFolderId={moveFolder.parent_id}
          excludedIds={descendantFolderIds(moveFolder)}
          onCancel={() => setMoveFolder(null)}
          onConfirm={async (parentId) => {
            const f = moveFolder;
            await run(() => api.folderMove(f.id, parentId, 0));
            setMoveFolder(null);
            if (parentId !== null) {
              setExpanded((prev) => new Set(prev).add(parentId));
            }
            reload();
            toast.success('Folder moved', f.name);
          }}
        />
      )}

      {confirm?.kind === 'delete-session' && (
        <ConfirmDialog
          kind="danger"
          title={`Delete "${confirm.session.name}"?`}
          body="This also removes any saved credentials attached to this session."
          confirmText="Delete"
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            await run(() => api.sessionDelete(confirm.session.id));
            setConfirm(null);
            reload();
            toast.success('Session deleted', confirm.session.name);
          }}
        />
      )}
    </>
  );
}
