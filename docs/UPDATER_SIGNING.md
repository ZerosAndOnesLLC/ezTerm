# Updater signing — one-time setup

ezTerm's auto-updater (`tauri-plugin-updater`) requires every update
artifact to be signed so clients can't be tricked into installing a
tampered binary. This is a **one-time** setup per project. Until it's
done, `"active": false` in `tauri.conf.json` keeps the plugin disabled
so the app still boots.

## 1. Install minisign

Tauri's updater uses the minisign format. Any recent minisign binary
works.

- Windows (winget): `winget install minisign.minisign`
- Windows (scoop): `scoop install minisign`
- macOS: `brew install minisign`
- Linux: `apt install minisign` / `dnf install minisign`

Alternatively, Tauri's CLI can generate a key without installing
minisign separately:

```bash
cargo install tauri-cli --version '^2.0' --locked   # already installed for this project
cargo tauri signer generate -w ~/.tauri/ezterm.key
```

That writes `~/.tauri/ezterm.key` (private) and `~/.tauri/ezterm.key.pub`
(public) and prompts for an optional password.

**Pick a password** — no password means anyone with the file can sign
releases.

## 2. Paste the public key into `tauri.conf.json`

Open `~/.tauri/ezterm.key.pub` — it contains a single long base64-ish line
like:

```
untrusted comment: minisign public key ABCD...
RWQ... (one long line)
```

The actual key is the **second line**. Copy it and replace the
placeholder in `src-tauri/tauri.conf.json`:

```jsonc
"plugins": {
  "updater": {
    "active": true,                                // flip to true
    "pubkey": "RWQ... (second line from .pub)"    // paste here
    // ...
  }
}
```

Commit both changes.

## 3. Add the private key + password as GitHub Secrets

Settings → Secrets and variables → Actions → **New repository secret**:

| Name | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | entire contents of `~/.tauri/ezterm.key` (including `untrusted comment:` lines) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the password you set at generation |

The release workflow reads both at build time and passes them to
`cargo tauri build`, which produces `.sig` files alongside every
installer automatically.

## 4. Verify

Push a new tag after the secrets are set. The release workflow should:

1. Build MSI + NSIS (Windows) / AppImage + deb (Linux).
2. Emit `.sig` files next to each installer.
3. Generate `latest.json` with the signature strings embedded.
4. Upload all of the above plus the portable `.tar.xz` archives.

The app, once rebuilt with `"active": true`, then checks the
`latest.json` manifest on launch (and on-demand via the Check-for-Updates
menu), downloads the matching installer, verifies its signature against
the public key baked into the binary, and relaunches into the new
version.

## Rotating the key

If the private key is ever compromised:

1. Generate a new keypair (step 1).
2. Replace the public key in `tauri.conf.json` (step 2).
3. Replace the GitHub Secrets (step 3).
4. Ship a release signed with the NEW key.

**Caveat:** any user running a version of ezTerm built with the OLD
public key won't accept updates signed with the new key — they'll have
to download the new version manually (via the Releases page). Plan key
rotation carefully; treat the private key like any other secret.
