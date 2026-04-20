#!/usr/bin/env bash
# ezTerm build helper. Works in Git Bash on Windows, WSL, macOS, and Linux.
#
# Usage:
#   ./build.sh            # install deps, start dev (cargo tauri dev)
#   ./build.sh dev        # same as above
#   ./build.sh build      # install, UI build, cargo build (debug)
#   ./build.sh run        # install, UI build, cargo run
#   ./build.sh release    # install, UI build, cargo tauri build (.msi / bundle)
#   ./build.sh test       # cargo test + npm lint + npm typecheck
#   ./build.sh clean      # remove ui/out, ui/node_modules, target/
#   ./build.sh help
set -euo pipefail

cd "$(dirname "$0")"

color() { printf '\033[1;36m>>>\033[0m %s\n' "$*"; }
err()   { printf '\033[1;31m!!!\033[0m %s\n' "$*" >&2; exit 1; }

require() {
  command -v "$1" >/dev/null 2>&1 || err "$1 not found in PATH. Install it and retry."
}

ensure_ui_deps() {
  if [ ! -d ui/node_modules ]; then
    color "Installing frontend dependencies (first run only — takes a minute)"
    npm --prefix ui install --no-audit --no-fund
  fi
}

ensure_ui_built() {
  ensure_ui_deps
  if [ ! -f ui/out/index.html ] || ! grep -q "_next" ui/out/index.html 2>/dev/null; then
    color "Building frontend static export"
    npm --prefix ui run build
  fi
}

cmd="${1:-dev}"

case "$cmd" in
  dev)
    require cargo; require npm
    ensure_ui_deps
    color "Starting cargo tauri dev (UI runs via beforeDevCommand)"
    exec cargo tauri dev
    ;;

  build)
    require cargo; require npm
    ensure_ui_built
    color "cargo build (debug)"
    exec cargo build --manifest-path src-tauri/Cargo.toml
    ;;

  run)
    require cargo; require npm
    ensure_ui_built
    color "cargo run"
    exec cargo run --manifest-path src-tauri/Cargo.toml
    ;;

  release)
    require cargo; require npm
    ensure_ui_deps
    color "cargo tauri build (release bundle)"
    exec cargo tauri build
    ;;

  test)
    require cargo; require npm
    ensure_ui_deps
    color "cargo test"
    cargo test --manifest-path src-tauri/Cargo.toml
    color "cargo clippy"
    cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
    color "npm typecheck"
    npm --prefix ui run typecheck
    color "npm lint"
    npm --prefix ui run lint
    color "All checks passed."
    ;;

  clean)
    color "Removing ui/out, ui/node_modules, target/"
    rm -rf ui/out ui/node_modules src-tauri/target target
    color "Clean."
    ;;

  help|-h|--help)
    sed -n '3,12p' "$0"
    ;;

  *)
    err "Unknown command: $cmd. Run ./build.sh help."
    ;;
esac
