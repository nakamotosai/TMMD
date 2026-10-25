# make-release-manifest.ps1 - build latest.json + SHA256SUMS for one TMMD release (trust root of the updater)
#
# Why: the built-in updater reads a fixed manifest URL
#   https://github.com/nakamotosai/TMMD/releases/latest/download/latest.json
# so every release MUST ship that manifest as a release asset, containing version, asset name,
# download URL and SHA-256. The client hard-verifies sha256 (mismatch -> discarded) and the URL
# must fall inside the trusted prefix (lib.rs UPDATE_TRUSTED).
#
# ASCII ONLY - Windows PowerShell decodes .ps1 using the ANSI codepage (GBK on this machine).
# A UTF-8 Chinese string in this file gets mis-decoded and breaks the parser at load time
# (2026-10-25: this file shipped non-ASCII comments and died with "invalid assignment expression").
#
# Usage (run from the repo root, after `npm run build` produced the installer):
#   powershell -File tools/make-release-manifest.ps1 -Dir src-tauri/target/release/bundle/nsis `
#       -Version 1.8.0 -Notes "glass / editor / updater"
#
# Then upload latest.json, SHA256SUMS and the installer together as assets of that release (GitHub / Gitea).
param(
  [Parameter(Mandatory = $true)][string]$Dir,
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Repo = 'nakamotosai/TMMD',
  [string]$Notes = '',
  [string]$Tag = ''
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Dir)) { throw ('dir not found: ' + $Dir + ' (run tauri build first)') }
if (-not $Tag) { $Tag = 'v' + $Version }
$exe = Get-ChildItem -Path $Dir -Filter '*-setup.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $exe) { throw ('no *-setup.exe under ' + $Dir + ' (run npm run build first)') }
$hash = (Get-FileHash -Path $exe.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
$url = 'https://github.com/' + $Repo + '/releases/download/' + $Tag + '/' + $exe.Name
$m = [ordered]@{
  version = $Version
  asset   = $exe.Name
  url     = $url
  sha256  = $hash
  size    = [int]$exe.Length
  notes   = $Notes
}
$jsonPath = Join-Path $exe.DirectoryName 'latest.json'
($m | ConvertTo-Json) | Set-Content -Path $jsonPath -Encoding UTF8
$sumPath = Join-Path $exe.DirectoryName 'SHA256SUMS'
($hash + '  ' + $exe.Name) | Set-Content -Path $sumPath -Encoding ASCII
Write-Output ('installer : ' + $exe.FullName + '  (' + [Math]::Round($exe.Length / 1MB, 1) + ' MB)')
Write-Output ('sha256    : ' + $hash)
Write-Output ('manifest  : ' + $jsonPath)
Write-Output ('sums      : ' + $sumPath)
Write-Output ('asset url : ' + $url)
