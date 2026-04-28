# Updater fix (deb + macOS) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make in-app auto-update work for Linux .deb installs and macOS aarch64. Workflow-only fix; no Rust/UI changes.

**Architecture:** All changes are in `.github/workflows/release.yml`. (1) macOS matrix entry switches from `bundles: ""` (raw binary) to `bundles: "app"` (Tauri bundle target). (2) New step on Linux jobs signs each `.deb` with minisign using `TAURI_SIGNING_PRIVATE_KEY`. (3) Per-job collect glob extended to grab `.deb.sig`, `.app.tar.gz`, `.app.tar.gz.sig`. (4) Release job's manifest builder rewritten to emit per-installer entries plus a fallback. (5) New sanity-check step asserts every manifest URL resolves to an uploaded asset before tagging. (6) Release-create asset list extended for the new files.

**Tech Stack:** GitHub Actions (bash), Tauri 2 bundler, `minisign`, `jq`. No new dependencies in the project; minisign installed in CI via `apt`.

**Spec:** `docs/superpowers/specs/2026-04-28-updater-deb-and-macos-design.md`
**Tracking issue:** https://github.com/ZerosAndOnesLLC/ezTerm/issues/36
**Branch:** `fix/updater-deb-and-macos` (already created, spec already committed)

**Note on testing:** No automated tests for CI workflows in this repo. Verification is the post-tag manual smoke covered in spec §11. Within this plan, every step that changes the workflow is followed by a YAML lint via `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))"` so syntax errors are caught locally.

---

## File Map

| Path | Why |
|------|-----|
| `.github/workflows/release.yml` | All workflow changes — matrix, build step, collect glob, manifest builder, sanity-check, release-create asset list |
| `docs/release-notes/v1.1.3.md` | Release notes for the patch |
| `Cargo.toml` | Bump `1.1.2` → `1.1.3` |

No new files outside the spec/plan. No deletions.

---

## Task 1: macOS matrix — produce a `.app` bundle

Switches macos-aarch64 from `cargo build --release` (raw binary) to `cargo tauri build --bundles app` (produces `.app`, `.app.tar.gz`, `.app.tar.gz.sig`). The build-mode branch in the existing "Build release binary + installer bundles" step already routes to `cargo tauri build` whenever `matrix.bundles` is non-empty, so flipping the matrix value is sufficient.

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Edit the matrix entry**

In `.github/workflows/release.yml`, find the macos-aarch64 matrix entry (around line 41-45):

```yaml
          - name: macos-aarch64
            os: macos-latest
            target: aarch64-apple-darwin
            bin_name: ezterm
            bundles: ""
```

Change `bundles: ""` to `bundles: "app"`:

```yaml
          - name: macos-aarch64
            os: macos-latest
            target: aarch64-apple-darwin
            bin_name: ezterm
            bundles: "app"
```

Also update the comment on the build step (lines ~144-147) to reflect the new behavior. Find:

```yaml
      # Two build modes. Platforms with bundles (Windows / Linux) go
      # through `cargo tauri build` so the installer bundler runs;
      # macOS currently stays on the lighter `cargo build` path since
      # we don't ship DMG / notarised .app yet.
```

Replace with:

```yaml
      # Two build modes. Platforms with bundles (Windows / Linux / macOS)
      # go through `cargo tauri build` so the installer bundler runs and
      # produces the updater artifacts (.app.tar.gz on macOS, .AppImage
      # on Linux, .msi/.exe on Windows). The .app is ad-hoc-signed; we
      # don't notarise yet, so first launch needs right-click → Open.
```

- [ ] **Step 2: YAML-lint**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))"
```

Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci(release): build .app bundle on macOS for the updater

Switch the macos-aarch64 matrix entry from bundles:'' (cargo build
--release path, raw binary only) to bundles:'app' (cargo tauri build
--bundles app). Tauri now produces .app, .app.tar.gz, and the matching
.app.tar.gz.sig — what the updater plugin needs on macOS.

Build is ad-hoc-signed (no Apple Developer ID); first launch needs
right-click → Open. Auto-update works regardless."
```

---

## Task 2: Sign `.deb` files with minisign in CI

