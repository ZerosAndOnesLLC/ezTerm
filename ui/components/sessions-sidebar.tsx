'use client';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/tauri';
import type { Folder, Session } from '@/lib/types';
import { ContextMenu, type MenuItem } from './context-menu';
import { SessionDialog } from './session-dialog';

interface TreeNode {
  folder: Folder | null; // null = root
  folders: TreeNode[];
  sessions: Session[];
}

function buildTree(folders: Folder[], sessions: Session[]): TreeNode {
  const byParent = new Map<number | null, Folder[]>();
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
  function build(parent: Folder | null): TreeNode {
    const pid = parent ? parent.id : null;
    return {
      folder: parent,
      folders: (byParent.get(pid) ?? []).map((f) => build(f)),
      sessions: sessByFolder.get(pid) ?? [],
    };
  }
  return build(null);
}

type DialogState =
  | { mode: 'create'; folderId: number | null }
  | { mode: 'edit'; session: Session };

export function SessionsSidebar() {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);

  async function reload() {
    const [f, s] = await Promise.all([api.folderList(), api.sessionList()]);
    setFolders(f);
    setSessions(s);
  }

  useEffect(() => {
    reload();
  }, []);

  const tree = useMemo(() => buildTree(folders, sessions), [folders, sessions]);

  async function newFolder(parentId: number | null) {
    const name = window.prompt('Folder name');
    if (name && name.trim()) {
      await api.folderCreate(parentId, name.trim());
      reload();
    }
  }

  function openFolderMenu(e: React.MouseEvent, f: Folder | null) {
    e.preventDefault();
    const id = f?.id ?? null;
    const items: MenuItem[] = [
      { label: 'New Session', onClick: () => setDialog({ mode: 'create', folderId: id }) },
      { label: 'New Folder', onClick: () => newFolder(id) },
    ];
    if (f) {
      items.push(
        {
          label: 'Rename',
          onClick: async () => {
            const n = window.prompt('Rename', f.name);
            if (n && n.trim()) {
              await api.folderRename(f.id, n.trim());
              reload();
            }
          },
        },
        {
          label: 'Delete',
          danger: true,
          onClick: async () => {
            if (window.confirm(`Delete "${f.name}" and all children?`)) {
              await api.folderDelete(f.id);
              reload();
            }
          },
        },
      );
    }
    setMenu({ x: e.clientX, y: e.clientY, items });
  }

  function openSessionMenu(e: React.MouseEvent, s: Session) {
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Connect', disabled: true, onClick: () => {/* Plan 2 */} },
        { label: 'Edit', onClick: () => setDialog({ mode: 'edit', session: s }) },
        {
          label: 'Duplicate',
          onClick: async () => {
            await api.sessionDuplicate(s.id);
            reload();
          },
        },
        {
          label: 'Delete',
          danger: true,
          onClick: async () => {
            if (window.confirm(`Delete "${s.name}"?`)) {
              await api.sessionDelete(s.id);
              reload();
            }
          },
        },
      ],
    });
  }

  function NodeView({ node, depth }: { node: TreeNode; depth: number }) {
    return (
      <div>
        {node.folder && (
          <div
            onContextMenu={(e) => openFolderMenu(e, node.folder!)}
            className="px-2 py-1 text-muted hover:bg-surface2 cursor-default select-none"
            style={{ paddingLeft: 8 + depth * 10 }}
            role="treeitem"
            aria-selected={false}
          >
            <span aria-hidden>▸ </span>
            {node.folder.name}
          </div>
        )}
        {/* Folders BEFORE sessions at every depth (implementation-notes §2). */}
        {node.folders.map((child) => (
          <NodeView key={child.folder!.id} node={child} depth={depth + 1} />
        ))}
        {node.sessions.map((s) => (
          <div
            key={s.id}
            onContextMenu={(e) => openSessionMenu(e, s)}
            onDoubleClick={() => {/* Plan 2: connect */}}
            className="px-2 py-1 hover:bg-surface2 cursor-default truncate select-none"
            style={{ paddingLeft: 8 + (depth + 1) * 10 }}
            role="treeitem"
            aria-selected={false}
            title={`${s.username}@${s.host}`}
          >
            {s.color && <span style={{ color: s.color }}>● </span>}
            {s.name}{' '}
            <span className="text-muted text-xs">
              {s.username}@{s.host}
            </span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      className="h-full flex flex-col"
      onContextMenu={(e) => {
        if (e.target === e.currentTarget) openFolderMenu(e, null);
      }}
    >
      <div className="px-3 py-2 text-xs uppercase tracking-wider text-muted border-b border-border">
        Sessions
      </div>
      <div
        className="flex-1 overflow-auto py-1"
        role="tree"
        aria-label="Sessions"
        onContextMenu={(e) => {
          if (e.target === e.currentTarget) openFolderMenu(e, null);
        }}
      >
        <NodeView node={tree} depth={0} />
      </div>
      <button
        type="button"
        onClick={() => setDialog({ mode: 'create', folderId: null })}
        className="m-2 px-3 py-1.5 rounded bg-accent text-white text-sm hover:brightness-110 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        + New Session
      </button>
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
          }}
        />
      )}
    </div>
  );
}
