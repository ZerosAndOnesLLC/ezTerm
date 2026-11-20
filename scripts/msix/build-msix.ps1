<#
.SYNOPSIS
  Packs ezTerm into an unsigned MSIX for Microsoft Store submission.

.DESCRIPTION
  Stages ezterm.exe, the bundled VcXsrv tree, and the logo assets into a
  package layout, indexes the scaled assets into resources.pri, and packs
  it with makeappx. The output is deliberately unsigned: the Store signs
  packages during certification.

  VcXsrv sits at vcxsrv\vcxsrv.exe next to ezterm.exe, which is the layout
  xserver::detect_install_path already probes for the portable build.

.EXAMPLE
  ./scripts/msix/build-msix.ps1 -Version 1.16.0 `
    -ExePath target/x86_64-pc-windows-msvc/release/ezterm.exe `
    -VcxsrvDir src-tauri/vcxsrv -OutFile ezTerm_1.16.0_x64.msix
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string]$Version,
  [Parameter(Mandatory)] [string]$ExePath,
  [Parameter(Mandatory)] [string]$OutFile,
  # Optional so the package can be smoke-tested on machines without VcXsrv
  # staged; release builds always pass it.
  [string]$VcxsrvDir
)

$ErrorActionPreference = 'Stop'

# The Store requires a purely numeric four-part version whose last part is 0.
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
  throw "Version '$Version' must be MAJOR.MINOR.PATCH (pre-release builds are not published to the Store)"
}
$msixVersion = "$Version.0"

$repo      = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$msixSrc   = Join-Path $repo 'src-tauri\msix'
$exe       = Resolve-Path $ExePath

# Newest installed Windows SDK that has both packaging tools.
$sdkBin = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } |
  Sort-Object { [version]$_.Name } -Descending |
  ForEach-Object { Join-Path $_.FullName 'x64' } |
  Where-Object { (Test-Path (Join-Path $_ 'makeappx.exe')) -and (Test-Path (Join-Path $_ 'makepri.exe')) } |
  Select-Object -First 1
if (-not $sdkBin) { throw 'Windows SDK with makeappx.exe and makepri.exe not found' }
$makeappx = Join-Path $sdkBin 'makeappx.exe'
$makepri  = Join-Path $sdkBin 'makepri.exe'
Write-Host "Windows SDK tools: $sdkBin"

$work   = Join-Path ([IO.Path]::GetTempPath()) "ezterm-msix-$([guid]::NewGuid().ToString('N'))"
$layout = Join-Path $work 'layout'
$priSrc = Join-Path $work 'pri'
try {
  New-Item -ItemType Directory -Force -Path $layout, $priSrc | Out-Null

  $manifest = (Get-Content (Join-Path $msixSrc 'AppxManifest.xml') -Raw).Replace('{{VERSION}}', $msixVersion)
  [IO.File]::WriteAllText((Join-Path $layout 'AppxManifest.xml'), $manifest, (New-Object Text.UTF8Encoding $false))
  Copy-Item $exe (Join-Path $layout 'ezterm.exe')
  Copy-Item (Join-Path $msixSrc 'Assets') (Join-Path $layout 'Assets') -Recurse
  foreach ($doc in 'LICENSE', 'README.md') {
    $p = Join-Path $repo $doc
    if (Test-Path $p) { Copy-Item $p $layout }
  }

  if ($VcxsrvDir) {
    $vcx = Resolve-Path $VcxsrvDir
    if (-not (Test-Path (Join-Path $vcx 'vcxsrv.exe'))) { throw "vcxsrv.exe not found in $vcx" }
    $dest = Join-Path $layout 'vcxsrv'
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Copy-Item (Join-Path $vcx '*') $dest -Recurse -Exclude '.gitkeep'
  } else {
    Write-Warning 'No -VcxsrvDir given: the package will not include VcXsrv (X11 forwarding unavailable)'
  }

  # Index only the logo assets so Windows resolves the scale / target-size
  # variants. Indexing the whole layout would pull VcXsrv's files into the
  # PRI as resources.
  Copy-Item (Join-Path $msixSrc 'Assets') (Join-Path $priSrc 'Assets') -Recurse
  Copy-Item (Join-Path $layout 'AppxManifest.xml') $priSrc
  $priConfig = Join-Path $work 'priconfig.xml'
  & $makepri createconfig /cf $priConfig /dq en-US /pv 10.0.0 /o | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "makepri createconfig failed ($LASTEXITCODE)" }
  # The default config splits scale / language variants into separate
  # resource-pack PRIs, which only a bundle can carry. A single MSIX needs
  # every variant in the one resources.pri.
  [xml]$cfg = Get-Content $priConfig
  $packaging = $cfg.SelectSingleNode('/resources/packaging')
  if ($packaging) { [void]$packaging.ParentNode.RemoveChild($packaging) }
  $cfg.Save($priConfig)
  & $makepri new /pr $priSrc /cf $priConfig /mn (Join-Path $priSrc 'AppxManifest.xml') /of (Join-Path $layout 'resources.pri') /o | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "makepri new failed ($LASTEXITCODE)" }

  $out = [IO.Path]::GetFullPath($OutFile)
  New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null
  & $makeappx pack /d $layout /p $out /o | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "makeappx pack failed ($LASTEXITCODE)" }

  $size = [Math]::Round((Get-Item $out).Length / 1MB, 1)
  Write-Host "Packed $out ($size MB, version $msixVersion)"
} finally {
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