Tauri's bundler doesn't sign debs. We sign manually after the bundler runs, using the same `TAURI_SIGNING_PRIVATE_KEY` Tauri uses for the AppImage and macOS sigs. Only fires on Linux jobs.

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Add the signing step after "Build release binary + installer bundles"**

In `.github/workflows/release.yml`, find the "Build release binary + installer bundles" step (ends around line 159 with the closing `fi` of the build-mode if-else). Immediately after it (before "Package portable tar.xz + collect installers"), insert:

```yaml
      # Tauri's bundler signs the AppImage and macOS .app.tar.gz
      # automatically when TAURI_SIGNING_PRIVATE_KEY is set, but it
      # does NOT sign .deb files. Sign them here with the same key so
      # the updater plugin can verify them on Linux deb installs.
      # Linux-only step (deb is only produced on Linux targets).
      - name: Sign .deb files (Linux only)
        if: runner.os == 'Linux' && matrix.bundles != ''
        env:
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        shell: bash
        run: |
          set -euo pipefail
          if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
            echo "::warning::TAURI_SIGNING_PRIVATE_KEY not set — skipping .deb signing"
            exit 0
          fi
          sudo apt-get install -y minisign
          BUNDLE_DIR="target/${{ matrix.target }}/release/bundle"
          DEB_DIR="$BUNDLE_DIR/deb"
          if [ ! -d "$DEB_DIR" ]; then
            echo "no deb bundle dir at $DEB_DIR — nothing to sign"
            exit 0
          fi
          # Stage the secret key to a real file so minisign can mmap it.
          # The shell substitution syntax used elsewhere doesn't survive
          # minisign's reopen-on-EOF behavior on a process substitution.
          KEY_FILE=$(mktemp)
          chmod 600 "$KEY_FILE"
          printf '%s' "${TAURI_SIGNING_PRIVATE_KEY}" > "$KEY_FILE"
          # Match the trusted-comment style Tauri uses on its own sigs:
          # `timestamp:<unix>\tfile:<basename>` — keeps verification logs
          # human-readable and consistent across artifacts.
          for deb in "$DEB_DIR"/*.deb; do
            [ -f "$deb" ] || continue
            base=$(basename "$deb")
            ts=$(date +%s)
            # Pipe the password to minisign's stdin so it doesn't try a
            # tty prompt. The -W (no password) shortcut would only work
            # if the key is unencrypted, which Tauri's keys are not.
            printf '%s\n' "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" \
              | minisign -S \
                  -s "$KEY_FILE" \
                  -t "timestamp:${ts}	file:${base}" \
                  -m "$deb" \
                  -x "${deb}.sig"
            echo "signed: ${deb}.sig"
          done
          rm -f "$KEY_FILE"
```

Notes for the implementer:
- The literal tab character in the `-t` value is intentional — Tauri's signature comments use `timestamp:N\tfile:NAME` and the plugin's signature verification doesn't care, but our sanity-check / human inspection benefits from matching the convention. Writing this in YAML is fine; the shell script uses a literal tab (the `	` between `${ts}` and `file:`).
- `apt-get install minisign` works on `ubuntu-latest` and `ubuntu-24.04-arm` runners. Both have the package in their default repos.

- [ ] **Step 2: YAML-lint**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))"
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci(release): sign .deb files with minisign

Tauri's bundler signs AppImage and macOS updater artifacts but not
.deb. Sign manually after the bundler runs using the same
TAURI_SIGNING_PRIVATE_KEY. Linux-only; bails cleanly if the secret
isn't set (PR builds, forks). Stages the secret to a real file (not
a process substitution) so minisign's mmap-on-reopen path works,
then chmod 600 and removes it on completion."
```

---

## Task 3: Extend the per-job collect glob

The "Package portable tar.xz + collect installers" step has a `find ... -name '*.AppImage' ...` that copies bundles into `installers/` for upload. Extend it to grab the new files: `*.deb.sig`, `*.app.tar.gz`, `*.app.tar.gz.sig`.

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Edit the find clause**

In `.github/workflows/release.yml`, find the existing find expression (around line 187-194):

```yaml
            find "$BUNDLE_DIR" -maxdepth 2 \( \
              -name '*.msi' -o -name '*.msi.sig' -o \
              -name '*-setup.exe' -o -name '*-setup.exe.sig' -o \
              -name '*.nsis.zip' -o -name '*.nsis.zip.sig' -o \
              -name '*.AppImage' -o -name '*.AppImage.sig' -o \
              -name '*.deb' \
              \) -print0 | xargs -0 -I {} cp -v {} installers/ || true
