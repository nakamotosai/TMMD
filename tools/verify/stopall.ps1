# tools/verify/stopall.ps1
# Kill everything the verification workflow may have started, and clean its temp files.
# Run this at the end of every verification round. Expected output:
#   tmmd running now: 0
#   cmd/powershell with my fingerprints left: 0
#
# ASCII only (Windows PowerShell decodes .ps1 with the ANSI codepage).
param([switch]$Quiet)
$me = $PID
$hits = Get-CimInstance Win32_Process | Where-Object {
  $_.ProcessId -ne $me -and $_.CommandLine -and (
    $_.CommandLine -match 'tmmd-update' -or
    $_.CommandLine -match 'tmmd-verify' -or
    $_.CommandLine -match 'target\\debug\\tmmd\.exe' -or
    $_.Name -eq 'tmmd.exe'
  )
}
foreach ($h in $hits) {
  try {
    Stop-Process -Id $h.ProcessId -Force -ErrorAction Stop
    if (-not $Quiet) { Write-Output ('killed ' + $h.ProcessId + ' ' + $h.Name) }
  } catch { }
}
Get-ChildItem $env:TEMP -Filter 'tmmd-update-*.ps1' -ErrorAction SilentlyContinue |
  ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }
Write-Output ('tmmd running now: ' + ((Get-Process tmmd -ErrorAction SilentlyContinue | Measure-Object).Count))
Write-Output ('cmd/powershell with my fingerprints left: ' + ((Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine -match 'tmmd-update|tmmd-verify') } | Measure-Object).Count))
