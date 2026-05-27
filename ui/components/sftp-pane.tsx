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

/** Hard upper bound on per-file streaming upload. SFTP itself has no
 *  meaningful limit; this is purely a "you probably meant to use a
 *  different tool" guardrail against runaway drops. Tune freely. */
const UPLOAD_CAP_BYTES = 16 * 1024 * 1024 * 1024; // 16 GB

/** Chunk size for streaming uploads. 1 MB amortises Tauri IPC cost
 *  without blowing webview memory (we hold at most CHANNEL_DEPTH ≈ 4
 *  chunks per upload from the backend's bounded mpsc, plus whatever
 *  the JS side is staging — keep this modest). */
const UPLOAD_CHUNK_BYTES = 1 * 1024 * 1024;

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

/** Per-file progress for streaming uploads (phase A3). The frontend
 *  drives the progress here directly — the backend doesn't emit
 *  `sftp:transfer:{id}` events for the streaming path; chunks ack on
 *  success and each ack advances `sent`. Distinguished from the
 *  legacy `TrackedTransfer` model that wraps Rust-emitted progress. */
interface StreamingUpload {
  uploadId: number;
  name: string;
  sent: number;
  total: number;
  done: boolean;
  error: string | null;
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
  const [streamingUploads, setStreamingUploads] = useState<StreamingUpload[]>([]);
  // Selection state for multi-file drag-out. Set of `full_path`
  // values that are currently selected. `anchor` is the last
  // plain-clicked row, used as the start of a shift+click range.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
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

  // Clear multi-selection when the cwd changes — selected paths
  // belong to a different directory and shouldn't survive navigation.
  // cwd lives in a zustand store mutated from many places
  // (breadcrumb clicks, double-click on a folder, restore from
  // tab-store), so doing this in an effect is cleaner than clearing
  // at every cwd-mutation site.
  useEffect(() => {
    setSelected(new Set());
    setAnchor(null);
  }, [tab.cwd]);

  function navigateInto(e: SftpEntry) {
    if (e.is_dir) setCwd(tab.tabId, e.full_path);
  }

