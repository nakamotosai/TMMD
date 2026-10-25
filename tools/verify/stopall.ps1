# tools/verify/stopall.ps1
# 收尾:只杀**本验证流程**起的进程,并清理它的临时文件。
#
# 为什么不再按进程名杀:按名杀会连**你正在用的那台 TMMD**一起杀掉(装好的版本也叫 tmmd.exe)。
# 现在只认两种身份:
#   1) 启动器写下的 PID 文件(%TEMP%\tmmd-verify.pid);
#   2) 可执行文件位于**开发树**里的 tmmd.exe(...\target\debug\ 或 ...\target\release\)。
# 装在 %LOCALAPPDATA%\Programs 下的正式版永远不会被这里碰到。
#
# ASCII only (Windows PowerShell decodes .ps1 with the ANSI codepage).
#
# -IncludeInstalled (opt-in): ALSO kill the installed app (%LOCALAPPDATA%\TMMD\tmmd.exe).
# Needed when an installed instance is running, because TMMD registers tauri-plugin-single-instance:
# a second launch just forwards argv to the running one and exits, so every verify launch dies with
# "window never became visible" (2026-10-25: cost 25 s per attempt plus four bogus failures).
param([switch]$Quiet, [switch]$IncludeInstalled)
$pidFile = Join-Path $env:TEMP 'tmmd-verify.pid'
$mine = New-Object System.Collections.Generic.HashSet[int]
if (Test-Path $pidFile) {
  (Get-Content $pidFile) | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [void]$mine.Add([int]$_) }
}
Get-Process tmmd -ErrorAction SilentlyContinue | ForEach-Object {
  $p = $null
  try { $p = $_.Path } catch { }
  if ($p -and ($p -match '\\target\\debug\\tmmd\.exe$' -or $p -match '\\target\\release\\tmmd\.exe$')) { [void]$mine.Add($_.Id) }
  elseif ($IncludeInstalled -and $p -and ($p -match '\\AppData\\Local\\TMMD\\tmmd\.exe$')) {
    [void]$mine.Add($_.Id)
    if (-not $Quiet) { Write-Output ('including installed instance pid=' + $_.Id) }
  }
}
foreach ($id in $mine) {
  try {
    Stop-Process -Id $id -Force -ErrorAction Stop
    if (-not $Quiet) { Write-Output ('killed dev instance pid=' + $id) }
  } catch { }
}
# 更新器助手(自研更新器会写 tmmd-update-<pid>.ps1 并起一个隐藏 powershell)
Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -match 'tmmd-update-\d+\.ps1' } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; if (-not $Quiet) { Write-Output ('killed update helper pid=' + $_.ProcessId) } } catch { } }
Get-ChildItem $env:TEMP -Filter 'tmmd-update-*.ps1' -ErrorAction SilentlyContinue |
  ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }
Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
$devLeft = (Get-Process tmmd -ErrorAction SilentlyContinue | Where-Object { $_.Path -match '\\target\\(debug|release)\\tmmd\.exe$' } | Measure-Object).Count
$helperLeft = (Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine -match 'tmmd-update-\d+\.ps1' } | Measure-Object).Count
$userLeft = (Get-Process tmmd -ErrorAction SilentlyContinue | Where-Object { $_.Path -notmatch '\\target\\(debug|release)\\tmmd\.exe$' } | Measure-Object).Count
Write-Output ('dev instances left: ' + $devLeft)
Write-Output ('update helpers left: ' + $helperLeft)
Write-Output ('your own TMMD instances left untouched: ' + $userLeft)
