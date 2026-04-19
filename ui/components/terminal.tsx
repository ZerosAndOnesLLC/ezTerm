'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errMessage } from '@/lib/tauri';
import { createTerminal, type TerminalBundle } from '@/lib/xterm';
import { subscribeSshEvents } from '@/lib/ssh';
import { useTabs, type Tab } from '@/lib/tabs-store';
import { TerminalContextMenu } from './terminal-context-menu';
import { FindOverlay } from './find-overlay';
import { HostKeyDialog } from './host-key-dialog';

interface Props { tab: Tab; visible: boolean; }

type Prompt =
  | { kind: 'untrusted'; fingerprint: string; expectedFingerprint?: undefined }
  | { kind: 'mismatch';  fingerprint: string; expectedFingerprint?: string };

export function TerminalView({ tab, visible }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bundleRef    = useRef<TerminalBundle | null>(null);
  const unlistenRef  = useRef<null | (() => void)>(null);
  const resizeObsRef = useRef<ResizeObserver | null>(null);
  const connectionIdRef = useRef<number | null>(null);
  const cancelledRef = useRef(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [find, setFind] = useState(false);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const setStatus = useTabs((s) => s.setStatus);
  const setConn   = useTabs((s) => s.setConnection);

  const runConnect = useCallback(async (trustAny: boolean) => {
    const bundle = bundleRef.current;
    if (!bundle) return;
    try {
      const cols = bundle.terminal.cols;
      const rows = bundle.terminal.rows;
      let result;
      try {
        result = await api.sshConnect(tab.session.id, cols, rows, trustAny);
      } catch (e) {
        const code = (e as { code?: string })?.code;
        if (code === 'host_key_untrusted') {
          setPrompt({
            kind: 'untrusted',
            fingerprint: (e as { actual?: string })?.actual ?? '',
          });
          return;
        }
        if (code === 'host_key_mismatch') {
          setPrompt({
            kind: 'mismatch',
            fingerprint: (e as { actual?: string })?.actual ?? '',
            expectedFingerprint: (e as { expected?: string })?.expected,
          });
          return;
        }
        setStatus(tab.tabId, 'error', errMessage(e));
        return;
      }
      if (cancelledRef.current) {
        await api.sshDisconnect(result.connection_id);
        return;
      }
      connectionIdRef.current = result.connection_id;
      setConn(tab.tabId, result.connection_id);
      setStatus(tab.tabId, 'connected');

      const unlisten = await subscribeSshEvents(result.connection_id, {
        onData:  (bytes) => bundle.terminal.write(bytes),
        onClose: () => setStatus(tab.tabId, 'closed'),
        onError: (msg) => setStatus(tab.tabId, 'error', msg),
      });
      // Re-check the cancelled flag: subscribeSshEvents awaits Tauri IPC, and
      // the tab may have been unmounted in that window. Without this check
      // the listener would leak and keep firing after disposal.
      if (cancelledRef.current) {
        unlisten();
        await api.sshDisconnect(result.connection_id);
        return;
      }
      unlistenRef.current = unlisten;

      // Wire input: keystrokes → ssh_write
      bundle.terminal.onData((data) => {
        const bytes = new TextEncoder().encode(data);
        api.sshWrite(result.connection_id, Array.from(bytes)).catch(() => {});
      });

      // Resize handler
      const onResize = () => {
        bundle.fit.fit();
        api.sshResize(result.connection_id, bundle.terminal.cols, bundle.terminal.rows).catch(() => {});
      };
      const ro = new ResizeObserver(onResize);
      if (containerRef.current) ro.observe(containerRef.current);
      resizeObsRef.current = ro;
    } catch (e) {
      setStatus(tab.tabId, 'error', errMessage(e));
    }
  }, [tab.tabId, tab.session.id, setStatus, setConn]);

  // Mount xterm and start the first connect attempt
  useEffect(() => {
    if (!containerRef.current) return;
    const bundle = createTerminal();
    bundleRef.current = bundle;
    bundle.terminal.open(containerRef.current);
    bundle.fit.fit();
    cancelledRef.current = false;

    runConnect(false);

    return () => {
      cancelledRef.current = true;
      unlistenRef.current?.();
      unlistenRef.current = null;
      resizeObsRef.current?.disconnect();
      resizeObsRef.current = null;
      bundle.dispose();
      bundleRef.current = null;
      const cid = connectionIdRef.current;
      connectionIdRef.current = null;
      if (cid !== null) api.sshDisconnect(cid).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.tabId]);

  // Fit when becoming visible
  useEffect(() => {
    if (visible) setTimeout(() => bundleRef.current?.fit.fit(), 0);
  }, [visible]);

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    // Shift+Insert → paste
    if (e.shiftKey && e.key === 'Insert') {
      e.preventDefault();
      doPaste();
      return;
    }
    // Ctrl+Shift+C → copy (Ctrl+C reserved for SIGINT)
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      doCopy();
      return;
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'v') {
      e.preventDefault();
      doPaste();
      return;
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      setFind(true);
      return;
    }
  }

  async function doCopy() {
    const sel = bundleRef.current?.terminal.getSelection();
    if (sel) await navigator.clipboard.writeText(sel);
  }

  async function doPaste() {
    const txt = await navigator.clipboard.readText();
    if (!txt || !tab.connectionId) return;
    const bytes = new TextEncoder().encode(txt);
    await api.sshWrite(tab.connectionId, Array.from(bytes)).catch(() => {});
  }

  return (
    <div
      className="relative h-full w-full bg-bg"
      style={{ display: visible ? 'block' : 'none' }}
      onContextMenu={handleContextMenu}
      onKeyDown={handleKeyDown}
      tabIndex={0}
    >
      <div ref={containerRef} className="h-full w-full p-1" />
      {menu && (
        <TerminalContextMenu
          x={menu.x} y={menu.y}
          hasSelection={!!bundleRef.current?.terminal.hasSelection()}
          onCopy={() => { doCopy(); setMenu(null); }}
          onPaste={() => { doPaste(); setMenu(null); }}
          onSelectAll={() => { bundleRef.current?.terminal.selectAll(); setMenu(null); }}
          onClear={() => { bundleRef.current?.terminal.clear(); setMenu(null); }}
          onFind={() => { setFind(true); setMenu(null); }}
          onClose={() => setMenu(null)}
        />
      )}
      {find && bundleRef.current && (
        <FindOverlay search={bundleRef.current.search} onClose={() => setFind(false)} />
      )}
      {prompt && (
        <HostKeyDialog
          host={tab.session.host}
          port={tab.session.port}
          kind={prompt.kind}
          fingerprint={prompt.fingerprint}
          expectedFingerprint={prompt.expectedFingerprint}
          onCancel={() => { setPrompt(null); setStatus(tab.tabId, 'closed'); }}
          onTrust={() => { setPrompt(null); setStatus(tab.tabId, 'connecting'); runConnect(true); }}
        />
      )}
    </div>
  );
}
