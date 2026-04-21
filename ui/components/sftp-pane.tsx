'use client';
import { useCallback, useEffect, useState } from 'react';
import { FolderPlus, Inbox, Loader2, RefreshCw, Upload, UploadCloud } from 'lucide-react';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { api, errMessage } from '@/lib/tauri';
import type { SftpEntry } from '@/lib/types';
import { useTabs, type Tab } from '@/lib/tabs-store';
import { toast } from '@/lib/toast';
import { ContextMenu, type MenuItem } from './context-menu';
import { SftpBreadcrumb } from './sftp-breadcrumb';
import { SftpFileRow } from './sftp-file-row';
import { TransferStatus, type TrackedTransfer } from './transfer-status';
import { ConfirmDialog } from './confirm-dialog';
import { PromptDialog } from './prompt-dialog';
import { EmptyState } from './empty-state';

/// Join a parent dir and a filename while keeping root (`/`) tidy.
function joinRemote(dir: string, name: string): string {
  if (dir === '/' || dir === '') return `/${name}`;
  return `${dir.replace(/\/+$/, '')}/${name}`;
}

type PendingPrompt =
  | { kind: 'mkdir' }
  | { kind: 'rename'; entry: SftpEntry };

type PendingConfirm =
  | { kind: 'delete'; entry: SftpEntry };

