# tools/verify/capture-secondary.ps1
# Capture the REAL composited pixels of the secondary display (DWM material included) and optionally
# report brightness/sharpness stats for a region - the numbers used when tuning the glass.
#
# Why CopyFromScreen and not CDP screenshots: the window-level material (Acrylic / Mica) is composited by
# DWM *behind* the web content, so Page.captureScreenshot cannot see it. Only a screen grab can.
#
# ASCII only (Windows PowerShell decodes .ps1 with the ANSI codepage).
#
# Usage:
#   powershell -File tools/verify/capture-secondary.ps1 -Out C:\tmp\shot.png
#   powershell -File tools/verify/capture-secondary.ps1 -Out C:\tmp\shot.png -Stats -Rect 40,140,1100,700
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [switch]$Stats,
  # region IN DISPLAY-LOCAL physical pixels for -Stats (x,y,w,h)
  [string]$Rect = '40,560,1100,700'
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class VC {
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
}
"@
[void][VC]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$sc = [System.Windows.Forms.Screen]::AllScreens | Where-Object { -not $_.Primary } | Select-Object -First 1
if (-not $sc) { throw 'no secondary display found' }
$b = $sc.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, (New-Object System.Drawing.Size($b.Width, $b.Height)))
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
if ($Stats) {
  $p = $Rect -split ','
  $x0 = [int]$p[0]; $y0 = [int]$p[1]; $w = [int]$p[2]; $h = [int]$p[3]
  $x0 = [Math]::Max(0, [Math]::Min($b.Width - 2, $x0))
  $y0 = [Math]::Max(0, [Math]::Min($b.Height - 2, $y0))
  $w = [Math]::Min($w, $b.Width - $x0)
  $h = [Math]::Min($h, $b.Height - $y0)
  $sum = 0.0; $sum2 = 0.0; $n = 0; $hf = 0.0; $prev = -1.0
  for ($y = $y0; $y -lt ($y0 + $h); $y += 2) {
    for ($x = $x0; $x -lt ($x0 + $w); $x += 2) {
      $c = $bmp.GetPixel($x, $y)
      $l = 0.2126 * $c.R + 0.7152 * $c.G + 0.0722 * $c.B
      $sum += $l; $sum2 += $l * $l; $n++
      if ($prev -ge 0) { $hf += [Math]::Abs($l - $prev) }
      $prev = $l
    }
    $prev = -1.0
  }
  $mean = $sum / $n
  $sd = [Math]::Sqrt([Math]::Max(0, ($sum2 / $n) - ($mean * $mean)))
  Write-Output ('STATS mean=' + [Math]::Round($mean, 2) + ' sd=' + [Math]::Round($sd, 2) + ' hf=' + [Math]::Round($hf / $n, 3) + ' n=' + $n + ' rect=' + $Rect)
}
$bmp.Dispose()
Write-Output ('saved ' + $Out + ' (' + $b.Width + 'x' + $b.Height + ' from ' + $sc.DeviceName + ' @' + $b.X + ',' + $b.Y + ')')