```

Replace with:

```yaml
            find "$BUNDLE_DIR" -maxdepth 2 \( \
              -name '*.msi' -o -name '*.msi.sig' -o \
              -name '*-setup.exe' -o -name '*-setup.exe.sig' -o \
              -name '*.nsis.zip' -o -name '*.nsis.zip.sig' -o \
              -name '*.AppImage' -o -name '*.AppImage.sig' -o \
              -name '*.deb' -o -name '*.deb.sig' -o \
              -name '*.app.tar.gz' -o -name '*.app.tar.gz.sig' \
              \) -print0 | xargs -0 -I {} cp -v {} installers/ || true
```

(Two new globs added: `*.deb.sig` and `*.app.tar.gz`/`.sig`.)

- [ ] **Step 2: YAML-lint**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))"
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci(release): collect .deb.sig and .app.tar.gz(.sig) for upload

Extend the find glob in the per-job collect step so the manually-signed
.deb sigs and the macOS updater .app.tar.gz + .sig produced by Tauri's
bundler land in installers/ for the release job to pick up."
```

---

## Task 4: Rewrite the manifest builder

Emit per-installer entries: `linux-x86_64-appimage`, `linux-x86_64-deb`, `linux-aarch64-appimage`, `linux-aarch64-deb`, `darwin-aarch64`. Keep bare `linux-x86_64` and `linux-aarch64` (pointing at AppImage) as fallback for unknown bundle types.

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Replace the manifest-builder pair list and add new platforms**

In `.github/workflows/release.yml`, find the "Generate latest.json updater manifest" step's `for pair in ... ; do` block (around line 264-268):

```yaml
          for pair in \
            "windows-x86_64:*-setup.exe" \
            "linux-x86_64:*_amd64.AppImage" \
            "linux-aarch64:*_aarch64.AppImage" \
          ; do
```

Replace with the expanded list:

```yaml
          # Per-installer entries (linux-{arch}-{installer}, darwin-aarch64)
          # are what the plugin's get_urls() looks up first based on the
          # binary's __TAURI_BUNDLE_TYPE constant. The bare linux-{arch}
          # entries are kept as a fallback for binaries with an unknown
          # bundle type (e.g., builds outside the Tauri bundler).
          for pair in \
            "windows-x86_64:*-setup.exe" \
            "linux-x86_64-appimage:*_amd64.AppImage" \
            "linux-x86_64-deb:*_amd64.deb" \
            "linux-x86_64:*_amd64.AppImage" \
            "linux-aarch64-appimage:*_aarch64.AppImage" \
            "linux-aarch64-deb:*_arm64.deb" \
            "linux-aarch64:*_aarch64.AppImage" \
            "darwin-aarch64:*.app.tar.gz" \
          ; do
```

Notes:
- Glob `*_arm64.deb` matches the Tauri bundler's deb naming for aarch64 (e.g. `ezTerm_1.1.3_arm64.deb`).
- Glob `*.app.tar.gz` matches the macOS updater artifact (e.g. `ezTerm.app.tar.gz`). Only one such file should exist per release; `head -n1` in the existing `installer=$(ls $glob ... | head -n1)` handles it.
- The fallback `linux-x86_64` / `linux-aarch64` entries are listed *after* their `-installer` siblings so the entries object's iteration order in the resulting JSON is human-friendly. The plugin doesn't care about order.

The rest of the loop body (the existing sig lookup, signature embedding, JSON emission) is unchanged — it works as-is for the new entries.

- [ ] **Step 2: YAML-lint**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))"
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci(release): emit per-installer manifest entries + macOS

