# ezTerm

Free, open-source Windows SSH client with a MobaXterm-style session manager, encrypted credential vault, and xterm-compatible terminal.

**Status:** Pre-alpha. Plan 1 of 3 implemented (scaffold + vault + session manager). SSH and SFTP land in Plans 2 and 3.

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
