; NSIS installer hooks wired via `tauri.windows.conf.json`
; (bundle.windows.nsis.installerHooks). The Tauri bundler wraps the
; built-in install/uninstall sections and expands these macros at the
; documented hook points — see tauri-utils config.rs for the full list.
;
; What we do here:
;   - On uninstall, remove the per-user VcXsrv install that the "Install
;     VcXsrv" in-app flow writes to %APPDATA%\zerosandones\ezterm\data\vcxsrv.
;     The bundled copy under `Program Files\ezTerm\resources\vcxsrv` is
;     already removed by the standard NSIS uninstaller (it tracks every
;     file the installer placed).
;
; What we DO NOT do:
;   - Touch the user's sessions DB, vault, credentials, settings, or
;     known_hosts. Those are user data; removal should be an explicit
;     user action (future: a "remove user data" checkbox on the uninstall
;     page). Silent deletion here would be surprising on re-install.

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Removing per-user VcXsrv install (if present)…"
  RMDir /r "$APPDATA\zerosandones\ezterm\data\vcxsrv"
!macroend