Tauri's updater plugin looks up platforms[\"linux-{arch}-{installer}\"]
first based on the binary's __TAURI_BUNDLE_TYPE constant, then falls
back to platforms[\"linux-{arch}\"]. Old manifest only had the bare
linux-{arch} entries (pointing at AppImage), so deb users got the
AppImage URL → install_deb(bytes) → infer::is_deb fails →
InvalidUpdaterFormat.

Add linux-{x86_64,aarch64}-{appimage,deb} and darwin-aarch64 entries.
Keep bare linux-{arch} as fallback for unknown bundle types.

Closes #36."
```

---

## Task 5: Add the manifest-vs-uploads sanity-check step

After the manifest is built and before the release is created, assert that every URL in `latest.json` resolves to a file in `artifacts/`. If any URL points at a missing asset, fail the release.

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Insert the new step between "Generate latest.json" and "Create draft release"**

In `.github/workflows/release.yml`, after the "Generate latest.json updater manifest" step (which ends around line 298 with `cat latest.json`), and before "Create draft release" (around line 300), insert:

```yaml
      # Cross-check: every URL in latest.json must resolve to a file in
      # artifacts/. Catches cases where the manifest builder, asset
      # collector, and release-create asset list drift apart — exactly
      # the failure mode that produced #36 (manifest pointed at
      # AppImage, deb users tried to install_deb(AppImage_bytes)).
      - name: Verify manifest URLs resolve to uploaded assets
        working-directory: artifacts
        run: |
          set -euo pipefail
          if [ ! -f latest.json ]; then
            echo "no latest.json — nothing to verify"
            exit 0
          fi
          missing=()
          while IFS= read -r url; do
            asset="${url##*/}"
            if [ ! -f "$asset" ]; then
              missing+=("$asset")
            fi
          done < <(jq -r '.platforms | to_entries[] | .value.url' latest.json)
          if [ "${#missing[@]}" -gt 0 ]; then
            echo "::error::manifest references missing assets: ${missing[*]}"
            echo "--- latest.json ---"
            cat latest.json
            echo "--- artifacts/ ---"
            ls -la
            exit 1
          fi
          echo "✓ all $(jq '.platforms | length' latest.json) manifest URLs resolve"
```

- [ ] **Step 2: YAML-lint**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))"
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci(release): assert latest.json URLs resolve before tagging

Cross-check step between the manifest builder and the release-create
step: parse latest.json, walk every platforms[*].url, assert each
basename exists in artifacts/. Fail the release if any are missing.

This is the safety net that would have caught #36 at CI time instead
of at user-update time. The class of bug — manifest pointing at an
asset that wasn't uploaded — is exactly what this guards against."
```

---

## Task 6: Extend the release-create asset list

The "Create draft release" step has a hand-maintained list of asset patterns that it uploads. Extend it to include `*.deb.sig`, `*.app.tar.gz`, and `*.app.tar.gz.sig`.

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Edit the for loop in "Create draft release"**

In `.github/workflows/release.yml`, find the for loop (around line 309-314):

```yaml
          for f in artifacts/*.msi artifacts/*.msi.sig \
                   artifacts/*-setup.exe artifacts/*-setup.exe.sig \
                   artifacts/*.AppImage artifacts/*.AppImage.sig \
                   artifacts/*.deb \
                   artifacts/latest.json; do
            [ -f "$f" ] && ASSETS="$ASSETS $f"
          done
```

Replace with:

```yaml
          for f in artifacts/*.msi artifacts/*.msi.sig \
                   artifacts/*-setup.exe artifacts/*-setup.exe.sig \
                   artifacts/*.AppImage artifacts/*.AppImage.sig \
                   artifacts/*.deb artifacts/*.deb.sig \
                   artifacts/*.app.tar.gz artifacts/*.app.tar.gz.sig \
                   artifacts/latest.json; do
            [ -f "$f" ] && ASSETS="$ASSETS $f"
          done
```

- [ ] **Step 2: YAML-lint**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))"
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci(release): include .deb.sig + .app.tar.gz(.sig) in upload list

