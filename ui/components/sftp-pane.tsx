'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
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

const UPLOAD_CAP_BYTES = 256 * 1024 * 1024;

/** Tracks an in-progress directory upload (one job per dropped tree).
 *  Files inside the tree still surface as individual transfers via the
 *  existing TransferStatus strip; this job tracks the parent walk so
 *  the user sees "uploading directory X (12/87 files)" while we mkdir
 *  and enqueue each leaf. */
interface DirJob {
  id: number;
  rootName: string;
  total: number;
  done: number;
  failed: number;
  finished: boolean;
}

/** Pluck the FileSystemEntry off a DataTransferItem — supports both
 *  the modern `getAsEntry()` (TC39 file-system access) and the legacy
 *  `webkitGetAsEntry()` that Chromium-based webviews still expose. */
function entryFromItem(item: DataTransferItem): FileSystemEntry | null {
  // Modern API isn't typed in stock lib.dom yet; fall back to the
  // ubiquitous Chromium one.
  type WithEntry = DataTransferItem & {
    getAsEntry?: () => FileSystemEntry | null;
    webkitGetAsEntry?: () => FileSystemEntry | null;
  };
  const i = item as WithEntry;
  return i.webkitGetAsEntry?.() ?? i.getAsEntry?.() ?? null;
}

async function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  // readEntries returns at most ~100 entries per call; loop until it
  // returns empty.
  const out: FileSystemEntry[] = [];
  for (;;) {
    const batch: FileSystemEntry[] = await new Promise((resolve, reject) =>
      reader.readEntries((entries) => resolve(entries as FileSystemEntry[]), reject),
    );
    if (batch.length === 0) return out;
    out.push(...batch);
  }
}

function getFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

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

export function SftpPane({ tab, isVisible = true }: { tab: Tab; isVisible?: boolean }) {
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<TrackedTransfer[]>([]);
  const [opened, setOpened] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [prompt, setPrompt] = useState<PendingPrompt | null>(null);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [dirJobs, setDirJobs] = useState<DirJob[]>([]);
  const nextDirJobId = useRef(1);
  const setCwd = useTabs((s) => s.setCwd);

  const refresh = useCallback(async () => {
    if (tab.connectionId == null || !opened) return;
    // Skip the listing IPC when the pane is hidden (display:none in
    // non-tabs view modes). The pane stays mounted so its local state
    // survives mode flips, but the user can't see results — and we
    // shouldn't be hitting the remote with sftpList while invisible.
    if (!isVisible) return;
    try {
      setError(null);
      const list = await api.sftpList(tab.connectionId, tab.cwd);
      setEntries(list);
    } catch (e) {
      setError(errMessage(e));
    }
  }, [tab.connectionId, tab.cwd, opened, isVisible]);

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

  /// Single-file upload over SFTP. Chromium webviews don't expose a
  /// source file path on HTML5 drops (security), so we read each File's
  /// bytes via FileReader and ship them to `sftp_upload_bytes`, which
  /// streams the buffer into the remote SFTP session.
  async function uploadOneFile(cid: number, f: File, remotePath: string): Promise<boolean> {
    if (f.size > UPLOAD_CAP_BYTES) {
      toast.danger(
        'File too large',
        `${f.name} is ${(f.size / (1024 * 1024)).toFixed(1)} MB — drag-drop cap is 256 MB. Use the Upload button.`,
      );
      return false;
    }
    try {
      const bytes = Array.from(new Uint8Array(await f.arrayBuffer()));
      const t = await api.sftpUploadBytes(cid, remotePath, bytes);
      setTransfers((prev) => [...prev, { transferId: t.transfer_id, label: `upload ${f.name}` }]);
      return true;
    } catch (er) {
      toast.danger(`Upload failed: ${f.name}`, errMessage(er));
      return false;
    }
  }

  /// Idempotent mkdir: best-effort, swallows "exists" errors so a
  /// directory tree can be re-uploaded over itself. We don't list
  /// first because that's a round-trip; trying to create and tolerating
  /// the failure is one IPC.
  async function ensureRemoteDir(cid: number, path: string): Promise<void> {
    try { await api.sftpMkdir(cid, path); } catch { /* assume already exists */ }
  }

  /// Walk a dropped FileSystemDirectoryEntry, mkdir its descendants on
  /// the remote and upload each leaf file. Updates the supplied DirJob
  /// as we go so the in-pane progress strip shows total / done counts.
  async function uploadDirectoryEntry(
    cid: number,
    dirEntry: FileSystemDirectoryEntry,
    remoteRoot: string,
    jobId: number,
  ): Promise<void> {
    const reader = dirEntry.createReader();
    const children = await readAllEntries(reader);
    for (const child of children) {
      const childRemote = joinRemote(remoteRoot, child.name);
      if (child.isDirectory) {
        await ensureRemoteDir(cid, childRemote);
        setDirJobs((js) =>
          js.map((j) => (j.id === jobId ? { ...j, total: j.total + 1, done: j.done + 1 } : j)),
        );
        await uploadDirectoryEntry(cid, child as FileSystemDirectoryEntry, childRemote, jobId);
      } else {
        const f = await getFile(child as FileSystemFileEntry).catch(() => null);
        setDirJobs((js) =>
          js.map((j) => (j.id === jobId ? { ...j, total: j.total + 1 } : j)),
        );
        const ok = f ? await uploadOneFile(cid, f, childRemote) : false;
        setDirJobs((js) =>
          js.map((j) => (j.id === jobId
            ? { ...j, done: j.done + (ok ? 1 : 0), failed: j.failed + (ok ? 0 : 1) }
            : j),
          ),
        );
      }
    }
  }

  /// Shared drop handler used by both the pane-wide drop zone and the
  /// per-folder drop targets. Mixes single files (legacy
  /// dataTransfer.files path) with full directory walks via
  /// webkitGetAsEntry. We don't `await` the file/directory uploads in
  /// sequence here — Promise.all lets the parallel uploads race, which
  /// is fine because each `sftpUploadBytes` opens its own write handle.
  async function uploadDataTransfer(targetDir: string, dt: DataTransfer | null) {
    const cid = tab.connectionId;
    if (cid == null || !dt) return;

    // Prefer the items API so we can detect directories. Fall back to
    // the `files` collection on browsers that don't expose entries
    // (none of our supported webviews, but cheap defensive code).
    const items = Array.from(dt.items ?? []);
    type Work = { kind: 'file'; file: File; remote: string }
              | { kind: 'dir';  entry: FileSystemDirectoryEntry; remote: string; rootName: string };
    const work: Work[] = [];

    if (items.length > 0) {
      for (const it of items) {
        if (it.kind !== 'file') continue;
        const e = entryFromItem(it);
        if (e?.isDirectory) {
          work.push({
            kind: 'dir',
            entry: e as FileSystemDirectoryEntry,
            remote: joinRemote(targetDir, e.name),
            rootName: e.name,
          });
        } else if (e?.isFile) {
          // FileSystemFileEntry.file is async; capture the File now.
          const f = await getFile(e as FileSystemFileEntry).catch(() => null);
          if (f) work.push({ kind: 'file', file: f, remote: joinRemote(targetDir, f.name || 'upload') });
        } else {
          // Some weird-shaped DataTransferItem (text, image-data, ...). Skip.
          const f = it.getAsFile();
          if (f) work.push({ kind: 'file', file: f, remote: joinRemote(targetDir, f.name || 'upload') });
        }
      }
    } else {
      for (const f of Array.from(dt.files ?? [])) {
        work.push({ kind: 'file', file: f, remote: joinRemote(targetDir, f.name || 'upload') });
      }
    }

    if (work.length === 0) return;

    const dirWork = work.filter((w): w is Extract<Work, { kind: 'dir' }> => w.kind === 'dir');
    const fileWork = work.filter((w): w is Extract<Work, { kind: 'file' }> => w.kind === 'file');

    for (const f of fileWork) {
      void uploadOneFile(cid, f.file, f.remote);
    }

    for (const d of dirWork) {
      const jobId = nextDirJobId.current++;
      setDirJobs((js) => [...js, {
        id: jobId, rootName: d.rootName, total: 1, done: 0, failed: 0, finished: false,
      }]);
      await ensureRemoteDir(cid, d.remote);
      setDirJobs((js) => js.map((j) => (j.id === jobId ? { ...j, done: 1 } : j)));
      try {
        await uploadDirectoryEntry(cid, d.entry, d.remote, jobId);
      } catch (er) {
        toast.danger(`Directory upload failed: ${d.rootName}`, errMessage(er));
      }
      setDirJobs((js) => js.map((j) => (j.id === jobId ? { ...j, finished: true } : j)));
    }

    setTimeout(refresh, 500);
  }

  function handleDrop(ev: React.DragEvent) {
    ev.preventDefault();
    setDragOver(false);
    void uploadDataTransfer(tab.cwd, ev.dataTransfer);
  }

  function handleFolderDrop(folder: SftpEntry, ev: React.DragEvent) {
    // Per-folder drop: upload INTO the folder, not next to it.
    void uploadDataTransfer(folder.full_path, ev.dataTransfer);
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
          <SftpFileRow
            key={e.full_path}
            entry={e}
            onOpen={navigateInto}
            onContext={openContext}
            onFolderDrop={handleFolderDrop}
          />
        ))}
      </div>
      <DirectoryJobs jobs={dirJobs} onClear={(id) =>
        setDirJobs((js) => js.filter((j) => j.id !== id))
      } />
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