  function openContext(e: SftpEntry, x: number, y: number) {
    const cid = tab.connectionId;
    if (cid == null) return;
    const items: MenuItem[] = [];
    // If the right-clicked file is part of an active multi-selection,
    // Download applies to every selected non-directory entry and prompts
    // once for a destination folder. Otherwise it falls back to the
    // single-file save-as flow on the right-clicked entry.
    const multiTargets =
      !e.is_dir && selected.has(e.full_path) && selected.size > 1
        ? entries.filter((ent) => selected.has(ent.full_path) && !ent.is_dir)
        : null;
    if (multiTargets && multiTargets.length > 1) {
      items.push({
        label: `Download ${multiTargets.length} files…`,
        onClick: async () => {
          try {
            const destDir = await openDialog({
              directory: true,
              multiple: false,
              title: 'Download to folder',
            });
            if (typeof destDir !== 'string') return;
            // Honour the OS path separator implied by the picked
            // folder. Tauri's open-dialog returns native paths, so a
            // Windows pick contains `\` and a POSIX pick contains `/`.
            const sep = destDir.includes('\\') && !destDir.includes('/') ? '\\' : '/';
            const base = destDir.replace(/[\\/]+$/, '');
            const newTransfers: TrackedTransfer[] = [];
            for (const ent of multiTargets) {
              try {
                const localPath = `${base}${sep}${ent.name}`;
                const t = await api.sftpDownload(cid, ent.full_path, localPath);
                newTransfers.push({ transferId: t.transfer_id, label: `download ${ent.name}` });
              } catch (er) {
                toast.danger(`Download failed: ${ent.name}`, errMessage(er));
              }
            }
            if (newTransfers.length) setTransfers((prev) => [...prev, ...newTransfers]);
          } catch (er) {
            toast.danger('Download failed', errMessage(er));
          }
        },
      });
    } else if (!e.is_dir) {
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

  /// Single-file upload over SFTP. Streams the File in 1 MB chunks
  /// via begin/chunk/finish so we don't have to fit the whole thing
  /// in webview memory (the old `sftp_upload_bytes` path effectively
  /// capped at 256 MB for that reason). Errors surface per-chunk
  /// because each chunk acks individually — disk-full or permission
  /// failures stop the upload immediately rather than after the last
  /// byte is shipped.
  async function uploadOneFile(cid: number, f: File, remotePath: string): Promise<boolean> {
    if (f.size > UPLOAD_CAP_BYTES) {
      const cap_gb = (UPLOAD_CAP_BYTES / (1024 ** 3)).toFixed(0);
      toast.danger(
        'File too large',
        `${f.name} is ${(f.size / (1024 ** 3)).toFixed(1)} GB — drag-drop cap is ${cap_gb} GB.`,
      );
      return false;
    }

    let uploadId: number | null = null;
    try {
      uploadId = await api.sftpUploadBegin(cid, remotePath);
      const id = uploadId;
      setStreamingUploads((prev) => [
        ...prev,
        { uploadId: id, name: f.name, sent: 0, total: f.size, done: false, error: null },
      ]);
      for (let off = 0; off < f.size; off += UPLOAD_CHUNK_BYTES) {
        const end = Math.min(off + UPLOAD_CHUNK_BYTES, f.size);
        const buf = new Uint8Array(await f.slice(off, end).arrayBuffer());
        // Array.from on a Uint8Array is the path Tauri's JSON-IPC
        // expects for `Vec<u8>` — slow but the alternative (binary
        // IPC) isn't wired in our build yet.
        await api.sftpUploadChunk(id, Array.from(buf));
        setStreamingUploads((prev) =>
          prev.map((u) => (u.uploadId === id ? { ...u, sent: end } : u)),
        );
      }
      await api.sftpUploadFinish(id);
      setStreamingUploads((prev) =>
        prev.map((u) => (u.uploadId === id ? { ...u, done: true } : u)),
      );
      // Self-clear the entry after a moment so finished uploads
      // don't accumulate forever in the strip.
      setTimeout(() => {
        setStreamingUploads((prev) => prev.filter((u) => u.uploadId !== id));
      }, 1500);
      return true;
    } catch (er) {
      const msg = errMessage(er);
      toast.danger(`Upload failed: ${f.name}`, msg);
      if (uploadId != null) {
        const id = uploadId;
        setStreamingUploads((prev) =>
          prev.map((u) => (u.uploadId === id ? { ...u, done: true, error: msg } : u)),
        );
        try { await api.sftpUploadAbort(id); } catch { /* best effort */ }
        setTimeout(() => {
          setStreamingUploads((prev) => prev.filter((u) => u.uploadId !== id));
        }, 4000);
      }
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

    // SYNCHRONOUS snapshot — DataTransferItem references are invalidated
    // as soon as the drop handler yields (HTML5 spec; Chromium enforces).
    // Anything we need from `dt.items` / `dt.files` must be captured
    // before the first `await`, or subsequent entries come back null.
    type Work = { kind: 'file'; file: File; remote: string }
              | { kind: 'dir';  entry: FileSystemDirectoryEntry; remote: string; rootName: string };
    const fileWork: Extract<Work, { kind: 'file' }>[] = [];
    const dirWork:  Extract<Work, { kind: 'dir'  }>[] = [];

    const items = Array.from(dt.items ?? []);
    if (items.length > 0) {
      for (const it of items) {
        if (it.kind !== 'file') continue;
        const e = entryFromItem(it);
        if (e?.isDirectory) {
          dirWork.push({
            kind: 'dir',
            entry: e as FileSystemDirectoryEntry,
            remote: joinRemote(targetDir, e.name),
            rootName: e.name,
          });
        } else {
          // Use getAsFile() (sync) instead of FileSystemFileEntry.file
          // (async) so we don't yield the event loop mid-iteration.
          const f = it.getAsFile();
          if (f) fileWork.push({
            kind: 'file', file: f, remote: joinRemote(targetDir, f.name || 'upload'),
          });
        }
      }
    } else {
      for (const f of Array.from(dt.files ?? [])) {
        fileWork.push({
          kind: 'file', file: f, remote: joinRemote(targetDir, f.name || 'upload'),
        });
      }
    }

    if (fileWork.length === 0 && dirWork.length === 0) return;

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

  /// Row mousedown handler. Updates selection per the standard
  /// file-manager idiom: plain click replaces, Ctrl/Cmd toggles,
  /// Shift extends a range from the last plain-clicked row.
  function handleRowMouseDown(entry: SftpEntry, ev: React.MouseEvent) {
    if (ev.button !== 0) return;
    const path = entry.full_path;
    if (ev.ctrlKey || ev.metaKey) {
      setSelected((cur) => {
        const next = new Set(cur);
        if (next.has(path)) next.delete(path); else next.add(path);
        return next;
      });
      setAnchor(path);
      return;
    }
    if (ev.shiftKey && anchor) {
      const ai = entries.findIndex((e) => e.full_path === anchor);
      const bi = entries.findIndex((e) => e.full_path === path);
      if (ai >= 0 && bi >= 0) {
        const [lo, hi] = ai <= bi ? [ai, bi] : [bi, ai];
        setSelected(new Set(entries.slice(lo, hi + 1).map((e) => e.full_path)));
      }
      return;
    }
    // Plain click. If the row is already part of a multi-selection,
    // leave selection intact so a subsequent drag carries everything.
    // Otherwise reset to just this row.
    if (!selected.has(path)) {
      setSelected(new Set([path]));
    }
    setAnchor(path);
  }

  // SFTP drag-OUT (dragging a remote file from the pane into Windows
  // Explorer) is not supported. We tried both OS-level OLE drag
  // (`DoDragDrop`) and HTML5 `dragstart` with `setData('DownloadURL')`
  // — WebView2 blocks both. Once WebView2 is loaded into the process,
  // Chromium's drag controller refuses to let the host start an OS
  // drag, and the HTML5 dragstart → OS drag conversion never fires.
  // There is no current Microsoft-supplied API to initiate an OS-level
  // virtual-file drag from a WebView2 host. Right-click → Download…
  // (above) is the supported path.

  async function handleUploadClick() {
    const cid = tab.connectionId;
    if (cid == null) return;
    try {
      const picked = await openDialog({ multiple: true });
      // Tauri returns string | string[] | null depending on `multiple`.
      // Normalise to an array so the loop below handles both shapes.
      const paths = Array.isArray(picked) ? picked : typeof picked === 'string' ? [picked] : [];
      if (paths.length === 0) return;
      const newTransfers: TrackedTransfer[] = [];
      for (const p of paths) {
        const name = p.split(/[\\/]/).pop() ?? 'upload';
        const remote = joinRemote(tab.cwd, name);
        try {
          const t = await api.sftpUpload(cid, p, remote);
          newTransfers.push({ transferId: t.transfer_id, label: `upload ${name}` });
        } catch (er) {
          toast.danger(`Upload failed: ${name}`, errMessage(er));
        }
      }
      if (newTransfers.length) setTransfers((prev) => [...prev, ...newTransfers]);
      setTimeout(refresh, 500);
    } catch (er) {
      toast.danger('Upload failed', errMessage(er));
    }
  }

  return (
    <div
      className="h-full w-72 border-r border-border bg-surface flex flex-col min-h-0 shrink-0 relative"
      onDragOver={(ev) => {
        ev.preventDefault();
        // WebView2 needs the explicit copy effect to actually fire `drop`
        // for external file drags — `preventDefault` alone covers same-page
        // HTML5 drags but not OS-sourced ones.
        ev.dataTransfer.dropEffect = 'copy';
        if (!dragOver) setDragOver(true);
      }}
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
          title="Upload files"
          aria-label="Upload files"
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
            selected={selected.has(e.full_path)}
            onOpen={navigateInto}
            onContext={openContext}
            onFolderDrop={handleFolderDrop}
            onSelectMouseDown={handleRowMouseDown}
          />
        ))}
      </div>
      <DirectoryJobs jobs={dirJobs} onClear={(id) =>
        setDirJobs((js) => js.filter((j) => j.id !== id))
      } />
      <StreamingUploadStatus uploads={streamingUploads} />
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

/** Per-file streaming upload progress (phase A3). Frontend-driven —
 *  each chunk ack advances `sent`. Auto-clears finished entries via
 *  a setTimeout in the parent, but renders nothing if the list is
 *  empty, so the strip collapses when idle. */
function StreamingUploadStatus({ uploads }: { uploads: StreamingUpload[] }) {
  if (uploads.length === 0) return null;
  return (
    <div className="border-t border-border bg-surface2/40 text-xs p-2 space-y-1.5">
      {uploads.map((u) => {
        const pct = u.total > 0 ? Math.floor((u.sent / u.total) * 100) : 0;
        return (
          <div key={u.uploadId} className="space-y-0.5">
            <div className="flex items-center gap-2">
              <span className="flex-1 truncate text-fg/90">
                {u.error ? '✗ ' : u.done ? '✓ ' : ''}upload {u.name}
              </span>
              <span className={`tabular-nums ${u.error ? 'text-danger' : 'text-muted'}`}>
                {u.error ? 'failed' : u.done ? 'done' : `${pct}%`}
              </span>
            </div>
            {!u.done && (
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
