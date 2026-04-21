'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Loader2, PlugZap } from 'lucide-react';
import { api, errMessage } from '@/lib/tauri';
import { createTerminal, type TerminalBundle } from '@/lib/xterm';
import { subscribeSshEvents } from '@/lib/ssh';
import { useTabs, type Tab } from '@/lib/tabs-store';
import { TerminalContextMenu } from './terminal-context-menu';
import { FindOverlay } from './find-overlay';
import { HostKeyDialog } from './host-key-dialog';
import { AuthFixOverlay } from './auth-fix-overlay';

/** True when the error looks like bad auth (wrong user, bad password,
 *  unreadable key, rejected key, missing credential) — anything the
 *  AuthFixOverlay can help with. Falls back to the generic "Connection
 *  failed" card otherwise. */
function isAuthError(e: unknown): boolean {
  const code = (e as { code?: string } | undefined)?.code;
  if (code === 'auth_failed') return true;
  const msg = ((e as { message?: string } | undefined)?.message ?? '').toLowerCase();
  // Rust's AppError::Validation("missing credential") — surfaced when a
  // password/key session has no credential_id attached (common right after
  // a MobaXterm import if the key file wasn't on disk).
  if (code === 'validation' && msg.includes('credential')) return true;
  return (
    msg.includes('authentication failed') ||
    msg.includes('key parse') ||
    msg.includes('could not read key') ||
    msg.includes('no authentication methods') ||
    msg.includes('no more authentication')
  );
}

interface Props { tab: Tab; visible: boolean; }

type Prompt =
  | { kind: 'untrusted'; fingerprint: string; expectedFingerprint?: undefined }
  | { kind: 'mismatch';  fingerprint: string; expectedFingerprint?: string };

