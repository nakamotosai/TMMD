# tools/verify/launch-on-secondary.ps1
# Launch TMMD so the window is BORN on the secondary display and the primary screen never sees it.
#
# Why this exists: during development we repeatedly needed an instance the user cannot see. Two hard
# requirements came out of that:
#   1. the window must never flash on the primary screen (verified: touchedPrimaryScreen=False);
#   2. it must not steal the taskbar/focus (TMMD_TEST_NOACTIVATE=1 -> SW_SHOWNOACTIVATE + WS_EX_TOOLWINDOW).
# The app itself makes (1) possible: it creates its window with visible:false and only shows it after
# window geometry is applied. window.json v2 stores PHYSICAL pixels and restores onto the monitor that
# contains that point, so seeding v2 geometry for the secondary is enough - no SetWindowPos dance.
#
# ASCII ONLY: Windows PowerShell decodes .ps1 using the ANSI codepage; non-ASCII corrupts the script.
#
# Usage:
#   powershell -File tools/verify/launch-on-secondary.ps1 -Exe <path\to\tmmd.exe> [-Port 9225] [-Capture]
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [int]$Port = 9225,
  [switch]$Capture,
  [switch]$NoSeed,
  # test seam for the updater check: point the app at a local manifest (tools/verify/update-manifest-check.py)
  [string]$UpdateEndpoint = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class VW {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  public static List<IntPtr> ForPid(uint pid) {
    var list = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      uint w; GetWindowThreadProcessId(h, out w);
      if (w == pid) list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list;
  }
  public static string RectOf(IntPtr h) {
    RECT r; if (!GetWindowRect(h, out r)) return "none";
    return r.Left + "," + r.Top + " " + (r.Right - r.Left) + "x" + (r.Bottom - r.Top);
  }
  // WebView2 spawns many tiny helper windows; only a real app window counts (>100k px).
  public static IntPtr RealWindow(uint pid) {
    IntPtr best = IntPtr.Zero; long bestArea = 100000;
    foreach (var h in ForPid(pid)) {
      if (!IsWindowVisible(h)) continue;
      RECT r; if (!GetWindowRect(h, out r)) continue;
      long a = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
      if (a > bestArea) { bestArea = a; best = h; }
    }
    return best;
  }
  public static bool Intersects(IntPtr h, int x, int y, int w, int hh) {
    RECT r; if (!GetWindowRect(h, out r)) return false;
    return r.Left < x + w && r.Right > x && r.Top < y + hh && r.Bottom > y;
  }
  public static uint ThreadOf(IntPtr h) { uint t; return GetWindowThreadProcessId(h, out t); }
}
"@
[void][VW]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))   # read PHYSICAL bounds
Add-Type -AssemblyName System.Windows.Forms
$sc = [System.Windows.Forms.Screen]::AllScreens | Where-Object { -not $_.Primary } | Select-Object -First 1
if (-not $sc) { throw 'no secondary display found - connect/enable one first' }
$b = $sc.Bounds
$w = [int]($b.Width * 0.88); $h = [int]($b.Height * 0.88); $x = $b.X + 40; $y = $b.Y + 40

# seed window.json (v2 = physical pixels) into an ISOLATED config dir
# (TMMD_CONFIG_DIR: the app honors it as a test seam, so the user's real roots.json/window.json are never touched)
$cfgDir = Join-Path $env:TEMP 'tmmd-verify-cfg'
New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
$cfg = Join-Path $cfgDir 'window.json'
Set-Content -Path $cfg -Value ('{"v":2,"w":' + $w + '.0,"h":' + $h + '.0,"x":' + $x + '.0,"y":' + $y + '.0}') -Encoding ASCII
Write-Output ('seeded v2 physical geometry ' + $w + 'x' + $h + ' @' + $x + ',' + $y + ' on ' + $sc.DeviceName)
Write-Output ('isolated config dir: ' + $cfgDir)

$fgBefore = [VW]::GetForegroundWindow()
# refuse a double launch: two instances sharing the isolated profile make CDP ambiguous (the
# 2026-10-25 hang: a stale instance answered the port, the new one seeded the doc into the void).
$busy = $false
try { $null = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 ("http://127.0.0.1:" + $Port + "/json"); $busy = $true } catch { }
if ($busy) { throw ('CDP already answers on port ' + $Port + ' - run tools/verify/stopall.ps1 first') }
# TMMD registers tauri-plugin-single-instance: if ANY tmmd.exe is alive, this launch just forwards
# argv to it and exits - the window never appears and the launcher would sit there until its deadline.
$alive = Get-Process tmmd -ErrorAction SilentlyContinue
if ($alive) {
  $who = ($alive | ForEach-Object { $_.Id.ToString() + '@' + ($_.Path -replace '.*\\', '') }) -join ', '
  throw ('TMMD already running (' + $who + ') - single-instance app, this launch would just exit; run tools/verify/stopall.ps1 -IncludeInstalled first')
}
# isolated WebView2 profile (localStorage / tab restore / cache). Wiped on every launch so each
# runway starts from a pristine profile - fresh-install defaults are then actually testable.
# (this was MISSING until 2026-10-25: runways wrote into the user's real profile)
$vwDir = Join-Path $env:TEMP 'tmmd-verify-webview'
if (Test-Path $vwDir) { Remove-Item -Recurse -Force $vwDir -ErrorAction SilentlyContinue }
if (Test-Path $vwDir) { throw ('could not wipe ' + $vwDir + ' - a stale instance still holds it; run stopall.ps1') }
New-Item -ItemType Directory -Force -Path $vwDir | Out-Null
$env:TMMD_CONFIG_DIR = $cfgDir
$env:TMMD_TEST_NOACTIVATE = '1'                                  # no focus steal, no taskbar button
$env:WEBVIEW2_USER_DATA_FOLDER = $vwDir
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"
if ($UpdateEndpoint) { $env:TMMD_UPDATE_ENDPOINT = $UpdateEndpoint }
$log = Join-Path $env:TEMP 'tmmd-verify-out.log'
$err = Join-Path $env:TEMP 'tmmd-verify-err.log'
$p = Start-Process -FilePath $Exe -PassThru -RedirectStandardOutput $log -RedirectStandardError $err