export function SftpPane({ tab }: { tab: Tab }) {
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<TrackedTransfer[]>([]);
  const [opened, setOpened] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [prompt, setPrompt] = useState<PendingPrompt | null>(null);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
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
            toast.danger('Download failed', errMessage(er));
          }
        },
      });
    }
    items.push({ label: 'Rename…', onClick: () => setPrompt({ kind: 'rename', entry: e }) });
    items.push({ label: 'Delete', danger: true, onClick: () => setConfirm({ kind: 'delete', entry: e }) });
    setMenu({ x, y, items });
  }

  /// Drag-drop upload. Chromium webviews don't expose a source file path
  /// on HTML5 drops (security), so we read each File's bytes via
  /// FileReader and ship them to `sftp_upload_bytes`, which streams the
  /// buffer into the remote SFTP session. This works regardless of the
  /// host OS — path separators, drive letters, and POSIX roots are all
  /// handled by the backend's `normalise_remote_path` on the target side.
  async function handleDrop(ev: React.DragEvent) {
    ev.preventDefault();
    setDragOver(false);
    const cid = tab.connectionId;
    if (cid == null) return;
    const files = Array.from(ev.dataTransfer?.files ?? []) as File[];
    if (files.length === 0) return;
    for (const f of files) {
      try {
        if (f.size > 256 * 1024 * 1024) {
          toast.danger(
            'File too large',
            `${f.name} is ${(f.size / (1024 * 1024)).toFixed(1)} MB — drag-drop cap is 256 MB. Use the Upload button.`,
          );
          continue;
        }
        // `File.name` is just the base name in every browser — perfect
        // for joining with the remote cwd; no need to strip separators.
        const remote = joinRemote(tab.cwd, f.name || 'upload');
        const bytes = Array.from(new Uint8Array(await f.arrayBuffer()));
        const t = await api.sftpUploadBytes(cid, remote, bytes);
        setTransfers((prev) => [...prev, { transferId: t.transfer_id, label: `upload ${f.name}` }]);
      } catch (er) {
        toast.danger(`Upload failed: ${f.name}`, errMessage(er));
      }
    }
    setTimeout(refresh, 500);
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
      toast.danger('Upload failed', errMessage(er));
    }
  }

  return (
    <div
      className="h-full w-72 border-r border-border bg-surface flex flex-col min-h-0 shrink-0 relative"
      onDragOver={(ev) => { ev.preventDefault(); if (!dragOver) setDragOver(true); }}
      onDragLeave={(ev) => {
        // Ignore leaves into child elements — only clear when leaving the
        // pane bounds entirely.
        const r = (ev.currentTarget as HTMLDivElement).getBoundingClientRect();
        if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) {
          setDragOver(false);
        }
      }}
      onDrop={handleDrop}
    >
      <div className="h-8 px-1.5 border-b border-border flex items-center gap-1 shrink-0">
        <div className="flex-1 min-w-0">
          <SftpBreadcrumb path={tab.cwd} onNavigate={(p) => setCwd(tab.tabId, p)} />
        </div>
        <button
          type="button"
          onClick={() => setPrompt({ kind: 'mkdir' })}
          title="New directory"
          aria-label="New directory"
          className="icon-btn"
        >
          <FolderPlus size={13} />
        </button>
        <button
          type="button"
          onClick={handleUploadClick}
          title="Upload file"
          aria-label="Upload file"
          className="icon-btn"
        >
          <Upload size={13} />
        </button>
        <button
          type="button"
          onClick={refresh}
          title="Refresh"
          aria-label="Refresh"
          className="icon-btn"
        >
          <RefreshCw size={13} />
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
          className="grid grid-cols-[1fr_70px_72px] gap-2 px-2 py-1 text-[11px] text-muted sticky top-0 bg-surface border-b border-border uppercase tracking-wider font-medium"
        >
          <span>Name</span>
          <span className="text-right">Size</span>
          <span>Mode</span>
        </div>
        {!opened && tab.sftpOpen && (
          <div className="h-full flex items-center justify-center text-muted text-xs gap-2">
            <Loader2 size={14} className="animate-spin" />
            <span>Opening SFTP…</span>
          </div>
        )}
        {opened && entries.length === 0 && (
          <EmptyState icon={Inbox} title="Empty directory" compact />
        )}
        {entries.map((e) => (
          <SftpFileRow key={e.full_path} entry={e} onOpen={navigateInto} onContext={openContext} />
        ))}
      </div>
      <TransferStatus tracked={transfers} />

      {dragOver && (
        <div className="absolute inset-0 pointer-events-none border-2 border-dashed border-accent bg-accent/10 flex flex-col items-center justify-center overlay-in">
          <UploadCloud size={32} className="text-accent mb-2" strokeWidth={1.5} />
          <div className="text-sm font-medium text-fg">Drop to upload</div>
          <div className="text-xs text-muted mt-0.5 font-mono">{tab.cwd}</div>
        </div>
      )}

      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}

      {prompt?.kind === 'mkdir' && (
        <PromptDialog
          title="New directory"
          label="Directory name"
          confirmText="Create"
          onCancel={() => setPrompt(null)}
          onConfirm={async (name) => {
            const cid = tab.connectionId;
            if (cid == null) { setPrompt(null); return; }
            await api.sftpMkdir(cid, joinRemote(tab.cwd, name));
            setPrompt(null);
            refresh();
            toast.success('Directory created', name);
          }}
        />
      )}

      {prompt?.kind === 'rename' && (
        <PromptDialog
          title={`Rename "${prompt.entry.name}"`}
          label="New name"
          initialValue={prompt.entry.name}
          confirmText="Rename"
          onCancel={() => setPrompt(null)}
          onConfirm={async (name) => {
            const cid = tab.connectionId;
            if (cid == null) { setPrompt(null); return; }
            const parent = prompt.entry.full_path.replace(/\/[^/]+$/, '') || '/';
            const to = joinRemote(parent, name);
            await api.sftpRename(cid, prompt.entry.full_path, to);
            setPrompt(null);
            refresh();
            toast.success('Renamed', `${prompt.entry.name} → ${name}`);
          }}
        />
      )}

      {confirm?.kind === 'delete' && (
        <ConfirmDialog
          kind="danger"
          title={`Delete "${confirm.entry.name}"?`}
          body={confirm.entry.is_dir
            ? 'The directory must be empty on the remote server.'
            : 'This cannot be undone.'}
          confirmText="Delete"
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            const cid = tab.connectionId;
            if (cid == null) { setConfirm(null); return; }
            try {
              if (confirm.entry.is_dir) await api.sftpRmdir(cid, confirm.entry.full_path);
              else                      await api.sftpRemove(cid, confirm.entry.full_path);
              refresh();
              toast.success('Deleted', confirm.entry.name);
            } catch (e) {
              toast.danger('Delete failed', errMessage(e));
            }
            setConfirm(null);
          }}
        />
      )}
    </div>
  );
}