// xterm.js 5.5 occasionally throws from viewport.syncScrollArea during
// teardown or zero-dimension transitions because its render service has
// already been cleared. fit() triggers those syncs, so every call site
// goes through this wrapper.
function safeFit(bundle: TerminalBundle) {
  try {
    bundle.fit.fit();
  } catch {
    // Transient: either the container was 0x0 or the bundle was disposed.
    // A subsequent ResizeObserver tick will retry when layout settles.
  }
}

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
  const [authFix, setAuthFix] = useState(false);
  // Pick the command family by session kind. Ref so event listeners set up
  // in empty-deps effects (wheel, paste) always see the latest dispatch.
  const isLocal = tab.session.session_kind === 'wsl' || tab.session.session_kind === 'local';
  const termApiRef = useRef({
    write:      isLocal ? api.localWrite      : api.sshWrite,
    resize:     isLocal ? api.localResize     : api.sshResize,
    disconnect: isLocal ? api.localDisconnect : api.sshDisconnect,
  });
  useEffect(() => {
    termApiRef.current = {
      write:      isLocal ? api.localWrite      : api.sshWrite,
      resize:     isLocal ? api.localResize     : api.sshResize,
      disconnect: isLocal ? api.localDisconnect : api.sshDisconnect,
    };
  }, [isLocal]);
  const setStatus   = useTabs((s) => s.setStatus);
  const setConn     = useTabs((s) => s.setConnection);
  const setSession  = useTabs((s) => s.setSession);
  const closeTab    = useTabs((s) => s.close);

  const runConnect = useCallback(async (trustAny: boolean) => {
    const bundle = bundleRef.current;
    if (!bundle) return;
    // Error surface is the overlay + tab-bar status dot + status bar. No
    // ANSI fallback — it used to clutter scrollback on reconnect without
    // adding information the overlay doesn't already show.
    const fail = (msg: string) => setStatus(tab.tabId, 'error', msg);
    try {
      const cols = bundle.terminal.cols;
      const rows = bundle.terminal.rows;
      const kind = tab.session.session_kind;
      const isLocal = kind === 'wsl' || kind === 'local';
      // One write/resize/disconnect triplet picked from the right command
      // family so the rest of runConnect stays kind-agnostic.
      const term = {
        write:      isLocal ? api.localWrite      : api.sshWrite,
        resize:     isLocal ? api.localResize     : api.sshResize,
        disconnect: isLocal ? api.localDisconnect : api.sshDisconnect,
      };
      let result: { connection_id: number };
      try {
        result = isLocal
          ? await api.localConnect(tab.session.id, cols, rows)
          : await api.sshConnect(tab.session.id, cols, rows, trustAny);
      } catch (e) {
        const code = (e as { code?: string })?.code;
        // Host-key prompts are SSH-specific; local kinds can't produce them.
        if (!isLocal && code === 'host_key_untrusted') {
          setPrompt({
            kind: 'untrusted',
            fingerprint: (e as { actual?: string })?.actual ?? '',
          });
          return;
        }
        if (!isLocal && code === 'host_key_mismatch') {
          setPrompt({
            kind: 'mismatch',
            fingerprint: (e as { actual?: string })?.actual ?? '',
            expectedFingerprint: (e as { expected?: string })?.expected,
          });
          return;
        }
        fail(errMessage(e));
        // Auth-class failures get the inline fix-it flow instead of the
        // generic "Connection failed" card. Keep the status=error set
        // above so the tab dot reflects the broken state until resolved.
        if (!isLocal && isAuthError(e)) setAuthFix(true);
        return;
      }
      if (cancelledRef.current) {
        await term.disconnect(result.connection_id);
        return;
      }
      connectionIdRef.current = result.connection_id;
      setConn(tab.tabId, result.connection_id);
      setStatus(tab.tabId, 'connected');

      // Local PTYs reuse the ssh:* event topics so the subscriber doesn't
      // need to branch — the backend emits ssh:data/close for both.
      const unlisten = await subscribeSshEvents(result.connection_id, {
        onData:  (bytes) => bundle.terminal.write(bytes),
        onClose: () => setStatus(tab.tabId, 'closed'),
        onError: (msg) => fail(msg),
      });
      if (cancelledRef.current) {
        unlisten();
        await term.disconnect(result.connection_id);
        return;
      }
      unlistenRef.current = unlisten;

      bundle.terminal.onData((data) => {
        const bytes = new TextEncoder().encode(data);
        term.write(result.connection_id, Array.from(bytes)).catch(() => {});
      });

      const onResize = () => {
        safeFit(bundle);
        term.resize(result.connection_id, bundle.terminal.cols, bundle.terminal.rows).catch(() => {});
      };
      const ro = new ResizeObserver(onResize);
      if (containerRef.current) ro.observe(containerRef.current);
      resizeObsRef.current = ro;
    } catch (e) {
      fail(errMessage(e));
    }
  }, [tab.tabId, tab.session.id, tab.session.session_kind, setStatus, setConn]);

  // Mount xterm and start the first connect attempt.
  //
  // React 18 Strict Mode (enabled in Next.js dev) invokes effects
  // mount→cleanup→mount synchronously. Calling `terminal.open()` + `fit()`
  // synchronously in the first mount and then disposing leaves xterm's
  // viewport with a pending rAF that later fires against the disposed
  // render service, producing `Cannot read properties of undefined
  // (reading 'dimensions')`. Deferring the open/fit to a microtask lets
  // strict-mode's cleanup finish cleanly before the real (second) mount
  // wires xterm up; the safeFit wrapper catches any straggler throws.
  useEffect(() => {
    if (!containerRef.current) return;
    const bundle = createTerminal({
      fontSize: tab.session.font_size,
      scrollback: tab.session.scrollback_lines,
      cursorStyle: tab.session.cursor_style,
    });
    bundleRef.current = bundle;
    cancelledRef.current = false;

    let opened = false;
    const openTimer = window.setTimeout(() => {
      if (cancelledRef.current || !containerRef.current) return;
      bundle.terminal.open(containerRef.current);
      safeFit(bundle);
      opened = true;
      runConnect(false);
    }, 0);

    return () => {
      cancelledRef.current = true;
      window.clearTimeout(openTimer);
      unlistenRef.current?.();
      unlistenRef.current = null;
      resizeObsRef.current?.disconnect();
      resizeObsRef.current = null;
      // Only dispose if we actually reached open(); disposing a never-opened
      // terminal is harmless but this avoids spurious console warnings.
      if (opened) {
        try { bundle.dispose(); } catch { /* xterm race on unmount */ }
      }
      bundleRef.current = null;
      const cid = connectionIdRef.current;
      connectionIdRef.current = null;
      if (cid !== null) termApiRef.current.disconnect(cid).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.tabId]);

  // Fit when becoming visible
  useEffect(() => {
    if (visible) setTimeout(() => {
      const b = bundleRef.current;
      if (b) safeFit(b);
    }, 0);
  }, [visible]);

  // Ctrl + mouse wheel → zoom font size (MobaXterm convention).
  // Attached with passive:false so preventDefault actually suppresses xterm's
  // native scroll; bound once per tab and cleaned up on unmount.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      if (!(e.ctrlKey || e.metaKey)) return;
      const bundle = bundleRef.current;
      if (!bundle) return;
      e.preventDefault();
      const current = bundle.terminal.options.fontSize ?? 14;
      const delta = e.deltaY < 0 ? 1 : -1;
      // Matches the session-dialog clamp so keyboard and wheel stay in sync.
      const next = Math.max(8, Math.min(48, current + delta));
      if (next === current) return;
      bundle.terminal.options.fontSize = next;
      safeFit(bundle);
      const cid = connectionIdRef.current;
      if (cid !== null) {
        termApiRef.current.resize(cid, bundle.terminal.cols, bundle.terminal.rows).catch(() => {});
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

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
    await termApiRef.current.write(tab.connectionId, Array.from(bytes)).catch(() => {});
  }

  const showOverlay = tab.status !== 'connected' && !prompt && !authFix;
  const summary = `${tab.session.username}@${tab.session.host}${
    tab.session.port !== 22 ? `:${tab.session.port}` : ''
  }`;

  return (
    <div
      className="relative h-full w-full bg-bg"
      onContextMenu={handleContextMenu}
      onKeyDown={handleKeyDown}
      tabIndex={0}
    >
      <div ref={containerRef} className="h-full w-full p-1" />
      {showOverlay && (
        <div className="absolute inset-0 bg-bg/70 backdrop-blur-sm flex items-center justify-center overlay-in pointer-events-none">
          <div className="bg-surface border border-border rounded-md shadow-dialog px-5 py-4 w-[360px] max-w-[90%] text-center pointer-events-auto dialog-in">
            {tab.status === 'connecting' && (
              <>
                <Loader2 size={28} className="text-accent animate-spin mx-auto mb-2" />
                <div className="text-sm font-medium">Connecting…</div>
                <div className="text-muted text-xs mt-1 font-mono">{summary}</div>
              </>
            )}
            {tab.status === 'error' && (
              <>
                <AlertCircle size={28} className="text-danger mx-auto mb-2" />
                <div className="text-sm font-medium">Connection failed</div>
                <div className="text-muted text-xs mt-1 break-words">
                  {tab.errorMessage ?? 'Unknown error'}
                </div>
                <button
                  type="button"
                  onClick={() => { setStatus(tab.tabId, 'connecting'); runConnect(false); }}
                  className="btn-primary mt-3 mx-auto focus-ring"
                >
                  <PlugZap size={12} />
                  Reconnect
                </button>
              </>
            )}
            {tab.status === 'closed' && (
              <>
                <PlugZap size={28} className="text-muted mx-auto mb-2" />
                <div className="text-sm font-medium">Disconnected</div>
                <div className="text-muted text-xs mt-1 font-mono">{summary}</div>
                <button
                  type="button"
                  onClick={() => { setStatus(tab.tabId, 'connecting'); runConnect(false); }}
                  className="btn-primary mt-3 mx-auto focus-ring"
                >
                  <PlugZap size={12} />
                  Reconnect
                </button>
              </>
            )}
          </div>
        </div>
      )}
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
      {authFix && (
        <AuthFixOverlay
          session={tab.session}
          errorMessage={tab.errorMessage ?? 'Authentication failed'}
          onCancel={() => { setAuthFix(false); closeTab(tab.tabId); }}
          onSaved={(updated) => {
            setSession(tab.tabId, updated);
            setAuthFix(false);
            setStatus(tab.tabId, 'connecting');
            runConnect(false);
          }}
        />
      )}
    </div>
  );
}