$primary = [System.Windows.Forms.Screen]::AllScreens | Where-Object { $_.Primary } | Select-Object -First 1
$pb = $primary.Bounds
$firstVisible = $null; $hitPrimary = $false; $samples = 0
$deadline = (Get-Date).AddSeconds(25)
while ((Get-Date) -lt $deadline -and $null -eq $firstVisible) {
  Start-Sleep -Milliseconds 15
  $samples++
  $hw = [VW]::RealWindow([uint32]$p.Id)
  if ($hw -ne [IntPtr]::Zero) {
    if ([VW]::Intersects($hw, $pb.X, $pb.Y, $pb.Width, $pb.Height)) { $hitPrimary = $true }
    $firstVisible = [VW]::RectOf($hw)
  }
}
if ($null -eq $firstVisible) { throw 'window never became visible' }
Write-Output ('FIRST visible real window: ' + $firstVisible + '  (after ' + $samples + ' samples of ~15ms)')
Write-Output ('touchedPrimaryScreen=' + $hitPrimary)
$parts = $firstVisible -split '[ ,x]'
$L = [int]$parts[0]; $T = [int]$parts[1]; $W2 = [int]$parts[2]; $H2 = [int]$parts[3]
$onSecondary = ($L -ge $b.X -and $T -ge $b.Y -and ($L + $W2) -le ($b.X + $b.Width) -and ($T + $H2) -le ($b.Y + $b.Height))
Write-Output ('onSecondary=' + $onSecondary + ' (secondary bounds ' + $b.X + ',' + $b.Y + ' ' + $b.Width + 'x' + $b.Height + ')')
if (-not $onSecondary) { Write-Output 'WARNING: first visible frame was NOT on the secondary display' }
$ex = [VW]::GetWindowLong([VW]::RealWindow([uint32]$p.Id), -20)
Write-Output ('exStyle=0x' + ('{0:X}' -f $ex) + '  (WS_EX_TOOLWINDOW=0x80 set means no taskbar button)')
$fgAfter = [VW]::GetForegroundWindow()
if ($fgAfter -ne $fgBefore) {
  $tid = [VW]::GetCurrentThreadId()
  $other = [VW]::ThreadOf($fgAfter)
  [void][VW]::AttachThreadInput($tid, $other, $true)
  $ok = [VW]::SetForegroundWindow($fgBefore)
  [void][VW]::AttachThreadInput($tid, $other, $false)
  Write-Output ('focus stolen by launch -> restored to previous window: ' + $ok)
} else {
  Write-Output 'stoleFocus=False'
}
if ($Capture) {
  $cap = Join-Path $PSScriptRoot 'capture-secondary.ps1'
  if (Test-Path $cap) { & powershell -NoProfile -ExecutionPolicy Bypass -File $cap -Out (Join-Path $env:TEMP 'tmmd-secondary.png') }
}
# Seed one document. The isolated profile starts in the app's EMPTY state (no restored tabs) and
# several runway steps assume a document is on screen - without this the runways HANG (they do not
# fail, they block). The fixture is the repo README (always present, read-only for the runways).
# Skip with -NoSeed when you deliberately want to test the empty state.
if (-not $NoSeed) {
  $seed = (Resolve-Path (Join-Path $PSScriptRoot '..\..\README.md')).Path
  $probe = Join-Path $PSScriptRoot 'probe.mjs'
  $expr = "(async()=>{await openExternal('" + ($seed -replace '\\', '\\') + "');await new Promise(r=>setTimeout(r,1500));return 'seeded tabs='+S.tabs.length})()"
  $seeded = & node $probe --port=$Port $expr 2>&1
  Write-Output ('seed doc -> ' + ($seeded -join ' '))
}
Write-Output ('PID=' + $p.Id + ' PORT=' + $Port)
Set-Content -Path (Join-Path $env:TEMP 'tmmd-verify.pid') -Value $p.Id -Encoding ASCII
Write-Output 'NOTE: run tools/verify/stopall.ps1 when done.'
