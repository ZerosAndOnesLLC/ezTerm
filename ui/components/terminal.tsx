'use client';
import { useEffect, useRef, useState } from 'react';
import { api, errMessage } from '@/lib/tauri';
import { createTerminal, type TerminalBundle } from '@/lib/xterm';
import { subscribeSshEvents } from '@/lib/ssh';
import { useTabs, type Tab } from '@/lib/tabs-store';
import { TerminalContextMenu } from './terminal-context-menu';
import { FindOverlay } from './find-overlay';

interface Props { tab: Tab; visible: boolean; }

export function TerminalView({ tab, visible }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bundleRef    = useRef<TerminalBundle | null>(null);
  const unlistenRef  = useRef<null | (() => void)>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [find, setFind] = useState(false);
  const setStatus = useTabs((s) => s.setStatus);
  const setConn   = useTabs((s) => s.setConnection);

  // Mount xterm and start connection
  useEffect(() => {
    if (!containerRef.current) return;
    const bundle = createTerminal();
    bundleRef.current = bundle;
    bundle.terminal.open(containerRef.current);
    bundle.fit.fit();

    let cancelled = false;
    let connectionId: number | null = null;

    (async () => {
      try {
        const cols = bundle.terminal.cols;
        const rows = bundle.terminal.rows;
        // First attempt — trustAny = false. If host is untrusted/mismatched we prompt.
        let result;
        try {
          result = await api.sshConnect(tab.session.id, cols, rows, false);
        } catch (e) {
          const code = (e as { code?: string })?.code;
          if (code === 'host_key_untrusted' || code === 'host_key_mismatch') {
            // Ask the user. host-key-dialog will handle the confirmation UI;
            // here we just fail the first attempt and let the caller decide.
            setStatus(tab.tabId, 'error', errMessage(e));
            return;
          }
          throw e;
        }
        if (cancelled) {
          await api.sshDisconnect(result.connection_id);
          return;
        }
        connectionId = result.connection_id;
        setConn(tab.tabId, result.connection_id);
        setStatus(tab.tabId, 'connected');

        unlistenRef.current = await subscribeSshEvents(result.connection_id, {
          onData: (bytes) => bundle.terminal.write(bytes),
          onClose: () => setStatus(tab.tabId, 'closed'),
          onError: (msg) => setStatus(tab.tabId, 'error', msg),
        });

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
      } catch (e) {
        setStatus(tab.tabId, 'error', errMessage(e));
      }
    })();

    return () => {
      cancelled = true;
      unlistenRef.current?.();
      bundle.dispose();
      if (connectionId !== null) api.sshDisconnect(connectionId).catch(() => {});
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
    </div>
  );
}