Pair with the new manifest-builder entries and collect-glob extension:
the release-create step's hand-maintained asset list now includes the
new sig files and the macOS updater archive. Without this the sanity-
check step (added in the previous commit) would fail the release."
```

---

## Task 7: Bump version + write release notes

**Files:**
- Modify: `Cargo.toml`
- Create: `docs/release-notes/v1.1.3.md`

- [ ] **Step 1: Bump Cargo.toml**

Edit `Cargo.toml` line 6: `1.1.2` → `1.1.3`.

- [ ] **Step 2: Create release notes**

Create `docs/release-notes/v1.1.3.md`:

```markdown
# ezTerm v1.1.3

Patch: in-app auto-update now works on Linux .deb installs and on macOS. Previously, deb users hit "Invalid updater binary format" when checking for updates, and macOS auto-update wasn't wired up at all.

## What was wrong

The Tauri updater plugin asks the running binary which installer it was distributed as (deb / AppImage / msi / nsis / app), looks up `latest.json`'s `platforms["{os}-{arch}-{installer}"]` entry, and downloads from there. Our manifest only had the bare `{os}-{arch}` entries pointing at AppImage URLs — so a .deb-installed binary downloaded an AppImage and tried to install it as a deb, which fails fast.

macOS users had no entry at all because the release workflow built only a raw binary on macOS, no `.app` bundle.

## The fix

The release workflow now:

- Signs every `.deb` with the same minisign key Tauri uses for the AppImage and macOS sigs
- Builds a proper `.app` bundle on macOS (alongside the existing portable tar.xz)
- Emits per-installer entries in `latest.json`: `linux-x86_64-appimage`, `linux-x86_64-deb`, `linux-aarch64-appimage`, `linux-aarch64-deb`, `darwin-aarch64`
- Keeps the bare `linux-x86_64` / `linux-aarch64` entries as a fallback for binaries with an unknown bundle type
- Has a CI sanity-check that asserts every manifest URL resolves to an uploaded asset before tagging the release — so this class of drift can't reach users again

## Impact on existing installs

Hit "Check for updates" in your existing v1.0.0+ binary:

- **Windows NSIS** — same as before (already worked)
- **Linux AppImage** — same as before (URL just moved from `linux-x86_64` to `linux-x86_64-appimage`; both now point at the AppImage)
- **Linux .deb** — now works for the first time; downloads `*_amd64.deb`, installs via `dpkg`. Note: on locked-down installs `dpkg -i` may need elevation; if the update fails with a permission error, install the .deb manually one time with `sudo dpkg -i`
- **macOS aarch64** — auto-update offered for the first time. The .app is ad-hoc-signed (no Apple Developer ID); first launch needs right-click → Open

## Verify

```bash
sha256sum -c SHA256SUMS
```

## Licence

**GPL v3** (version 3 only). See [LICENSE](../blob/main/LICENSE).
```

- [ ] **Step 3: Run final checks**

```bash
cargo check 2>&1 | tail -5
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))"
```

`cargo check` should be clean (no Rust changes; one pre-existing dead-code warning in `xserver/mod.rs` is unrelated). YAML lint should be silent.

- [ ] **Step 4: Commit**

```bash
git add Cargo.toml Cargo.lock docs/release-notes/v1.1.3.md
git commit -m "chore: bump version 1.1.2 → 1.1.3 + release notes

Patch release. In-app updater works for Linux .deb installs and
macOS aarch64 (was broken / missing). All workflow-only fixes."
```

---

## Task 8: Push, open PR, run four reviewers

- [ ] **Step 1: Push the branch**

```bash
git push -u origin fix/updater-deb-and-macos
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --title "fix(release): updater works for Linux .deb and macOS" --body "$(cat <<'EOF'
Closes #36

## Summary
The Tauri updater plugin keys its asset lookup on the binary's bundled installer type. Our \`latest.json\` only had bare \`linux-{arch}\` entries pointing at AppImage URLs, so deb-installed binaries downloaded an AppImage and tried to install it as a deb (\`InvalidUpdaterFormat\`). macOS had no entry at all because the workflow built a raw binary instead of a \`.app\`.

