'use client';
import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Folder, FolderOpen } from 'lucide-react';
import type { Folder as TFolder } from '@/lib/types';

interface Props {
  title:           string;
  folders:         TFolder[];
  /** Folder the item currently lives in. Disabled in the picker so a
   *  user can't pick the no-op destination. `null` = root. */
  currentFolderId: number | null;
  /** Folders that should not be selectable (e.g. moving a folder into
   *  itself or one of its descendants would be a cycle). */
  excludedIds?:    Set<number>;
  confirmText?:    string;
  onCancel:        () => void;
  onConfirm:       (folderId: number | null) => void | Promise<void>;
}

interface Node { folder: TFolder; children: Node[] }

function buildForest(folders: TFolder[]): Node[] {
  const byParent = new Map<number | null, TFolder[]>();
  for (const f of folders) {
    if (!byParent.has(f.parent_id)) byParent.set(f.parent_id, []);
    byParent.get(f.parent_id)!.push(f);
  }
  function build(parent: number | null): Node[] {
    return (byParent.get(parent) ?? [])
      .slice()
      .sort((a, b) => a.sort - b.sort || a.id - b.id)
      .map((f) => ({ folder: f, children: build(f.id) }));
  }
  return build(null);
}

export function MoveToFolderDialog({
  title,
  folders,
  currentFolderId,
  excludedIds,
  confirmText = 'Move',
  onCancel,
  onConfirm,
}: Props) {
  const forest = useMemo(() => buildForest(folders), [folders]);
  const [pick, setPick] = useState<number | null | undefined>(undefined);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set(folders.map((f) => f.id)));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onCancel(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  function toggle(id: number) {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function submit() {
    if (pick === undefined) { setErr('Select a destination folder.'); return; }
    setErr(null);
    setBusy(true);
    try {
      await onConfirm(pick);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function Row({ node, depth }: { node: Node; depth: number }) {
    const id = node.folder.id;
    const isOpen = expanded.has(id);
    const FolderIcon = isOpen ? FolderOpen : Folder;
    const disabled = currentFolderId === id || excludedIds?.has(id);
    const selected = pick === id;
    return (
      <div>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setPick(id)}
          className={`group w-full h-7 flex items-center gap-1.5 px-1.5 text-left text-xs transition-colors ${
            selected
              ? 'bg-accent/20 text-fg outline outline-1 outline-accent/60'
              : disabled
                ? 'text-muted/60 cursor-not-allowed'
                : 'text-fg/90 hover:bg-surface2/70'
          }`}
          style={{ paddingLeft: 6 + depth * 12 }}
          title={disabled ? 'Already here' : node.folder.name}
        >
          {node.children.length > 0 ? (
            <span
              role="button"
              aria-label={isOpen ? 'Collapse' : 'Expand'}
              tabIndex={-1}
              onClick={(e) => { e.stopPropagation(); toggle(id); }}
              className="w-3 h-3 flex items-center justify-center text-muted/80 shrink-0"
            >
              {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            </span>
          ) : (
            <span className="w-3 h-3 shrink-0" />
          )}
          <FolderIcon size={14} className={`shrink-0 ${isOpen ? 'text-accent' : 'text-accent/70'}`} />
          <span className="truncate flex-1">{node.folder.name}</span>
        </button>
        {isOpen && node.children.map((c) => (
          <Row key={c.folder.id} node={c} depth={depth + 1} />
        ))}
      </div>
    );
  }

  const rootDisabled = currentFolderId === null;
  const rootSelected = pick === null;

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4 overlay-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="move-title"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="w-[440px] max-w-full bg-surface border border-border rounded-md shadow-dialog dialog-in">
        <div className="p-4">
          <h2 id="move-title" className="font-semibold text-sm">{title}</h2>
          <div className="mt-3 max-h-[320px] overflow-y-auto rounded-sm border border-border bg-surface2/30 py-1">
            <button
              type="button"
              disabled={rootDisabled}
              onClick={() => setPick(null)}
              className={`w-full h-7 flex items-center gap-1.5 px-1.5 text-left text-xs transition-colors ${
                rootSelected
                  ? 'bg-accent/20 text-fg outline outline-1 outline-accent/60'
                  : rootDisabled
                    ? 'text-muted/60 cursor-not-allowed'
                    : 'text-fg/90 hover:bg-surface2/70'
              }`}
              style={{ paddingLeft: 6 }}
              title={rootDisabled ? 'Already here' : '(Root)'}
            >
              <span className="w-3 h-3 shrink-0" />
              <Folder size={14} className="shrink-0 text-muted" />
              <span className="truncate flex-1 italic">(Root)</span>
            </button>
            {forest.map((n) => (<Row key={n.folder.id} node={n} depth={0} />))}
          </div>
          {err && <div className="text-danger text-xs mt-2">{err}</div>}
        </div>
        <div className="px-4 py-3 border-t border-border bg-surface2/30 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 border border-border rounded text-sm hover:bg-surface2 focus-ring"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || pick === undefined}
            className="px-3 py-1.5 bg-accent text-white rounded text-sm font-medium hover:brightness-110 disabled:opacity-50 focus-ring"
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
