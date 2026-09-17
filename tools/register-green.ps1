#Requires -Version 5.1
<#
.SYNOPSIS
  TMMD 绿版 HKCU 文件关联注册（一键、幂等、可重跑，只写 HKCU）。
.DESCRIPTION
  把绿版 C:\Users\sai\MD阅读器\TMMD\TMMD.exe 的手写注册做成脚本：
  TMMD.md ProgId(open 命令) / .md OpenWithProgids / Applications\TMMD.exe
  (FriendlyAppName + SupportedTypes) / Software\TMMD\Capabilities
  (FileAssociations) / RegisteredApplications 挂载。
  不改现有默认打开方式，不碰 HKLM。本轮只落盘不执行，执行由部署后轮做。
.EXAMPLE
  pwsh -File tools/register-green.ps1
  pwsh -File tools/register-green.ps1 -ExePath "D:\TMMD\TMMD.exe"
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$ExePath = 'C:\Users\sai\MD阅读器\TMMD\TMMD.exe'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $ExePath)) {
  throw "绿版不存在: $ExePath（挪目录后用 -ExePath 指定新路径重跑）"
}

function Ensure-Key([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -Path $Path -Force | Out-Null
  }
}

function Set-DefaultValue([string]$Path, [string]$Value) {
  Ensure-Key $Path
  New-ItemProperty -LiteralPath $Path -Name '(default)' -Value $Value -Force | Out-Null
}

# 1. ProgId TMMD.md + open 命令 + 图标
Set-DefaultValue 'HKCU:\Software\Classes\TMMD.md' 'Markdown Document (TMMD)'
Set-DefaultValue 'HKCU:\Software\Classes\TMMD.md\shell\open\command' ('"' + $ExePath + '" "%1"')
Set-DefaultValue 'HKCU:\Software\Classes\TMMD.md\DefaultIcon' ('"' + $ExePath + '",0')

# 2. .md 候选：OpenWithProgids 挂 TMMD.md（不改 UserChoice 现有默认）
Ensure-Key 'HKCU:\Software\Classes\.md\OpenWithProgids'
New-ItemProperty -LiteralPath 'HKCU:\Software\Classes\.md\OpenWithProgids' `
  -Name 'TMMD.md' -PropertyType String -Value '' -Force | Out-Null

# 3. Applications\TMMD.exe：显示名 + open 命令 + 支持类型
Set-DefaultValue 'HKCU:\Software\Classes\Applications\TMMD.exe\shell\open\command' ('"' + $ExePath + '" "%1"')
Ensure-Key 'HKCU:\Software\Classes\Applications\TMMD.exe'
New-ItemProperty -LiteralPath 'HKCU:\Software\Classes\Applications\TMMD.exe' `
  -Name 'FriendlyAppName' -Value 'TMMD' -Force | Out-Null
Ensure-Key 'HKCU:\Software\Classes\Applications\TMMD.exe\SupportedTypes'
New-ItemProperty -LiteralPath 'HKCU:\Software\Classes\Applications\TMMD.exe\SupportedTypes' `
  -Name '.md' -PropertyType String -Value '' -Force | Out-Null

# 4. Capabilities：默认应用页候选 + 文件关联映射
Ensure-Key 'HKCU:\Software\TMMD\Capabilities'
New-ItemProperty -LiteralPath 'HKCU:\Software\TMMD\Capabilities' `
  -Name 'ApplicationName' -Value 'TMMD' -Force | Out-Null
New-ItemProperty -LiteralPath 'HKCU:\Software\TMMD\Capabilities' `
  -Name 'ApplicationDescription' -Value 'TMMD transparent Markdown reader' -Force | Out-Null
Ensure-Key 'HKCU:\Software\TMMD\Capabilities\FileAssociations'
New-ItemProperty -LiteralPath 'HKCU:\Software\TMMD\Capabilities\FileAssociations' `
  -Name '.md' -Value 'TMMD.md' -Force | Out-Null

# 5. RegisteredApplications 挂载
Ensure-Key 'HKCU:\Software\RegisteredApplications'
New-ItemProperty -LiteralPath 'HKCU:\Software\RegisteredApplications' `
  -Name 'TMMD' -Value 'Software\TMMD\Capabilities' -Force | Out-Null

Write-Host "OK: TMMD 绿版 HKCU 注册完成 ($ExePath)"
Write-Host '核验: Get-ItemProperty HKCU:\Software\Classes\TMMD.md\shell\open\command'
