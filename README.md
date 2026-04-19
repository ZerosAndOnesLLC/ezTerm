# ezTerm

Free, open-source Windows SSH client with a MobaXterm-style session manager, encrypted credential vault, and xterm-compatible terminal.

**Status:** Pre-alpha. Plan 1 tagged at `v0.1.0-foundation` (scaffold + vault + session manager). Plan 2 (SSH + terminal) is next; SFTP follows in Plan 3.

## Dev quickstart

```bash
# one-time
cargo install tauri-cli --version '^2.0' --locked
cargo install sqlx-cli --no-default-features --features sqlite --locked
cp .env.example .env

# frontend install
npm --prefix ui install

# run
cargo tauri dev
```

Tests:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
npm --prefix ui run typecheck
npm --prefix ui run lint
```

Ship build (Windows):

```bash
cargo tauri build
```
