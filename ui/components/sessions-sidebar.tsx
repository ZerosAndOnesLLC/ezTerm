'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FileInput,
  Folder,
  FolderOpen,
  FolderPlus,
  PanelLeftClose,
  Plus,
  Terminal,
} from 'lucide-react';
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

interface TreeNode {
  folder: TFolder | null; // null = root
  folders: TreeNode[];
  sessions: Session[];
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
      items.push({ label: 'Import from MobaXterm\u2026', onClick: pickMobaXtermFile });
    }
    setMenu({ x: e.clientX, y: e.clientY, items });
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
    return (
      <div>
        {node.folder && (
          <div
            onClick={() => toggleFolder(node.folder!.id)}
            onContextMenu={(e) => openFolderMenu(e, node.folder!)}
            className="h-6 flex items-center gap-1.5 text-muted hover:text-fg hover:bg-surface2/60 cursor-default select-none pr-2"
            style={{ paddingLeft: 4 + depth * 10 }}
            role="treeitem"
            aria-expanded={isOpen}
            aria-selected={false}
          >
            <span className="w-3 h-3 flex items-center justify-center text-muted/80 shrink-0">
              {isOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            </span>
            <FolderIcon size={13} className="text-muted shrink-0" />
            <span className="truncate text-xs">{node.folder.name}</span>
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
              return (
                <div
                  key={s.id}
                  onClick={() => setSelectedId(s.id)}
                  onContextMenu={(e) => openSessionMenu(e, s)}
                  onDoubleClick={() => openTabAction(s)}
                  className={`group relative h-6 flex items-center gap-1.5 cursor-default select-none pr-2 ${
                    isSelected ? 'bg-accent/18 text-fg' : 'hover:bg-surface2/60 text-fg/90 hover:text-fg'
                  }`}
                  style={{ paddingLeft: 4 + (depth + 1) * 10 }}
                  role="treeitem"
                  aria-selected={isSelected}
                  title={`${s.username}@${s.host}${s.port !== 22 ? `:${s.port}` : ''}`}
                >
                  {isConnected && (
                    <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-success" aria-hidden />
                  )}
                  <Terminal
                    size={13}
                    className={`shrink-0 ${isConnected ? 'text-success' : 'text-muted'}`}
                  />
                  {s.color && (
                    <span
                      className="w-1.5 h-1.5 rounded-full shrink-0"
                      style={{ background: s.color }}
                      aria-hidden
                    />
                  )}
                  <span className="truncate text-xs flex-1">{s.name}</span>
                  <span className="text-muted text-[10px] opacity-0 group-hover:opacity-100 font-mono truncate max-w-[100px]">
                    {s.username}@{s.host}
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

      {/* Tree */}
      <div
        className="flex-1 min-h-0 overflow-auto py-1"
        role="tree"
        aria-label="Sessions"
        onContextMenu={(e) => { if (e.target === e.currentTarget) openFolderMenu(e, null); }}
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
