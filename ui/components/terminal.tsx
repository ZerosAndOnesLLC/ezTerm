'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Loader2, PlugZap, RefreshCw } from 'lucide-react';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { api, errMessage } from '@/lib/tauri';
import { toast } from '@/lib/toast';
import { createTerminal, type TerminalBundle } from '@/lib/xterm';
import { createOutputChannel, startOutputWatchdog, subscribeSshEvents, type OutputChannel } from '@/lib/ssh';
import { useTabs, type Tab } from '@/lib/tabs-store';
import { TerminalContextMenu } from './terminal-context-menu';
import { FindOverlay } from './find-overlay';
import { FontPickerPopover } from './font-picker-popover';
import { HostKeyDialog } from './host-key-dialog';
import { AuthFixOverlay } from './auth-fix-overlay';
import { XServerMissingDialog } from './xserver-missing-dialog';
import { resolveFontFamily } from '@/lib/xterm';
import { MIN_FONT_SIZE, MAX_FONT_SIZE } from '@/lib/fonts';
import { getSetting } from '@/lib/settings';
import { ConfirmDialog } from './confirm-dialog';
import { MAX_RECONNECT_ATTEMPTS, reconnectDelayMs } from '@/lib/reconnect';

/** How a connect attempt ended — drives the auto-reconnect loop. `fatal`
 *  means the user has to act (host-key prompt, auth fix, X server); the
 *  matching dialog is already up and retrying would just repeat it. */
type ConnectOutcome = 'ok' | 'fatal' | 'retryable';

/** Short 880 Hz tick via WebAudio — no asset to ship, ~80 ms. */
function beep() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.05;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.08);
    osc.onended = () => { void ctx.close(); };
  } catch { /* no audio device */ }
}

/** One toast per failure burst: a program retrying OSC 52 in a loop must
 *  not flood the toast region. */
let lastClipboardToast = 0;
function reportClipboardError(e: unknown) {
  const now = Date.now();
  if (now - lastClipboardToast < 5000) return;
  lastClipboardToast = now;
  toast.danger('Clipboard write failed', errMessage(e));
}

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

