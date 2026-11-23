# BridgeCam DLL Deploy Script (self-elevating)
# Run from any PowerShell: .\deploy.ps1

# Self-elevate if not admin
if (-NOT ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]"Administrator")) {
    Start-Process PowerShell -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
    exit
}

$ErrorActionPreference = "Stop"
$base = Split-Path $PSCommandPath -Parent
# Support both Debug and Release builds from the x64 build directory
$x64 = Join-Path $base "build_x64\Release\BridgeCamFilter.dll"
if (!(Test-Path $x64)) { $x64 = Join-Path $base "build_x64\Debug\BridgeCamFilter.dll" }
if (!(Test-Path $x64)) { $x64 = Join-Path $base "build\Debug\BridgeCamFilter.dll" }
$x86 = Join-Path $base "build32\Debug\BridgeCamFilter.dll"

Write-Host "=== BridgeCam DLL Deploy ===" -ForegroundColor Cyan
Write-Host "Stopping FrameServer..." -ForegroundColor Yellow
Stop-Service FrameServer -ErrorAction SilentlyContinue
Stop-Service FrameServerMonitor -ErrorAction SilentlyContinue
Start-Sleep 2

Write-Host "Copying x64 -> System32..." -ForegroundColor Yellow
Copy-Item $x64 "$env:SystemRoot\System32\BridgeCamFilter.dll" -Force

if (Test-Path $x86) {
    Write-Host "Copying x86 -> SysWOW64..." -ForegroundColor Yellow
    Copy-Item $x86 "$env:SystemRoot\SysWOW64\BridgeCamFilter.dll" -Force
} else {
    Write-Host "Skipping x86 (not built)" -ForegroundColor DarkYellow
}

Write-Host "Registering x64..." -ForegroundColor Yellow
& regsvr32 /s "$env:SystemRoot\System32\BridgeCamFilter.dll"

if (Test-Path "$env:SystemRoot\SysWOW64\BridgeCamFilter.dll") {
    Write-Host "Registering x86..." -ForegroundColor Yellow
    & regsvr32 /s "$env:SystemRoot\SysWOW64\BridgeCamFilter.dll"
}

$ts64 = (Get-Item "$env:SystemRoot\System32\BridgeCamFilter.dll").LastWriteTime
Write-Host "`n=== DEPLOYED ===" -ForegroundColor Green
Write-Host "System32: $ts64"
if (Test-Path "$env:SystemRoot\SysWOW64\BridgeCamFilter.dll") {
    $ts86 = (Get-Item "$env:SystemRoot\SysWOW64\BridgeCamFilter.dll").LastWriteTime
    Write-Host "SysWOW64: $ts86"
}

# Write marker file so caller can verify
"deployed $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" | Out-File (Join-Path $base "deploy_ok.txt") -Force

Write-Host "`nPress any key to close..." -ForegroundColor Gray
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
