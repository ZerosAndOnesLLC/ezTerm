# Releasing

The release pipeline lives in [`.github/workflows/release.yml`](../.github/workflows/release.yml)
and produces one `tar.xz` archive per supported platform, attached to a
draft GitHub Release that you review and publish by hand.

## Supported targets

| Platform | Runner | Rust target | Archive |
|---|---|---|---|
| Windows x86_64 | `windows-latest` | `x86_64-pc-windows-msvc` | `ezterm-windows-x86_64.tar.xz` |
| Linux x86_64 | `ubuntu-latest` | `x86_64-unknown-linux-gnu` | `ezterm-linux-x86_64.tar.xz` |
| Linux aarch64 | `ubuntu-24.04-arm` | `aarch64-unknown-linux-gnu` | `ezterm-linux-aarch64.tar.xz` |
| macOS aarch64 | `macos-latest` | `aarch64-apple-darwin` | `ezterm-macos-aarch64.tar.xz` |

Each archive contains a single self-contained binary (Tauri embeds the
Next.js static export at build time), `README.md`, and `LICENSE`. No
installer — copy the binary wherever you want and run it.

## Cut a release

1. **Bump the version** in `Cargo.toml` (workspace.package.version).
   Commit. Push.
2. **Tag the commit**: `git tag v0.11.0 && git push origin v0.11.0`.
3. Watch the `release` workflow in the Actions tab. All four build jobs
   run in parallel (~10 min on free tier); the final `publish draft
   release` job attaches the artifacts to a draft release.
4. Open the draft release on GitHub, write release notes, attach any
   migration caveats, and **Publish**.

`workflow_dispatch` also triggers the build jobs if you want to
smoke-test the pipeline without tagging — artifacts land on the
workflow run but no GitHub Release is created.

## Platform caveats

- **Windows** — the binary is self-contained. WSL and local-shell
  sessions work. X11 forwarding requires the user to install
  [VcXsrv](https://sourceforge.net/projects/vcxsrv/) separately;
  bundling it in an installer is v0.12 work.
- **Linux** — the binary requires `webkit2gtk-4.1` + `libssl` at
  runtime (same as the build host). WSL autodetect returns empty,
  `cmd.exe` / `pwsh.exe` local shells won't spawn, and the
  `%ProgramFiles%\VcXsrv` path probe is a no-op. Only SSH + SFTP
  sessions are usable out of the box.
- **macOS** — same as Linux for the Windows-specific features. The
  archive contains a plain executable, not a `.app` bundle; users may
  need to allow it in System Settings → Privacy & Security on first
  launch (Gatekeeper blocks unsigned binaries). Signing / notarisation
  would eliminate that prompt but needs secrets.

## Why `gh release` and not an action?

`gh` is pre-installed on every GitHub runner and the CLI is the same
locally and in CI — matches what we use in other repos. No third-party
action in the release job (build jobs still use stable first-party
actions like `actions/checkout`, `actions/setup-node`, and
`dtolnay/rust-toolchain`). If you ever want to cut a release without
tagging, you can download the workflow artifacts locally and run:

```bash
gh release create v0.11.0 --generate-notes --draft artifacts/*.tar.xz
```

## Why not `cargo tauri build` with installers?

`tauri-action` would produce MSI + NSIS on Windows, DMG on macOS, and
DEB + AppImage on Linux — all useful eventually. Current setup asks
for `tar.xz` only, so we short-circuit to `cargo build --release` and
archive the raw binary. Swap back to `tauri-action` when ready to ship
proper installers.