/** Frontend state for one backend connection. */
interface LiveConnection {
  id: number;
  output: OutputChannel;
  stopWatchdog: (() => void) | null;
  onData: { dispose(): void } | null;
  unlisten: (() => void) | null;
  disconnect: (id: number) => Promise<void>;
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
  /** Everything tied to the current backend connection. Replaced as a
   *  unit on reconnect and torn down as a unit on close, stall and
   *  unmount — see teardownConnection. */
  const connRef = useRef<LiveConnection | null>(null);
  const resizeObsRef = useRef<ResizeObserver | null>(null);
  const resizeRafRef = useRef<null | (() => void)>(null);
  const connectionIdRef = useRef<number | null>(null);
  const cancelledRef = useRef(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [pendingPaste, setPendingPaste] = useState<string | null>(null);
  const [bellFlash, setBellFlash] = useState(false);
  const bellTimer = useRef<number | null>(null);
  function flashBell() {
    setBellFlash(true);
    if (bellTimer.current) window.clearTimeout(bellTimer.current);
    bellTimer.current = window.setTimeout(() => setBellFlash(false), 120);
  }
  const [find, setFind] = useState(false);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [authFix, setAuthFix] = useState(false);
  const [xserverMissing, setXserverMissing] = useState(false);
  const [fontPicker, setFontPicker] = useState(false);
  const [confirmEndRemote, setConfirmEndRemote] = useState(false);
  /** Auto-reconnect in progress: attempt number and when it fires. */
  const [reconnect, setReconnect] = useState<{ attempt: number; at: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const reconnectTimerRef = useRef<number | null>(null);
  /** Bumped by every cancel, so an attempt already in flight when the
   *  user hits Cancel (or Reconnect) can't re-arm the loop when it ends. */
  const reconnectGenRef = useRef(0);
  // Live font state for this tab. Starts from the session row; the
  // context-menu picker and Ctrl+wheel mutate these without rewriting
  // the DB (unless the user explicitly saves via the picker). A ref
  // mirrors the font size for the wheel handler so accumulated deltas
  // always read the current value without a stale closure.
  const [liveFontSize,   setLiveFontSize]   = useState(tab.session.font_size);
  const [liveFontFamily, setLiveFontFamily] = useState(tab.session.font_family ?? '');
  const liveFontSizeRef = useRef(liveFontSize);
  useEffect(() => { liveFontSizeRef.current = liveFontSize; }, [liveFontSize]);
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

  /** Drop the current connection's frontend state: stop the watchdog,
   *  detach output (Rust keeps sending until it processes the
   *  disconnect, and xterm throws on write after dispose), dispose the
   *  keystroke listener, unlisten close/error. `disconnect: false` is for
   *  the close event, where the backend side is already gone. */
  const teardownConnection = useCallback((opts: { disconnect: boolean }) => {
    const c = connRef.current;
    if (!c) return;
    connRef.current = null;
    c.stopWatchdog?.();
    c.output.detach();
    c.onData?.dispose();
    c.unlisten?.();
    if (connectionIdRef.current === c.id) connectionIdRef.current = null;
    if (opts.disconnect) c.disconnect(c.id).catch(() => {});
  }, []);

  /** Stop any pending auto-reconnect. Every manual connect path (Reconnect
   *  button, host-key trust, auth fix, X server dialog) goes through
   *  runConnect, which calls this first, so a user action always wins
   *  over a timer. */
  const cancelReconnect = useCallback(() => {
    reconnectGenRef.current += 1;
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    setReconnect(null);
  }, []);

  /** The link dropped (ssh:lost or stalled output). Set from the render
   *  body below so it always sees the current session row — the user may
   *  have flipped auto_reconnect since the tab opened. */
  const onLinkLostRef = useRef<() => void>(() => {});

  const runConnect = useCallback(async (
    trustAny: boolean, disableX11 = false, auto = false,
  ): Promise<ConnectOutcome> => {
    const bundle = bundleRef.current;
    if (!bundle) return 'fatal';
    if (!auto) cancelReconnect();
    // A retry replaces the previous connection wholesale; its listeners
    // must not outlive it or its close event would act on the new one.
    teardownConnection({ disconnect: true });
    // Error surface is the overlay + tab-bar status dot + status bar. No
    // ANSI fallback — it used to clutter scrollback on reconnect without
    // adding information the overlay doesn't already show.
    const fail = (msg: string) => setStatus(tab.tabId, 'error', msg);
    // During auto-reconnect a transient failure stays on the
    // "reconnecting" overlay instead of flashing the error card.
    const softFail = (msg: string): ConnectOutcome => {
      if (!auto) fail(msg);
      return 'retryable';
    };
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
      // Output channel is created before the connect call so the backend
      // can never emit into a listener that doesn't exist yet. It buffers
      // until arm() below, once keystroke replies can flow back.
      const output = createOutputChannel((bytes) => bundle.terminal.write(bytes));
      let result: { connection_id: number };
      try {
        result = isLocal
          ? await api.localConnect(tab.session.id, cols, rows, output.channel)
          : await api.sshConnect(
              tab.session.id, cols, rows, trustAny, disableX11, tab.persistSlot, output.channel,
            );
      } catch (e) {
        output.detach();
        const code = (e as { code?: string })?.code;
        // Host-key prompts are SSH-specific; local kinds can't produce them.
        if (!isLocal && code === 'host_key_untrusted') {
          setPrompt({
            kind: 'untrusted',
            fingerprint: (e as { actual?: string })?.actual ?? '',
          });
          return 'fatal';
        }
        if (!isLocal && code === 'host_key_mismatch') {
          setPrompt({
            kind: 'mismatch',
            fingerprint: (e as { actual?: string })?.actual ?? '',
            expectedFingerprint: (e as { expected?: string })?.expected,
          });
          return 'fatal';
        }
        // VcXsrv not installed — session has X11 forwarding on but the
        // local X server can't be started. Show the install / opt-out
        // dialog instead of the generic "Connection failed" card.
        if (!isLocal && code === 'xserver_missing') {
          fail(errMessage(e));
          setXserverMissing(true);
          return 'fatal';
        }
        // Auth-class failures get the inline fix-it flow instead of the
        // generic "Connection failed" card. Keep the status=error set
        // so the tab dot reflects the broken state until resolved.
        if (!isLocal && isAuthError(e)) {
          fail(errMessage(e));
          setAuthFix(true);
          return 'fatal';
        }
        return softFail(errMessage(e));
      }
      if (cancelledRef.current) {
        output.detach();
        await term.disconnect(result.connection_id);
        return 'fatal';
      }
      const cid = result.connection_id;
      const conn: LiveConnection = {
        id: cid, output, stopWatchdog: null, onData: null, unlisten: null, disconnect: term.disconnect,
      };
      connRef.current = conn;
      const isLive = () => connRef.current === conn;
      connectionIdRef.current = cid;
      setConn(tab.tabId, cid);
      setStatus(tab.tabId, 'connected');
      if (
        getSetting('sessions.autoOpenSftp') &&
        (tab.session.session_kind === 'ssh' || tab.session.session_kind === 'wsl')
      ) {
        useTabs.getState().setSftpOpen(tab.tabId, true);
      }

      // Local PTYs reuse the ssh:* event topics (close / error) so the
      // subscriber doesn't need to branch.
      const unlisten = await subscribeSshEvents(cid, {
        onClose: (reason) => {
          if (!isLive()) return;
          teardownConnection({ disconnect: false });
          // A non-zero exit status or a signal is worth showing; zero and
          // "no status" (the channel just ended) read as a plain
          // disconnect — unless an error was already reported for this
          // connection, in which case the error and its message stay.
          const text =
            typeof reason === 'number' ? (reason !== 0 ? `exit ${reason}` : null) : reason;
          const cur = useTabs.getState().tabs.find((t) => t.tabId === tab.tabId);
          if (!text && cur?.status === 'error') return;
          setStatus(tab.tabId, 'closed', text);
        },
        onError: (msg) => { if (isLive()) fail(msg); },
        // Transport gone — the backend has already torn the connection
        // down, so there's nothing to disconnect.
        onLost: () => {
          if (!isLive()) return;
          teardownConnection({ disconnect: false });
          onLinkLostRef.current();
        },
      });
      if (!isLive() || cancelledRef.current) {
        unlisten();
        teardownConnection({ disconnect: true });
        return 'fatal';
      }
      conn.unlisten = unlisten;

      // Keystroke / terminal-reply handler. Bash emits a DSR
      // cursor-position query (`ESC [ 6 n`) during prompt setup and
      // waits for `ESC [ <row> ; <col> R`; xterm.js generates that reply
      // synchronously inside its parser and fires `onData`. The output
      // channel has been buffering since before connect precisely so
      // nothing reaches the parser until this listener exists. One
      // listener per connection — a reconnect disposes the previous one.
      conn.onData = bundle.terminal.onData((data) => {
        const bytes = new TextEncoder().encode(data);
        term.write(cid, Array.from(bytes)).catch(() => {});
      });
      output.arm();

      // Stall watchdog: see startOutputWatchdog. Fails the tab visibly
      // instead of leaving a frozen terminal.
      conn.stopWatchdog = startOutputWatchdog(
        output,
        () => api.terminalOutputSent(cid),
        () => {
          if (!isLive()) return;
          teardownConnection({ disconnect: true });
          if (!isLocal && useTabs.getState().tabs.find((t) => t.tabId === tab.tabId)?.session.auto_reconnect === 1) {
            onLinkLostRef.current();
            return;
          }
          fail('Terminal output stalled — the connection was dropped. Reconnect to continue.');
        },
      );

      // Connection is up. The mount-time ResizeObserver / window
      // 'resize' handler reads `connectionIdRef.current` and forwards
      // dimensions to the backend, so no further setup is needed here.
      return 'ok';
    } catch (e) {
      return softFail(errMessage(e));
    }
  }, [
    tab.tabId, tab.session.id, tab.session.session_kind, tab.persistSlot,
    setStatus, setConn, teardownConnection, cancelReconnect,
  ]);

  /** Arm auto-reconnect attempt `attempt` after its backoff delay. */
  const scheduleReconnect = useCallback((attempt: number) => {
    if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    if (attempt > MAX_RECONNECT_ATTEMPTS) {
      setReconnect(null);
      setStatus(tab.tabId, 'closed', 'connection lost');
      return;
    }
    const delay = reconnectDelayMs(attempt);
    setStatus(tab.tabId, 'connecting');
    setReconnect({ attempt, at: Date.now() + delay });
    setNow(Date.now());
    const gen = reconnectGenRef.current;
    reconnectTimerRef.current = window.setTimeout(async () => {
      reconnectTimerRef.current = null;
      if (cancelledRef.current) return;
      const outcome = await runConnect(false, false, true);
      if (cancelledRef.current || gen !== reconnectGenRef.current) return;
      if (outcome === 'retryable') scheduleReconnect(attempt + 1);
      else setReconnect(null);
    }, delay);
  }, [tab.tabId, setStatus, runConnect]);

  onLinkLostRef.current = () => {
    const cur = useTabs.getState().tabs.find((t) => t.tabId === tab.tabId);
    if (cur?.session.auto_reconnect === 1) scheduleReconnect(1);
    else setStatus(tab.tabId, 'closed', 'connection lost');
  };

  // Countdown tick for the "next try in Ns" line.
  useEffect(() => {
    if (!reconnect) return;
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [reconnect]);

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
      fontFamily: tab.session.font_family,
      scrollback: tab.session.scrollback_lines,
      cursorStyle: tab.session.cursor_style,
      cursorBlink: getSetting('terminal.cursorBlink'),
      // Same native clipboard path as doCopy — see the note there.
      onClipboardWrite: writeText,
      onClipboardError: reportClipboardError,
      allowClipboardWrite: () => getSetting('terminal.osc52Clipboard'),
      onBell: () => {
        const mode = getSetting('terminal.bell');
        if (mode === 'sound') beep();
        else if (mode === 'visual') flashBell();
      },
    });
    // Copy-on-select (off by default): mirrors PuTTY / MobaXterm. Read
    // per event so the Settings switch applies without a reopen.
    bundle.terminal.onSelectionChange(() => {
      if (!getSetting('terminal.copyOnSelect')) return;
      const sel = bundle.terminal.getSelection();
      if (sel) writeText(sel).catch(() => {});
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

    // Resize handling — set up at MOUNT, not after connect, so resizes
    // during the auth/handshake window aren't dropped and shrink-resizes
    // that WebView2 only reports via `window.resize` (not always via
    // ResizeObserver, audit issue #103) still propagate. Both signals
    // feed one rAF-coalesced handler so we issue at most one IPC per
    // animation frame even when both fire for the same gesture.
    let resizeRaf = 0;
    const onResize = () => {
      if (resizeRaf) return;
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        const b = bundleRef.current;
        if (!b) return;
        safeFit(b);
        const cid = connectionIdRef.current;
        if (cid !== null) {
          termApiRef.current
            .resize(cid, b.terminal.cols, b.terminal.rows)
            .catch(() => {});
        }
      });
    };
    const ro = new ResizeObserver(onResize);
    if (containerRef.current) ro.observe(containerRef.current);
    resizeObsRef.current = ro;
    window.addEventListener('resize', onResize);
    resizeRafRef.current = () => {
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      window.removeEventListener('resize', onResize);
    };

