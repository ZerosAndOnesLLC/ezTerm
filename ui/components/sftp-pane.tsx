'use client';
import { useCallback, useEffect, useState } from 'react';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { api, errMessage } from '@/lib/tauri';
import type { SftpEntry } from '@/lib/types';
import { useTabs, type Tab } from '@/lib/tabs-store';
import { ContextMenu, type MenuItem } from './context-menu';
import { SftpBreadcrumb } from './sftp-breadcrumb';
import { SftpFileRow } from './sftp-file-row';
import { TransferStatus, type TrackedTransfer } from './transfer-status';

/// Join a parent dir and a filename while keeping root (`/`) tidy.
function joinRemote(dir: string, name: string): string {
  if (dir === '/' || dir === '') return `/${name}`;
  return `${dir.replace(/\/+$/, '')}/${name}`;
}

export function SftpPane({ tab }: { tab: Tab }) {
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<TrackedTransfer[]>([]);
  const [opened, setOpened] = useState(false);
  const setCwd = useTabs((s) => s.setCwd);

  const refresh = useCallback(async () => {
    if (tab.connectionId == null || !opened) return;
    try {
      setError(null);
      const list = await api.sftpList(tab.connectionId, tab.cwd);
      setEntries(list);
    } catch (e) {
      setError(errMessage(e));
    }
  }, [tab.connectionId, tab.cwd, opened]);

  // Open SFTP subsystem once when this pane first becomes visible on a
  // connected tab. `opened` gates the subsequent list call so we don't fire
  // before the subsystem hand-shake completes.
  useEffect(() => {
    if (tab.connectionId == null || !tab.sftpOpen || opened) return;
    let cancelled = false;
    (async () => {
      try {
        await api.sftpOpen(tab.connectionId!);
        if (cancelled) return;
        const home = await api.sftpRealpath(tab.connectionId!, '.').catch(() => '/');
        if (cancelled) return;
        setCwd(tab.tabId, home || '/');
        setOpened(true);
      } catch (e) {
        if (!cancelled) setError(errMessage(e));
      }
    })();
    return () => { cancelled = true; };
  }, [tab.connectionId, tab.sftpOpen, tab.tabId, opened, setCwd]);

  // Reload on cwd change (post-open).
  useEffect(() => { refresh(); }, [refresh]);

  function navigateInto(e: SftpEntry) {
    if (e.is_dir) setCwd(tab.tabId, e.full_path);
  }

  function openContext(e: SftpEntry, x: number, y: number) {
    const cid = tab.connectionId;
    if (cid == null) return;
    const items: MenuItem[] = [];
    if (!e.is_dir) {
      items.push({
        label: 'Download…',
        onClick: async () => {
          try {
            const local = await saveDialog({ defaultPath: e.name });
            if (typeof local === 'string') {
              const t = await api.sftpDownload(cid, e.full_path, local);
              setTransfers((prev) => [...prev, { transferId: t.transfer_id, label: `download ${e.name}` }]);
            }
          } catch (er) {
            setError(errMessage(er));
          }
        },
      });
    }
    items.push({
      label: 'Rename…',
      onClick: async () => {
        const n = window.prompt('Rename', e.name);
        if (n && n.trim()) {
          const parent = e.full_path.replace(/\/[^/]+$/, '') || '/';
          const to = joinRemote(parent, n.trim());
          try {
            await api.sftpRename(cid, e.full_path, to);
            refresh();
          } catch (er) {
            setError(errMessage(er));
          }
        }
      },
    });
    items.push({
      label: 'Delete',
      danger: true,
      onClick: async () => {
        if (!window.confirm(`Delete ${e.name}?`)) return;
        try {
          if (e.is_dir) await api.sftpRmdir(cid, e.full_path);
          else          await api.sftpRemove(cid, e.full_path);
          refresh();
        } catch (er) {
          setError(errMessage(er));
        }
      },
    });
    setMenu({ x, y, items });
  }

  /// Drag-drop upload. Tauri v2's webview does not reliably populate
  /// `File.path` on drop, so when it's missing we pop a native open dialog
  /// as a fallback — this keeps the UX one-click instead of silently failing.
  async function handleDrop(ev: React.DragEvent) {
    ev.preventDefault();
    const cid = tab.connectionId;
    if (cid == null) return;
    const files = Array.from(ev.dataTransfer?.files ?? []) as File[];
    if (files.length === 0) return;
    try {
      for (const f of files) {
        const localFromDrop = (f as unknown as { path?: string }).path ?? '';
        let local = localFromDrop;
        if (!local) {
          const picked = await openDialog({ multiple: false, title: `Select file to upload (drag-drop path not available)` });
          if (typeof picked !== 'string') continue;
          local = picked;
        }
        const remote = joinRemote(tab.cwd, f.name || local.split(/[\\/]/).pop() || 'upload');
        const t = await api.sftpUpload(cid, local, remote);
        const labelName = f.name || remote.split('/').pop() || 'file';
        setTransfers((prev) => [...prev, { transferId: t.transfer_id, label: `upload ${labelName}` }]);
      }
      // Transfers are async — the refresh a moment later lets the list catch up.
      setTimeout(refresh, 500);
    } catch (er) {
      setError(errMessage(er));
    }
  }

  async function handleUploadClick() {
    const cid = tab.connectionId;
    if (cid == null) return;
    try {
      const picked = await openDialog({ multiple: false });
      if (typeof picked !== 'string') return;
      const name = picked.split(/[\\/]/).pop() ?? 'upload';
      const remote = joinRemote(tab.cwd, name);
      const t = await api.sftpUpload(cid, picked, remote);
      setTransfers((prev) => [...prev, { transferId: t.transfer_id, label: `upload ${name}` }]);
      setTimeout(refresh, 500);
    } catch (er) {
      setError(errMessage(er));
    }
  }

  async function handleMkdir() {
    const cid = tab.connectionId;
    if (cid == null) return;
    const n = window.prompt('New directory name');
    if (!n || !n.trim()) return;
    try {
      await api.sftpMkdir(cid, joinRemote(tab.cwd, n.trim()));
      refresh();
    } catch (er) {
      setError(errMessage(er));
    }
  }

  return (
    <div
      className="h-full w-64 border-r border-border bg-surface flex flex-col min-h-0 shrink-0"
      onDragOver={(ev) => { ev.preventDefault(); }}
      onDrop={handleDrop}
    >
      <div className="px-2 py-1.5 border-b border-border flex items-center gap-1">
        <SftpBreadcrumb path={tab.cwd} onNavigate={(p) => setCwd(tab.tabId, p)} />
        <button
          type="button"
          onClick={handleMkdir}
          title="New directory"
          aria-label="New directory"
          className="shrink-0 text-muted hover:text-fg px-1 text-xs"
        >
          +dir
        </button>
        <button
          type="button"
          onClick={handleUploadClick}
          title="Upload file"
          aria-label="Upload file"
          className="shrink-0 text-muted hover:text-fg px-1 text-xs"
        >
          ↑
        </button>
        <button
          type="button"
          onClick={refresh}
          title="Refresh"
          aria-label="Refresh"
          className="shrink-0 text-muted hover:text-fg px-1 text-xs"
        >
          ↻
        </button>
      </div>
      {error && (
        <div
          role="alert"
          className="mx-2 mt-1 px-2 py-1 rounded border border-danger/50 bg-danger/10 text-danger text-xs flex items-start gap-2"
        >
          <span className="flex-1 break-words">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            aria-label="Dismiss error"
            className="shrink-0 hover:text-fg"
          >
            ×
          </button>
        </div>
      )}
      <div role="table" aria-label="Remote files" className="flex-1 overflow-auto">
        <div
          role="row"
          className="grid grid-cols-[1fr_70px_72px] gap-2 px-2 py-1 text-xs text-muted sticky top-0 bg-surface border-b border-border"
        >
          <span>Name</span>
          <span className="text-right">Size</span>
          <span>Mode</span>
        </div>
        {entries.length === 0 && opened && (
          <div className="px-2 py-2 text-xs text-muted">Empty directory.</div>
        )}
        {!opened && tab.sftpOpen && (
          <div className="px-2 py-2 text-xs text-muted">Opening SFTP subsystem…</div>
        )}
        {entries.map((e) => (
          <SftpFileRow key={e.full_path} entry={e} onOpen={navigateInto} onContext={openContext} />
        ))}
      </div>
      <TransferStatus tracked={transfers} />
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
