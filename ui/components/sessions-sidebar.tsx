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

/** Colour palette for folder icons. Deterministic hash of the folder name
 *  picks one — gives the tree visual variety without a DB column. */
const FOLDER_PALETTE = [
  '#60a5fa', '#34d399', '#fbbf24', '#f87171',
  '#a78bfa', '#22d3ee', '#f472b6', '#fb923c',
] as const;

function folderColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (Math.imul(h, 31) + name.charCodeAt(i)) | 0;
  return FOLDER_PALETTE[Math.abs(h) % FOLDER_PALETTE.length];
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
  // Drag-and-drop state: `drag` is the row being dragged (opacity-50 on the
  // source); `dragTarget` is the hovered drop zone — a folder id, or 'root'
  // for the background drop zone. null when nothing is being dragged-over.
  const [drag, setDrag] = useState<{ kind: 'session' | 'folder'; id: number } | null>(null);
  const [dragTarget, setDragTarget] = useState<number | 'root' | null>(null);

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
    const items: MenuItem[] = [
      { label: 'New Session', onClick: () => setDialog({ mode: 'create', folderId: id }) },
      { label: 'New Folder', onClick: () => setPrompt({ kind: 'new-folder', parentId: id }) },
    ];
    if (f) {
      items.push(
        { label: 'Rename', onClick: () => setPrompt({ kind: 'rename-folder', folder: f }) },
        { label: 'Delete', danger: true, onClick: () => setConfirm({ kind: 'delete-folder', folder: f }) },
      );
    } else {
      items.push(
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

  function handleDragOver(e: React.DragEvent, target: number | 'root') {
    // Self-drop (folder into itself) — don't accept. Read from the ref so
    // we're synchronous with dragstart regardless of React's batching.
    const src = dragSourceRef.current;
    if (src && src.kind === 'folder' && target === src.id) return;
    // Always preventDefault so the browser keeps treating us as a valid
    // drop target. The full-payload validity check happens at drop time.
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (dragTarget !== target) setDragTarget(target);
  }

  async function handleDrop(e: React.DragEvent, target: number | 'root') {
    e.preventDefault();
    e.stopPropagation();
    const raw = e.dataTransfer.getData('application/json');
    dragSourceRef.current = null;
    setDrag(null);
    setDragTarget(null);
    if (!raw) return;
    let payload: { kind: 'session' | 'folder'; id: number };
    try { payload = JSON.parse(raw); } catch { return; }
    const folderId: number | null = target === 'root' ? null : target;

    // No-op if dropping onto current parent.
    if (payload.kind === 'session') {
      const cur = sessions.find((s) => s.id === payload.id);
      if (cur && cur.folder_id === folderId) return;
    } else {
      const cur = folders.find((f) => f.id === payload.id);
      if (!cur) return;
      if (cur.parent_id === folderId) return;
      if (folderId === payload.id) return; // self
    }

    try {
      if (payload.kind === 'session') {
        await api.sessionMove(payload.id, folderId, 0);
      } else {
        await api.folderMove(payload.id, folderId, 0);
      }
      if (folderId !== null) {
        setExpanded((prev) => new Set(prev).add(folderId));
      }
      reload();
    } catch (err) {
      toast.danger('Move failed', errMessage(err));
    }
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
    const isDropTarget =
      node.folder != null && dragTarget === node.folder.id;
    const folderTint = node.folder ? folderColor(node.folder.name) : undefined;
    const sessionCount = countDescendantSessions(node);
    return (
      <div>
        {node.folder && (
          <div
            draggable
            onDragStart={(e) => handleDragStart(e, 'folder', node.folder!.id)}
            onDragEnd={handleDragEnd}
            onDragOver={(e) => handleDragOver(e, node.folder!.id)}
            onDrop={(e) => handleDrop(e, node.folder!.id)}
            onClick={() => toggleFolder(node.folder!.id)}
            onContextMenu={(e) => openFolderMenu(e, node.folder!)}
            className={`group relative h-7 flex items-center gap-1.5 cursor-default select-none pr-2 transition-colors ${
              isDropTarget
                ? 'bg-accent/20 outline outline-1 outline-accent/60 text-fg'
                : 'text-fg/80 hover:text-fg hover:bg-surface2/70'
            } ${isDragSource ? 'opacity-50' : ''}`}
            style={{ paddingLeft: 6 + depth * 12 }}
            role="treeitem"
            aria-expanded={isOpen}
            aria-selected={false}
          >
            <span className="w-3 h-3 flex items-center justify-center text-muted/80 shrink-0">
              {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            </span>
            <FolderIcon
              size={14}
              className="shrink-0"
              style={{ color: folderTint }}
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
                    // Sessions aren't drop targets themselves; redirect the
                    // hover highlight to the enclosing folder (or root) so
                    // dragging over a session inside a folder still signals
                    // the valid drop location.
                    if (!drag) return;
                    handleDragOver(e, folderId ?? 'root');
                  }}
                  onDrop={(e) => { if (drag) handleDrop(e, folderId ?? 'root'); }}
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
                    return (
                      <KindIcon
                        size={13}
                        className="shrink-0"
                        style={{ color: isConnected ? 'rgb(var(--success))' : (s.color ?? undefined) }}
                        strokeWidth={2}
                      />
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
          drag && dragTarget === 'root' ? 'bg-accent/10 outline outline-1 outline-accent/40 -outline-offset-1' : ''
        }`}
        role="tree"
        aria-label="Sessions"
        onContextMenu={(e) => { if (e.target === e.currentTarget) openFolderMenu(e, null); }}
        onDragOver={(e) => handleDragOver(e, 'root')}
        onDrop={(e) => handleDrop(e, 'root')}
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
