# make-release-manifest.ps1 - 给一次 TMMD 发布生成 latest.json + SHA256SUMS(自研更新器的信任根)
#
# 为什么需要:自研更新器(程序内 update_check)固定读
#   https://github.com/nakamotosai/TMMD/releases/latest/download/latest.json
# 所以每次发版必须把这个清单当作**发布资产**上传,里面写清楚版本、安装包名、下载 URL 与 SHA-256。
# 下载端会强校验 sha256,不符即丢弃;URL 还必须落在受信任前缀内(lib.rs UPDATE_TRUSTED)。
#
# ASCII only(Windows PowerShell 按 ANSI 解码 .ps1)。
#
# 用法(在仓库根执行,先在 tauri build 出安装包之后):
#   powershell -File tools/make-release-manifest.ps1 -Dir src-tauri/target/release/bundle/nsis `
#       -Version 1.8.0 -Notes "整窗玻璃/编辑器/自研更新器"
#
# 之后把 latest.json、SHA256SUMS 与安装包一起作为该 release 的资产上传(GitHub / Gitea 皆可)。
param(
  [Parameter(Mandatory = $true)][string]$Dir,
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Repo = 'nakamotosai/TMMD',
  [string]$Notes = '',
  [string]$Tag = ''
)
$ErrorActionPreference = 'Stop'
if (-not $Tag) { $Tag = 'v' + $Version }
$exe = Get-ChildItem -Path $Dir -Filter '*-setup.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $exe) { throw ('在 ' + $Dir + ' 找不到 *-setup.exe(先跑 npm run build)') }
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
Write-Output ('url       : ' + $url)
Write-Output ('wrote     : ' + $jsonPath)
Write-Output ('wrote     : ' + $sumPath)
Write-Output ''
Write-Output '下一步:把上面两个文件与安装包一起上传为该 release 的资产(gh release create / gitea 网页皆可)'
