# Updater fix: per-installer manifest entries + macOS support

**Date:** 2026-04-28
**Status:** Approved (design phase)
**Tracking issue:** [#36](https://github.com/ZerosAndOnesLLC/ezTerm/issues/36)

## 1. Goal

Make in-app auto-update work for **all** distribution channels we ship:

- **Windows NSIS** — already works; preserve.
- **Linux AppImage** — already works; preserve.
- **Linux .deb** — currently broken with `InvalidUpdaterFormat`; fix by serving a signed `.deb` URL via a `linux-{arch}-deb` manifest entry.
- **macOS aarch64** — currently no auto-update at all; fix by building a `.app` and shipping the `.app.tar.gz` updater artifact.

Workflow-only fix in `.github/workflows/release.yml`. **No Rust or UI changes.** Cut as v1.1.3.

## 2. Non-Goals (this PR)

- macOS x86_64 builds (Intel Mac demand pending).
- Apple Developer ID signing or notarization. Tauri produces an ad-hoc-signed `.app`; Tauri's minisign-signed `.app.tar.gz` is what the updater needs. macOS users will see Gatekeeper "unidentified developer" on first launch and right-click → Open. Auto-update works regardless.
- Auto-elevation for `dpkg -i` on the deb install path. Tauri's plugin invokes `dpkg` directly; if the user's session lacks elevation it'll fail with a permission error instead of installing silently. Acceptable until proven otherwise — if real users hit it on Ubuntu desktop installs, that gets a follow-up ticket.
- Backfilling `latest.json` for older releases (v1.1.2 and earlier). Once v1.1.3 ships and the `releases/latest/download/latest.json` redirect points at the new manifest, every existing v1.0.0+ user gets the right artifact for their install method on next "Check for updates."
- DMG bundles or per-arch macOS installers beyond aarch64.

## 3. Background — root cause

The Tauri updater plugin v2 looks up the manifest's `platforms` map keyed by `{os}-{arch}-{installer}` first, then falls back to `{os}-{arch}` ([plugin source: `get_urls`](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/updater/src/updater.rs)). The `{installer}` segment is derived from a build-time constant (`__TAURI_BUNDLE_TYPE`) baked into the binary by the bundler. On a deb install, the constant is `Deb`; on an AppImage install it's `AppImage`.

Today our `latest.json` only emits the bare `linux-x86_64` (and `-aarch64`) entries pointing at AppImage URLs. A deb-installed binary downloads the AppImage, attempts `install_deb(bytes)`, fails `infer::archive::is_deb()` validation, throws `InvalidUpdaterFormat`. Same shape for the missing macOS entry — there's nothing to download at all.

## 4. Architecture — workflow layout

The fix touches only `.github/workflows/release.yml`. Five logical changes:

```
build matrix
  ├── windows-x86_64        unchanged
  ├── linux-x86_64          unchanged build; NEW: sign .deb with minisign
  ├── linux-aarch64         unchanged build; NEW: sign .deb with minisign
  └── macos-aarch64         CHANGED: bundles "app" via cargo tauri build
                            (was: empty bundles via cargo build --release)

per-job collect step
  └── glob extended to include *.deb.sig, *.app.tar.gz, *.app.tar.gz.sig

release job
  ├── manifest builder      REWRITTEN: emit per-installer entries +
  │                         macOS, keep linux-{arch} as fallback
  ├── sanity-check step     NEW: assert every manifest URL exists in uploads
  └── create draft release  EXTENDED: include .deb.sig and .app.tar.gz(.sig)
                            in the asset list
```

## 5. Bundles produced per platform after the fix

| Platform | Tauri bundle target | Files produced (in `bundle/`) | New in this PR |
|---|---|---|---|
| windows-x86_64 | `msi nsis` | `*.msi`, `*.msi.sig`, `*-setup.exe`, `*-setup.exe.sig` | — |
| linux-x86_64 | `appimage deb` | `*.AppImage`, `*.AppImage.sig`, `*.deb` | `*.deb.sig` (manual minisign) |
| linux-aarch64 | `appimage deb` | `*.AppImage`, `*.AppImage.sig`, `*.deb` | `*.deb.sig` (manual minisign) |
| macos-aarch64 | `app` | `*.app`, `*.app.tar.gz`, `*.app.tar.gz.sig` | All three (was: raw binary only) |

Plus the existing portable `*.tar.xz` per platform (unchanged).

## 6. Manifest schema (`latest.json`)

Schema preserved — Tauri plugin's existing format. The `platforms` map gains per-installer entries:

```json
{
  "version": "1.1.3",
  "notes": "...",
  "pub_date": "...",
  "platforms": {
    "windows-x86_64":          { "url": "...x64-setup.exe", "signature": "..." },

    "linux-x86_64":            { "url": "...amd64.AppImage", "signature": "..." },
    "linux-x86_64-appimage":   { "url": "...amd64.AppImage", "signature": "..." },
    "linux-x86_64-deb":        { "url": "...amd64.deb",      "signature": "..." },

    "linux-aarch64":           { "url": "...aarch64.AppImage", "signature": "..." },
    "linux-aarch64-appimage":  { "url": "...aarch64.AppImage", "signature": "..." },
    "linux-aarch64-deb":       { "url": "...arm64.deb",        "signature": "..." },

    "darwin-aarch64":          { "url": "...app.tar.gz",       "signature": "..." }
  }
}
```

Why the bare `linux-{arch}` fallback stays: the plugin uses it when the binary's bundle type is unknown (`__TAURI_BUNDLE_TYPE` empty — happens for binaries built outside the Tauri bundler). Pointing it at AppImage matches today's behavior so we don't regress anyone running such a binary.

The order in which the plugin tries lookups (`{os}-{arch}-{installer}` first, `{os}-{arch}` second) means deb users get the deb URL, AppImage users get the AppImage URL, unknown-type fallback gets AppImage. No changes needed in any client binary — older v1.x clients with `__TAURI_BUNDLE_TYPE = Deb` baked in will resolve `linux-x86_64-deb` from a v1.1.3 manifest and update cleanly.

## 7. Signing the `.deb` files

Tauri's bundler signs the AppImage and macOS updater artifacts automatically when `TAURI_SIGNING_PRIVATE_KEY` is in the env, but it does **not** sign `.deb` files (the `.deb.sig` you'd expect doesn't appear in `target/.../bundle/deb/`). We sign manually after the bundler runs:

```bash
# In the Linux build job, after "Build release binary + installer bundles"
sudo apt-get install -y minisign     # already on ubuntu-latest? verify in CI

BUNDLE_DIR="target/${{ matrix.target }}/release/bundle"
DEB_DIR="$BUNDLE_DIR/deb"
if [ -d "$DEB_DIR" ]; then
  for deb in "$DEB_DIR"/*.deb; do
    [ -f "$deb" ] || continue
    # -t comment matches the convention Tauri uses on its sigs:
    # `file:<basename>` — keeps the trusted-comment human-readable.
    minisign -S \
      -s <(printf '%s' "${TAURI_SIGNING_PRIVATE_KEY}") \
      -t "file:$(basename "$deb")" \
      -m "$deb" \
      -x "${deb}.sig"
  done
fi
```

Notes:
- `TAURI_SIGNING_PRIVATE_KEY` is the same secret Tauri's bundler uses for the AppImage and macOS sigs — single source of truth.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is also exported by the existing build step. minisign prompts for a passphrase via stdin if needed; pass it via `MINISIGN_PASSWORD` env or a here-string. Confirmed by minisign manpage: when `-s` is a file containing an encrypted key, the passphrase is read from `tty` by default — we pipe it from the env to avoid the tty prompt.
- The signature format minisign produces is identical to what Tauri produces for the AppImage/macOS sigs, so the updater plugin's verification path doesn't care which side made the signature — it just verifies against the public key embedded in `tauri.conf.json`.

## 8. macOS specifics

Matrix entry change in the workflow:

```yaml
# Before
- name: macos-aarch64
  os: macos-latest
  target: aarch64-apple-darwin
  bin_name: ezterm
  bundles: ""        # → cargo build --release path; no .app produced

# After
- name: macos-aarch64
  os: macos-latest
  target: aarch64-apple-darwin
  bin_name: ezterm
  bundles: "app"     # → cargo tauri build --bundles app; produces .app + .app.tar.gz + .sig
```

The build step's branch (`if [ -n "${{ matrix.bundles }}" ]; then cargo tauri build ... else cargo build ... fi`) doesn't need changes — flipping `bundles` to non-empty puts macOS on the same `cargo tauri build` path as Linux/Windows.

The portable tar.xz packaging step already copies `target/<target>/release/${bin_name}` into the stage dir. With `cargo tauri build`, the raw binary still ends up at that path, so the portable artifact keeps working.

`createUpdaterArtifacts: true` in `tauri.conf.json` (already set) makes Tauri produce the `.app.tar.gz` and sign it. No tauri.conf.json changes required.

## 9. Sanity-check step

After the manifest builder, before creating the release, add a step that asserts every URL referenced in `latest.json` corresponds to a file in `artifacts/`. Catches this class of bug (manifest pointing at a file that wasn't uploaded) at CI time, not at user-update time.

```bash
# In the release job, between "Generate latest.json" and "Create draft release"
- name: Verify manifest URLs resolve to uploaded assets
  working-directory: artifacts
  run: |
    set -euo pipefail
    [ -f latest.json ] || { echo "no latest.json — skipping verify"; exit 0; }
    missing=()
    while IFS= read -r url; do
      asset="${url##*/}"
      if [ ! -f "$asset" ]; then
        missing+=("$asset")
      fi
    done < <(jq -r '.platforms | to_entries[] | .value.url' latest.json)
    if [ ${#missing[@]} -gt 0 ]; then
      echo "::error::manifest references missing assets: ${missing[*]}"
      exit 1
    fi
    echo "All manifest URLs resolve to uploaded assets."
```

This is the load-bearing safety net — if the manifest builder, asset collector, and release-create step ever drift again (which is what produced the current bug), CI will fail the release before tagging instead of shipping a broken `latest.json`.

## 10. Edge cases

- **Signing secret missing** (e.g. PR build, fork): the existing `if [ ! -f "$sig_file" ]; then continue` logic in the manifest builder already skips unsigned entries. With this change, unsigned debs simply don't get a `linux-{arch}-deb` entry, falling back to the bare `linux-{arch}` entry. macOS without a sig wouldn't get a `darwin-aarch64` entry. Same graceful degradation.
- **`infer` crate version drift**: the plugin's `is_deb()` check needs the right magic bytes. `dpkg-deb`-produced files match. No action needed unless a new Tauri bundler version changes deb internals.
- **macOS user installs the v1.1.3 .app, then updates to v1.1.4**: the plugin downloads `.app.tar.gz`, untars to a temp dir, atomically swaps `.app` bundles. Standard Tauri flow — works as long as the user has write access to the `.app`'s parent dir (which they do for `~/Applications` and most `/Applications` installs).
- **Existing v1.1.0–v1.1.2 macOS users**: there's no install for them today (their build was a raw binary, not a `.app`). They'd be running the binary directly out of the portable tar.xz. Their `__TAURI_BUNDLE_TYPE` is empty → falls back to `darwin-aarch64` lookup → updates to the v1.1.3 `.app.tar.gz`. The first update is their migration to the proper `.app` bundle. Expected behavior.
- **Pre-v1.1.3 deb users on Ubuntu locked-down systems**: `dpkg -i` may fail without sudo. Plugin will surface the error to the user. Not regressed from current state (currently fails with `InvalidUpdaterFormat`); just changes which step fails. If this becomes a real complaint, follow-up ticket adds polkit/pkexec elevation.

## 11. Testing

No automated tests for CI workflows in this repo. Verification is:

- **CI dry-run on the PR branch**: push the branch, observe the workflow runs (without a tag) — won't actually create a release but will exercise the build/sign/collect/manifest-build/sanity-check steps. Look for the new sanity-check step to pass.
- **Tagged release verification**: after merge, push tag `v1.1.3`. Workflow runs end-to-end. Manually inspect the published `latest.json`:
  ```bash
  curl -sL https://github.com/ZerosAndOnesLLC/ezTerm/releases/download/v1.1.3/latest.json | jq .platforms
  ```
  Confirm 7 platform entries (windows-x86_64, linux-{x86_64,aarch64}{,-appimage,-deb}, darwin-aarch64).
- **End-to-end deb update test** (the load-bearing manual test): on the Ubuntu install where the bug was reported, hit "Check for updates" in v1.0.0 deb. Update should download `ezTerm_1.1.3_amd64.deb`, install via `dpkg`, and relaunch into v1.1.3. If `dpkg` requires elevation and the prompt isn't surfaced, document and open a follow-up.
- **AppImage non-regression**: existing v1.0.0 AppImage users (or a fresh v1.0.0 AppImage install) hit "Check for updates" — should still update via the AppImage path (now `linux-x86_64-appimage` instead of bare `linux-x86_64`, but the artifact and behavior are identical).
- **macOS first-time auto-update test**: on Apple Silicon, install the v1.1.3 `.app` from the release page, then later when v1.1.4 ships, in-app updater should offer it. (Cannot fully test until the next release exists; v1.1.3 establishes the baseline.)

## 12. Workflow

1. Spec committed (this file)
2. Implementation plan
3. Branch + fix (`fix/updater-deb-and-macos`)
4. PR (`Closes #36`)
5. Four parallel review agents (perf, security, completeness, code quality)
6. Findings presented to user — user decides per-item what to action
7. Merge + tag v1.1.3 + release notes