This PR is workflow-only:
- Sign every \`.deb\` with minisign in CI using the existing \`TAURI_SIGNING_PRIVATE_KEY\`
- Build a \`.app\` on macOS (\`bundles: \"app\"\` via \`cargo tauri build\`) so Tauri produces \`.app.tar.gz\` + sig
- \`latest.json\` emits per-installer entries: \`linux-{x86_64,aarch64}-{appimage,deb}\` plus \`darwin-aarch64\`. Bare \`linux-{arch}\` kept as fallback
- Asset upload + release-create globs include the new sig files
- New sanity-check step asserts every manifest URL resolves to an uploaded asset before tagging

No Rust or UI changes. Cuts as v1.1.3.

- Spec: \`docs/superpowers/specs/2026-04-28-updater-deb-and-macos-design.md\`
- Plan: \`docs/superpowers/plans/2026-04-28-updater-deb-and-macos.md\`

## Test plan (manual, post-tag)
- [ ] Tag v1.1.3, observe workflow completes including the new sanity-check step
- [ ] \`curl -sL https://github.com/ZerosAndOnesLLC/ezTerm/releases/download/v1.1.3/latest.json | jq .platforms\` shows 7 entries
- [ ] On the Ubuntu deb install where #36 was reported: hit \"Check for updates\" in v1.0.0; should download v1.1.3 deb and install
- [ ] On a Linux AppImage install: hit \"Check for updates\"; should still update (now via \`linux-x86_64-appimage\` entry)
- [ ] On macOS aarch64: install the v1.1.3 \`.app\`; verify in-app updater is wired up (will offer the next release when one ships)
- [x] YAML lint clean (\`python3 -c \"import yaml; yaml.safe_load(open('.github/workflows/release.yml'))\"\`)
- [x] \`cargo check\` clean
EOF
)"
```

- [ ] **Step 3: Launch four parallel review agents (single message, parallel)**

Dispatch performance, security, completeness, and code-quality reviewers in one message. Each gets the PR URL, the spec path, the diff range (`main..fix/updater-deb-and-macos`), and a tight scope statement. **When findings come back: present them grouped by severity to the user; do not auto-apply.** Wait for per-finding direction.

---

## Self-Review

Spec coverage check:
- §3 background → in scope of the PR description and addressed by Tasks 4–6
- §4 architecture (5 logical changes) → mapped 1:1 to Tasks 1, 2, 3, 4 (manifest+macOS), 5, 6
- §5 bundles per platform table → Task 1 (macOS) + Task 2 (deb signing) + existing behavior preserved
- §6 manifest schema → Task 4 (entries match the table exactly)
- §7 deb signing → Task 2 (key staging via temp file matches spec rationale)
- §8 macOS specifics → Task 1 (matrix + comment update; no other changes needed since `createUpdaterArtifacts: true` is already in `tauri.conf.json` and the build-mode if-else already routes via `cargo tauri build` when bundles is non-empty)
- §9 sanity-check step → Task 5 (script matches spec verbatim)
- §10 edge cases → handled by the existing `if [ ! -f sig_file ]; then continue` (signing-secret-missing) preserved in the manifest builder; macOS first-update migration path is a runtime behavior, not a workflow concern; deb-elevation is documented in release notes (Task 7)
- §11 testing → covered in PR test plan (Task 8) — manual smoke after tag
- §12 workflow → Tasks 7–8 + the global four-reviewer rule

Placeholder scan: no `TBD`/`TODO`. Every code change shows the exact replacement; every command shows the exact invocation and the expected outcome.

Type / shape consistency:
- Tauri's bundle type constants (`__TAURI_BUNDLE_TYPE_VAR_DEB`, etc.) are referenced for context only; we don't touch them.
- Manifest platform keys (`linux-x86_64-appimage`, `linux-x86_64-deb`, `linux-aarch64-appimage`, `linux-aarch64-deb`, `darwin-aarch64`, `windows-x86_64`, `linux-x86_64`, `linux-aarch64`) are spelled identically across spec §6, plan Task 4, and the resulting jq queries in Task 5.
- File naming (`*_amd64.deb`, `*_arm64.deb`, `*.app.tar.gz`, `*.app.tar.gz.sig`, `*.deb.sig`) is consistent across the find glob (Task 3), the manifest builder pair list (Task 4), and the release-create asset list (Task 6).

No drift detected.
