# Sync product web dist -> ui-dist for Tauri frontendDist.
# Product UI: 本体; desktop shell root: MD阅读器tauri.
$ErrorActionPreference = "Stop"

$ProductRoot = "C:\Users\sai\MD阅读器\MD阅读器本体"
$Dest = "C:\Users\sai\MD阅读器\MD阅读器tauri\ui-dist"
$BuildScript = Join-Path $ProductRoot "scripts\build_pages.py"
$Dist = Join-Path $ProductRoot "dist"

Write-Host "[sync-ui] build_pages.py ..."
if (-not (Test-Path $BuildScript)) {
  throw "Missing build script: $BuildScript"
}
python $BuildScript
if ($LASTEXITCODE -ne 0) {
  throw "build_pages.py failed with exit $LASTEXITCODE"
}

if (-not (Test-Path (Join-Path $Dist "index.html"))) {
  throw "Product dist missing index.html after build: $Dist"
}

Write-Host "[sync-ui] copy $Dist -> $Dest"
if (Test-Path $Dest) {
  Remove-Item $Dest -Recurse -Force
}
New-Item -ItemType Directory -Path $Dest -Force | Out-Null
Copy-Item -Path (Join-Path $Dist "*") -Destination $Dest -Recurse -Force

$idx = Join-Path $Dest "index.html"
if (-not (Test-Path $idx)) {
  throw "ui-dist missing index.html after copy"
}
Write-Host "[sync-ui] OK -> $Dest"
