# Releasing

The release pipeline lives in [`.github/workflows/release.yml`](../.github/workflows/release.yml)
and runs when a GitHub Release is published. It builds one `tar.xz`
archive per supported platform plus the installers, and uploads them
into that release.

## Supported targets

| Platform | Runner | Rust target | Archive |
|---|---|---|---|
| Windows x86_64 | `windows-latest` | `x86_64-pc-windows-msvc` | `ezTerm_<version>_windows-x64-portable.tar.xz` |
| Linux x86_64 | `ubuntu-latest` | `x86_64-unknown-linux-gnu` | `ezTerm_<version>_linux-amd64-portable.tar.xz` |
| Linux aarch64 | `ubuntu-24.04-arm` | `aarch64-unknown-linux-gnu` | `ezTerm_<version>_linux-aarch64-portable.tar.xz` |
| macOS aarch64 | `macos-latest` | `aarch64-apple-darwin` | `ezTerm_<version>_macos-aarch64-portable.tar.xz` |

Every published file follows `ezTerm_<version>_<platform>…`: the Tauri
bundler's installers (`_x64_en-US.msi`, `_x64-setup.exe`, `_amd64.deb`,
`_arm64.deb`, `_amd64.AppImage`, `_aarch64.AppImage`), the macOS updater
bundle (`_macos-aarch64.app.tar.gz`), and the portable archives above.

Each archive contains a single self-contained binary (Tauri embeds the
Next.js static export at build time), `README.md`, and `LICENSE`. No
installer — copy the binary wherever you want and run it.

## Cut a release

1. **Bump the version** in `Cargo.toml` (workspace.package.version).
   Commit. Push (via PR). Optionally add hand-written notes at
   `docs/release-notes/v0.11.0.md`.
2. **Create the release**: `gh release create v0.11.0 --generate-notes`.
   This creates the tag and publishes the release.
3. Watch the `release` workflow in the Actions tab. All four build jobs
   run in parallel on GitHub-hosted runners; the final `upload to
   release` job uploads the archives, installers, `SHA256SUMS` and
   `latest.json` into the release, and replaces the generated notes with
   `docs/release-notes/<tag>.md` when that file exists.
4. When the release workflow succeeds, `site.yml` redeploys the website
   so `/dl/` serves the new MSI.

The release is live as soon as step 2 runs; its assets (and the
updater's `latest.json`) arrive when the build finishes. To rebuild an
existing release, run the `release` workflow from the Actions tab with
its tag (`workflow_dispatch`); assets are replaced with `--clobber`.

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
`dtolnay/rust-toolchain`). If you ever want to upload assets without
the workflow, you can download the workflow artifacts locally and run:

```bash
gh release upload v0.11.0 artifacts/*.tar.xz --clobber
```

## Why not `cargo tauri build` with installers?

`tauri-action` would produce MSI + NSIS on Windows, DMG on macOS, and
DEB + AppImage on Linux — all useful eventually. Current setup asks
for `tar.xz` only, so we short-circuit to `cargo build --release` and
archive the raw binary. Swap back to `tauri-action` when ready to ship
proper installers.