    return () => {
      cancelledRef.current = true;
      window.clearTimeout(openTimer);
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      // Stop output before the terminal goes away (see teardownConnection).
      teardownConnection({ disconnect: true });
      resizeObsRef.current?.disconnect();
      resizeObsRef.current = null;
      resizeRafRef.current?.();
      resizeRafRef.current = null;
      // Only dispose if we actually reached open(); disposing a never-opened
      // terminal is harmless but this avoids spurious console warnings.
      if (opened) {
        try { bundle.dispose(); } catch { /* xterm race on unmount */ }
      }
      bundleRef.current = null;
      connectionIdRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.tabId]);

  // Fit + focus when becoming visible (or when a blocking overlay closes on
  // an already-visible tab). Without the explicit focus, xterm's hidden
  // textarea keeps focus on whatever tab the user clicked away from, so
  // keystrokes go nowhere until the user clicks into the terminal — which
  // is exactly the "click tab, type, nothing happens" report from users.
  // Skip focus while a dialog/overlay is up so we don't steal keyboard
  // control from the host-key prompt, auth-fix flow, etc.
  useEffect(() => {
    if (!visible) return;
    const id = window.setTimeout(() => {
      const b = bundleRef.current;
      if (!b) return;
      safeFit(b);
      const blocked = prompt || authFix || xserverMissing || find || fontPicker;
      if (!blocked && tab.status === 'connected') b.terminal.focus();
    }, 0);
    return () => window.clearTimeout(id);
  }, [visible, prompt, authFix, xserverMissing, find, fontPicker, tab.status]);

  // Ctrl + mouse wheel → zoom font size (MobaXterm convention).
  //
  // Registered in the **capture** phase on the terminal container so the
  // handler sees the event *before* xterm's internal viewport wheel
  // handler inside the canvas. Without capture, xterm bubbles up first,
  // scrolls the buffer, and `preventDefault` in a bubble-phase listener
  // arrives too late — the mix of zoom + scroll is jarring.
  //
  // When Ctrl (or Cmd) is held we swallow the event fully:
  //   - `preventDefault()` blocks the webview's own zoom
  //   - `stopImmediatePropagation()` keeps xterm from scrolling
  //
  // Deltas accumulate so a trackpad's flood of ±4 px events doesn't
  // jump the size per tick; one step per ~40 px of accumulated scroll
  // makes mouse wheels (≈ 100 px per detent) step once per notch and
  // trackpads feel smooth.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let accum = 0;
    const STEP_THRESHOLD = 40;
    function onWheel(e: WheelEvent) {
      if (!(e.ctrlKey || e.metaKey)) return;
      const bundle = bundleRef.current;
      if (!bundle) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      accum += e.deltaY;
      if (Math.abs(accum) < STEP_THRESHOLD) return;
      const steps = Math.trunc(accum / STEP_THRESHOLD);
      accum -= steps * STEP_THRESHOLD;
      const current = liveFontSizeRef.current;
      // Wheel up (negative deltaY) grows the font; down shrinks.
      const next = Math.max(
        MIN_FONT_SIZE,
        Math.min(MAX_FONT_SIZE, current - steps),
      );
      if (next === current) return;
      bundle.terminal.options.fontSize = next;
      setLiveFontSize(next);
      safeFit(bundle);
      const cid = connectionIdRef.current;
      if (cid !== null) {
        termApiRef.current.resize(cid, bundle.terminal.cols, bundle.terminal.rows).catch(() => {});
      }
    }
    el.addEventListener('wheel', onWheel, { capture: true, passive: false });
    return () => el.removeEventListener('wheel', onWheel, true);
  }, []);

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    // If the user right-clicks while ezTerm is in the background (common when
    // copying from another app and pasting here), pull the window forward so
    // the subsequent action — and any keystrokes after it — land in the
    // terminal without an extra left-click.
    getCurrentWindow().setFocus().catch(() => {});
    // Right-click-to-paste (PuTTY / MobaXterm convention) is a setting;
    // Ctrl + right-click always reaches the menu so nothing is lost.
    if (getSetting('terminal.rightClick') === 'paste' && !e.ctrlKey) {
      void doPaste();
      return;
    }
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
    if (!sel) return;
    // Tauri's clipboard plugin routes through native OS APIs (NSPasteboard
    // on macOS, xclip/wl-clipboard on Linux, OLE on Windows). Using
    // navigator.clipboard.* here would silently fail on Linux WebKitGTK
    // (no permission prompt available) and is flaky on macOS WKWebView.
    await writeText(sel);
  }

  /** Apply a font change live to the xterm instance, the ref, and any
   *  visible state. Called from the Font popover on every tweak. */
  function applyFont(next: { fontSize: number; fontFamily: string }) {
    const bundle = bundleRef.current;
    if (!bundle) return;
    if (next.fontSize !== liveFontSize) {
      bundle.terminal.options.fontSize = next.fontSize;
      setLiveFontSize(next.fontSize);
    }
    if (next.fontFamily !== liveFontFamily) {
      bundle.terminal.options.fontFamily = resolveFontFamily(next.fontFamily);
      setLiveFontFamily(next.fontFamily);
    }
    safeFit(bundle);
    const cid = connectionIdRef.current;
    if (cid !== null) {
      termApiRef.current.resize(cid, bundle.terminal.cols, bundle.terminal.rows).catch(() => {});
    }
  }

  /** Persist the current live font settings to the sessions row so the
   *  choice sticks across reconnects. Only called when the user checks
   *  "Save as session default" or clicks Save in the popover. */
  async function saveFontToSession() {
    const env = await api.sessionEnvGet(tab.session.id).catch(() => []);
    const updated = await api.sessionUpdate(tab.session.id, {
      folder_id: tab.session.folder_id,
      name: tab.session.name,
      host: tab.session.host,
      port: tab.session.port,
      username: tab.session.username,
      auth_type: tab.session.auth_type,
      credential_id: tab.session.credential_id,
      key_passphrase_credential_id: tab.session.key_passphrase_credential_id,
      color: tab.session.color,
      initial_command: tab.session.initial_command,
      scrollback_lines: tab.session.scrollback_lines,
      font_size: liveFontSize,
      font_family: liveFontFamily,
      cursor_style: tab.session.cursor_style,
      compression: tab.session.compression,
      keepalive_secs: tab.session.keepalive_secs,
      connect_timeout_secs: tab.session.connect_timeout_secs,
      env,
      session_kind: tab.session.session_kind,
      forward_x11: tab.session.forward_x11,
      starting_dir: tab.session.starting_dir,
      persistent_shell: tab.session.persistent_shell,
      auto_reconnect: tab.session.auto_reconnect,
    });
    setSession(tab.tabId, updated);
  }

  async function doPaste() {
    // See doCopy — clipboard plugin instead of navigator.clipboard for
    // cross-platform reliability on Linux/macOS.
    const txt = await readText();
    if (!txt || !tab.connectionId) return;
    // A newline anywhere before the end means the shell would execute
    // lines as they land. Ask first unless the user turned that off.
    if (getSetting('terminal.warnMultilinePaste') && /[\r\n]/.test(txt.trimEnd())) {
      setPendingPaste(txt);
      return;
    }
    pasteText(txt);
  }

  function pasteText(txt: string) {
    if (!tab.connectionId) return;
    const bundle = bundleRef.current;
    if (!bundle) return;
    // Go through xterm's own `paste()` instead of encoding + writing to
    // the PTY directly. It handles the two things that mangle pastes
    // from the Windows clipboard (and apps like the Claude Code GUI,
    // Slack, browsers, …):
    //   - Line-ending normalisation: \r\n / \n / lone \r → \r (the
    //     actual byte the terminal sends when the user presses Enter).
    //     Writing raw \r\n submits each line twice — once for \r, once
    //     for \n — and an "Enter on a blank line" between every
    //     real line was the formatting corruption.
    //   - Bracketed paste: when the remote shell has DEC mode 2004 on
    //     (modern bash, zsh, fish, vim, less, claude-code's CLI, …),
    //     xterm wraps the payload in `\e[200~ … \e[201~` so the shell
    //     knows it's pasted text and disables auto-indent / history
    //     expansion / inline command execution.
    // The pasted bytes flow back through xterm's onData listener
    // registered in runConnect, which writes them to the PTY.
    bundle.terminal.paste(txt);
    // Ensure the window is foregrounded and xterm has focus so the user can
    // keep typing immediately after pasting — otherwise right-click → Paste
    // from a background ezTerm requires an extra left-click before keys go
    // through.
    getCurrentWindow().setFocus().catch(() => {});
    bundle.terminal.focus();
  }

  const showOverlay = tab.status !== 'connected' && !prompt && !authFix && !xserverMissing;
  const summary = `${tab.session.username}@${tab.session.host}${
    tab.session.port !== 22 ? `:${tab.session.port}` : ''
  }`;

  return (
    <div
      className={`relative h-full w-full bg-bg ${bellFlash ? 'ring-2 ring-inset ring-warning' : ''}`}
      onContextMenu={handleContextMenu}
      onKeyDown={handleKeyDown}
      tabIndex={0}
    >
      <div ref={containerRef} className="h-full w-full p-1" />
      {pendingPaste !== null && (
        <ConfirmDialog
          kind="danger"
          title="Paste multiple lines?"
          body={`The clipboard holds ${pendingPaste.trimEnd().split(/\r\n|\r|\n/).length} lines. Each one will run as you paste it.`}
          confirmText="Paste"
          onCancel={() => setPendingPaste(null)}
          onConfirm={() => { const t = pendingPaste; setPendingPaste(null); pasteText(t); }}
        />
      )}
      {showOverlay && (
        <div className="absolute inset-0 bg-bg/70 backdrop-blur-sm flex items-center justify-center overlay-in pointer-events-none">
          <div className="bg-surface border border-border rounded-md shadow-dialog px-5 py-4 w-[360px] max-w-[90%] text-center pointer-events-auto dialog-in">
            {tab.status === 'connecting' && !reconnect && (
              <>
                <Loader2 size={28} className="text-accent animate-spin mx-auto mb-2" />
                <div className="text-sm font-medium">Connecting…</div>
                <div className="text-muted text-xs mt-1 font-mono">{summary}</div>
              </>
            )}
            {tab.status === 'connecting' && reconnect && (
              <>
                <RefreshCw size={28} className="text-accent animate-spin mx-auto mb-2" />
                <div className="text-sm font-medium">Connection lost — reconnecting</div>
                <div className="text-muted text-xs mt-1">
                  Attempt {reconnect.attempt} of {MAX_RECONNECT_ATTEMPTS}
                  {reconnect.at > now
                    ? ` · next try in ${Math.ceil((reconnect.at - now) / 1000)}s`
                    : ' · trying now…'}
                </div>
                <div className="text-muted text-xs mt-0.5 font-mono">{summary}</div>
                <div className="flex gap-2 justify-center mt-3">
                  <button
                    type="button"
                    onClick={() => {
                      const attempt = reconnect.attempt;
                      cancelReconnect();
                      const gen = reconnectGenRef.current;
                      void runConnect(false, false, true).then((o) => {
                        if (cancelledRef.current || gen !== reconnectGenRef.current) return;
                        if (o === 'retryable') scheduleReconnect(attempt + 1);
                      });
                    }}
                    disabled={reconnect.at <= now}
                    className="btn-primary focus-ring"
                  >
                    <PlugZap size={12} />
                    Retry now
                  </button>
                  <button
                    type="button"
                    onClick={() => { cancelReconnect(); setStatus(tab.tabId, 'closed', 'connection lost'); }}
                    className="btn-ghost focus-ring"
                  >
                    Cancel
                  </button>
                </div>
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
                <div className="text-sm font-medium">
                  Disconnected{tab.errorMessage ? ` (${tab.errorMessage})` : ''}
                </div>
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
          onFont={() => { setFontPicker(true); setMenu(null); }}
          onEndRemote={
            tab.session.session_kind === 'ssh' &&
            tab.session.persistent_shell !== 'off' &&
            tab.status === 'connected'
              ? () => { setConfirmEndRemote(true); setMenu(null); }
              : undefined
          }
          onClose={() => setMenu(null)}
        />
      )}
      {confirmEndRemote && (
        <ConfirmDialog
          kind="danger"
          title="End remote session?"
          body={`This ends the ${tab.session.persistent_shell} session on ${tab.session.host} and everything running in it. Closing the tab instead leaves it running so you can reattach later.`}
          confirmText="End session"
          onCancel={() => setConfirmEndRemote(false)}
          onConfirm={() => {
            setConfirmEndRemote(false);
            const cid = connectionIdRef.current;
            if (cid === null) return;
            api.sshPersistKill(cid).catch((e) => toast.danger('Could not end remote session', errMessage(e)));
          }}
        />
      )}
      {find && bundleRef.current && (
        <FindOverlay search={bundleRef.current.search} onClose={() => setFind(false)} />
      )}
      {fontPicker && (
        <FontPickerPopover
          fontSize={liveFontSize}
          fontFamily={liveFontFamily}
          canSave
          onChange={applyFont}
          onSave={saveFontToSession}
          onClose={() => setFontPicker(false)}
        />
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
      {xserverMissing && (
        <XServerMissingDialog
          onInstalled={() => {
            setXserverMissing(false);
            setStatus(tab.tabId, 'connecting');
            runConnect(false);
          }}
          onContinueWithoutX11={() => {
            setXserverMissing(false);
            setStatus(tab.tabId, 'connecting');
            runConnect(false, /* disableX11 */ true);
          }}
          onCancel={() => { setXserverMissing(false); closeTab(tab.tabId); }}
        />
      )}
    </div>
  );
}
