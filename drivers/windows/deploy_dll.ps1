# Deploy BridgeCamFilter.dll with centering fix
# This script must be run as Administrator

$src = "C:\Users\conno\Documents\BridgeCam\drivers\windows\build\Debug\BridgeCamFilter.dll"
$dst = "C:\Windows\System32\BridgeCamFilter.dll"

Write-Host "=== Deploying centered DLL ===" -ForegroundColor Cyan
Write-Host "Source: $src"
Write-Host "Source size: $((Get-Item $src).Length) bytes"
Write-Host ""

# Stop Frame Server
Write-Host "Stopping FrameServer..." -ForegroundColor Yellow
net stop FrameServer /y 2>$null
net stop FrameServerMonitor /y 2>$null
Start-Sleep 3

# Copy DLL
Write-Host "Copying DLL..." -ForegroundColor Yellow
Copy-Item -Force $src $dst

if (Test-Path $dst) {
    $newSize = (Get-Item $dst).Length
    Write-Host "SUCCESS! New DLL size: $newSize bytes" -ForegroundColor Green
} else {
    Write-Host "FAILED - DLL not found at destination" -ForegroundColor Red
}

# Restart Frame Server
Write-Host "Starting FrameServer..." -ForegroundColor Yellow
net start FrameServerMonitor 2>$null
net start FrameServer 2>$null

Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Cyan
Write-Host "Press any key to close..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