/** Per-tree upload progress, distinct from the per-file TransferStatus
 *  strip beneath it. Shows "uploading dir/ N of M" while we walk a
 *  dropped folder. Finished jobs stick around as a one-line summary
 *  until the user clicks ×; that's intentional so a user can see at a
 *  glance whether anything failed. */
function DirectoryJobs({
  jobs, onClear,
}: { jobs: DirJob[]; onClear: (id: number) => void }) {
  if (jobs.length === 0) return null;
  return (
    <div className="border-t border-border bg-surface2/40 text-xs p-2 space-y-1.5">
      {jobs.map((j) => {
        const pct = j.total > 0 ? Math.floor((j.done / j.total) * 100) : 0;
        const statusText = j.finished
          ? (j.failed > 0
              ? `done (${j.failed} failed)`
              : `done (${j.done} files)`)
          : `${j.done}/${j.total}`;
        return (
          <div key={j.id} className="space-y-0.5">
            <div className="flex items-center gap-2">
              <span className="flex-1 truncate text-fg/90">
                {j.finished ? '✓ ' : ''}upload {j.rootName}/
              </span>
              <span className={`tabular-nums ${j.failed > 0 ? 'text-danger' : 'text-muted'}`}>
                {statusText}
              </span>
              {j.finished && (
                <button
                  type="button"
                  onClick={() => onClear(j.id)}
                  aria-label="Dismiss"
                  className="text-muted hover:text-fg leading-none px-1"
                >
                  ×
                </button>
              )}
            </div>
            {!j.finished && (
              <div className="h-1 bg-surface2 rounded-sm overflow-hidden">
                <div
                  className="h-full bg-accent transition-[width] duration-fast"
                  style={{ width: `${pct}%` }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
