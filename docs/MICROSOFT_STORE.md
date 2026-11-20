# Microsoft Store

ezTerm is published to the Microsoft Store as an **MSIX** package. The Store
signs the package during certification, so no code-signing certificate is
needed, and Store users get updates from the Store automatically.

## How the Store build differs

The MSIX contains the same `ezterm.exe` as the GitHub release. At runtime
the app checks whether it has MSIX package identity
(`GetCurrentPackageFullName`, see `src-tauri/src/packaging.rs`) and reports
its install channel through the `install_channel` command:

| | GitHub install (`direct`) | Store install (`store`) |
|---|---|---|
| Updates | Built-in updater (`tauri-plugin-updater`) | Microsoft Store |
| Update button, Settings → Updates | Shown | Hidden |
| `updater_check` / `updater_download_install` | Work | Refused by the backend |
| VcXsrv | Bundled, or the in-app "Install VcXsrv" download | Bundled in the package; the download flow is refused |

Store policy doesn't allow an MSIX app to replace its own files or to
download and run executables, which is why both of those paths are turned off.

User data lives in `%LOCALAPPDATA%\ZerosAndOnes\ezTerm\data` like every
other install. Windows redirects a packaged app's writes there into the
package's own storage, and removes that storage when the app is uninstalled.

## Files

| Path | Purpose |
|---|---|
| `src-tauri/msix/AppxManifest.xml` | Package manifest. `{{VERSION}}` is filled in at pack time. |
| `src-tauri/msix/Assets/` | Tile and logo images (scale-100/200 and taskbar target sizes). |
| `scripts/msix/generate-assets.ps1` | Regenerates `Assets/` from `src-tauri/icons/icon.png`. |
| `scripts/msix/build-msix.ps1` | Stages the layout, builds `resources.pri`, and runs `makeappx pack`. |

`release.yml` runs `build-msix.ps1` on the Windows job and uploads
`ezTerm_<version>_windows-x64.msix` with the other release assets.

## Package identity

| | |
|---|---|
| Store ID | `9P8DPZ98QJS5` |
| Store page | https://apps.microsoft.com/detail/9P8DPZ98QJS5 (live after the first certification) |
| Package family name | `ZerosandOnesLLC.ezTerm_9nt2pr4qw8ade` |

The name was reserved on 2026-11-20. Partner Center drops a reservation
that has no submission within three months, so the first submission must
go in by 2027-02-20.

The `Identity` element (`Name`, `Publisher`) and `PublisherDisplayName` in
the manifest must exactly match the values Partner Center shows under
**Product management → Product identity**:

| Partner Center field | Manifest attribute |
|---|---|
| Package/Identity/Name | `Identity/@Name` |
| Package/Identity/Publisher | `Identity/@Publisher` |
| Package/Properties/PublisherDisplayName | `Properties/PublisherDisplayName` |

A mismatch makes the package upload fail validation.

## Building locally

Needs the Windows 10/11 SDK (it provides `makeappx.exe` and `makepri.exe`).

```powershell
cargo tauri build --no-bundle
./scripts/msix/build-msix.ps1 -Version 1.16.0 `
  -ExePath target/release/ezterm.exe `
  -VcxsrvDir src-tauri/vcxsrv `
  -OutFile target/msix/ezTerm_1.16.0_windows-x64.msix
```

The version must be plain `MAJOR.MINOR.PATCH`. The script appends `.0`
because the Store requires the fourth part to be zero.

To smoke-test without signing, turn on **Developer Mode** and register the
unpacked layout. The app then runs with package identity, just as a Store
install does:

```powershell
Add-AppxPackage -Register <layout>\AppxManifest.xml
```

## Submitting a release

1. Promote the release as usual (see [RELEASING.md](RELEASING.md)).
2. Download `ezTerm_<version>_windows-x64.msix` from the GitHub release.
3. In Partner Center, open ezTerm and choose **Start update** (or **Start
   submission** the first time).
4. **Packages:** upload the `.msix`. Partner Center validates the identity
   and version, and each submission needs a higher version than the last.
5. Update **Store listings** if needed (for example, "What's new in this
   version" from `docs/release-notes/v<version>.md`).
6. **Submit to the Store.** Certification usually takes a few hours to
   three business days.

### First submission only

- **Pricing and availability:** Free, all markets.
- **Properties:** category *Developer tools*. Privacy policy:
  `https://ezterm.zerosandones.us/privacy/`. Website:
  `https://ezterm.zerosandones.us/`. Support: the GitHub issues page.
- **Age ratings:** complete the IARC questionnaire (a developer tool with
  no user-generated content or online interaction between users).
- **Restricted capability `runFullTrust`:** explain why it's needed, e.g.
  *"ezTerm is a desktop SSH client built as a Win32 app. It launches local
  shells (cmd, PowerShell, WSL) and a bundled X server (VcXsrv) for X11
  forwarding."*
- **Store listing:** description and at least one screenshot (1366×768 or
  larger). The Store takes the app icon from the package's logos.
- **Notes for certification:** testers need an SSH server to connect to.
  Mention that the app opens on a master-password setup screen and that
  local shell tabs (PowerShell, cmd) work without a server.
