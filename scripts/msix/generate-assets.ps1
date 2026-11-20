<#
.SYNOPSIS
  Regenerates the MSIX tile / logo assets in src-tauri/msix/Assets from the
  master app icon (src-tauri/icons/icon.png).

.DESCRIPTION
  Writes scale-100 and scale-200 variants of every logo the manifest
  references, plus the target-size (and unplated) Square44x44 variants
  Windows uses for the taskbar, Start list, and Alt+Tab. The packaging
  script indexes them into resources.pri so Windows picks the right one.

  Run after changing icons/icon.png and commit the output.
#>
[CmdletBinding()]
param(
  [string]$Source,
  [string]$OutDir
)

$ErrorActionPreference = 'Stop'
# Resolved here rather than as param defaults: Windows PowerShell 5.1 leaves
# $PSScriptRoot empty while binding parameters.
$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
if (-not $Source) { $Source = Join-Path $repo 'src-tauri\icons\icon.png' }
if (-not $OutDir) { $OutDir = Join-Path $repo 'src-tauri\msix\Assets' }
Add-Type -AssemblyName System.Drawing

$src = [System.Drawing.Image]::FromFile((Resolve-Path $Source))
try {
  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
  Get-ChildItem $OutDir -Filter *.png | Remove-Item

  # Draws the icon centred on a transparent canvas. $iconScale is the icon's
  # share of the canvas's shorter side, leaving Windows' recommended margin
  # around tile artwork.
  function Save-Logo([string]$name, [int]$w, [int]$h, [double]$iconScale) {
    $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $g.Clear([System.Drawing.Color]::Transparent)
      $side = [int][Math]::Round([Math]::Min($w, $h) * $iconScale)
      $x = [int](($w - $side) / 2)
      $y = [int](($h - $side) / 2)
      $g.DrawImage($src, $x, $y, $side, $side)
      $bmp.Save((Join-Path $OutDir $name), [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
      $g.Dispose()
      $bmp.Dispose()
    }
  }

  # Tiles: base size at scale-100, doubled at scale-200.
  $tiles = @(
    @{ Name = 'Square44x44Logo';   W = 44;  H = 44;  Scale = 1.0 },
    @{ Name = 'Square71x71Logo';   W = 71;  H = 71;  Scale = 0.8 },
    @{ Name = 'Square150x150Logo'; W = 150; H = 150; Scale = 0.66 },
    @{ Name = 'Square310x310Logo'; W = 310; H = 310; Scale = 0.66 },
    @{ Name = 'Wide310x150Logo';   W = 310; H = 150; Scale = 0.66 },
    @{ Name = 'StoreLogo';         W = 50;  H = 50;  Scale = 1.0 }
  )
  foreach ($t in $tiles) {
    foreach ($s in 100, 200) {
      $f = $s / 100
      Save-Logo "$($t.Name).scale-$s.png" ($t.W * $f) ($t.H * $f) $t.Scale
    }
  }

  # App list / taskbar icon at exact pixel sizes. The unplated variants are
  # what Windows shows on the taskbar without a coloured backplate.
  foreach ($size in 16, 24, 32, 48, 256) {
    Save-Logo "Square44x44Logo.targetsize-$size.png" $size $size 1.0
    Save-Logo "Square44x44Logo.targetsize-${size}_altform-unplated.png" $size $size 1.0
    Save-Logo "Square44x44Logo.targetsize-${size}_altform-lightunplated.png" $size $size 1.0
  }
} finally {
  $src.Dispose()
}

Write-Host "Wrote $((Get-ChildItem $OutDir -Filter *.png).Count) assets to $((Resolve-Path $OutDir).Path)"
