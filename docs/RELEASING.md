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

Every release starts as a **pre-release** and is promoted to latest only
after it has been tested. The in-app updater
(`releases/latest/download/latest.json`) and the website's `/dl/` MSI both
follow GitHub's *latest* release, which never includes pre-releases, so a
pre-release builds and is downloadable from its release page without
being offered to users.

1. **Bump the version** in `Cargo.toml` (workspace), `src-tauri/tauri.conf.json`
   and `ui/package.json` (`npm version --no-git-tag-version X.Y.Z`); run
   `cargo check` to refresh `Cargo.lock`. Write
   `docs/release-notes/vX.Y.Z.md`. Commit as `chore(release): vX.Y.Z` and
   push to `main`.
2. **Create it as a pre-release**:
   ```bash
   gh release create vX.Y.Z --target main --prerelease \
     --title "ezTerm vX.Y.Z" --notes-file docs/release-notes/vX.Y.Z.md
   ```
   A pre-release still counts as *published*, so the `release` workflow
   runs: all four build jobs in parallel, then `upload to release` uploads
   the archives, installers, `SHA256SUMS` and `latest.json` and swaps in
   the notes file.
3. **Test** the pre-release builds from its release page.
4. **Promote** it once it's good:
   ```bash
   gh release edit vX.Y.Z --prerelease=false --latest
   gh workflow run site.yml --ref main   # /dl/ now serves the new MSI
   ```
   From this moment the updater offers it. The site redeploy is manual
   here because `site.yml`'s automatic run fires when the *build* finishes
   (while the release is still a pre-release), and the `github-pages`
   environment only accepts deploys from `main`.

If testing finds a problem, fix it on `main` and either rebuild the same
tag (`release` workflow → *Run workflow* with the tag; assets are
replaced with `--clobber`) or delete the pre-release and its tag
(`gh release delete vX.Y.Z --cleanup-tag --yes`) and cut the next patch.

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
