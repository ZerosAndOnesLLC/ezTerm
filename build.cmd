@echo off
REM ezTerm build helper for Windows cmd.exe.
REM
REM Usage:
REM   build            install deps, start dev (cargo tauri dev)
REM   build dev        same as above
REM   build build      install, UI build, cargo build (debug)
REM   build run        install, UI build, cargo run
REM   build release    install, UI build, cargo tauri build (.msi / bundle)
REM   build test       cargo test + clippy + npm lint + typecheck
REM   build clean      remove ui\out, ui\node_modules, target\
REM   build help

setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

set "CMD=%~1"
if "%CMD%"=="" set "CMD=dev"

if /i "%CMD%"=="help"    goto :help
if /i "%CMD%"=="-h"      goto :help
if /i "%CMD%"=="--help"  goto :help
if /i "%CMD%"=="dev"     goto :dev
if /i "%CMD%"=="build"   goto :build
if /i "%CMD%"=="run"     goto :run
if /i "%CMD%"=="release" goto :release
if /i "%CMD%"=="test"    goto :test
if /i "%CMD%"=="clean"   goto :clean

echo [!!!] Unknown command: %CMD%. Run `build help`.
exit /b 1

:ensure_ui_deps
if not exist "ui\node_modules\" (
    echo [^>^>^>] Installing frontend dependencies ^(first run only^)
    call npm --prefix ui install --no-audit --no-fund || exit /b 1
)
exit /b 0

:ensure_ui_built
call :ensure_ui_deps || exit /b 1
if not exist "ui\out\index.html" (
    echo [^>^>^>] Building frontend static export
    call npm --prefix ui run build || exit /b 1
) else (
    findstr /c:"_next" "ui\out\index.html" >nul 2>&1
    if errorlevel 1 (
        echo [^>^>^>] Rebuilding frontend static export
        call npm --prefix ui run build || exit /b 1
    )
)
exit /b 0

:dev
call :ensure_ui_deps || exit /b 1
echo [^>^>^>] Starting cargo tauri dev
cargo tauri dev
exit /b %errorlevel%

:build
call :ensure_ui_built || exit /b 1
echo [^>^>^>] cargo build ^(debug^)
cargo build --manifest-path src-tauri\Cargo.toml
exit /b %errorlevel%

:run
call :ensure_ui_built || exit /b 1
echo [^>^>^>] cargo run
cargo run --manifest-path src-tauri\Cargo.toml
exit /b %errorlevel%

:release
call :ensure_ui_deps || exit /b 1
echo [^>^>^>] cargo tauri build ^(release bundle^)
cargo tauri build
exit /b %errorlevel%

:test
call :ensure_ui_deps || exit /b 1
echo [^>^>^>] cargo test
cargo test --manifest-path src-tauri\Cargo.toml || exit /b 1
echo [^>^>^>] cargo clippy
cargo clippy --manifest-path src-tauri\Cargo.toml --all-targets -- -D warnings || exit /b 1
echo [^>^>^>] npm typecheck
call npm --prefix ui run typecheck || exit /b 1
echo [^>^>^>] npm lint
call npm --prefix ui run lint || exit /b 1
echo [^>^>^>] All checks passed.
exit /b 0

:clean
echo [^>^>^>] Removing ui\out, ui\node_modules, target\
if exist "ui\out"          rmdir /s /q "ui\out"
if exist "ui\node_modules" rmdir /s /q "ui\node_modules"
if exist "src-tauri\target" rmdir /s /q "src-tauri\target"
if exist "target"          rmdir /s /q "target"
echo [^>^>^>] Clean.
exit /b 0

:help
echo Usage:
echo   build            install deps, start dev
echo   build dev        same as above
echo   build build      cargo build (debug)
echo   build run        cargo run
echo   build release    cargo tauri build (.msi bundle)
echo   build test       full test + lint + typecheck
echo   build clean      remove ui\out, ui\node_modules, target\
exit /b 0
