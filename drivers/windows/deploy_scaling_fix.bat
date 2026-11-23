@echo off
:: Deploy BridgeCamFilter.dll with scaling fix — MUST run as Administrator
:: Stops all processes that lock the DLL before copying.

echo === BridgeCam DLL Deploy (Scaling Fix) ===
echo.

:: Stop apps that load the DLL
echo Stopping OBS...
taskkill /F /IM obs64.exe >nul 2>&1
taskkill /F /IM obs-browser-page.exe >nul 2>&1
echo Stopping Brave...
taskkill /F /IM brave.exe >nul 2>&1
echo Stopping BridgeCam desktop...
taskkill /F /IM desktop.exe >nul 2>&1
timeout /t 2 /nobreak >nul

:: Stop Frame Server
echo Stopping Windows Frame Server...
net stop FrameServer >nul 2>&1
net stop FrameServerMonitor >nul 2>&1
timeout /t 2 /nobreak >nul

:: Copy DLL
set SRC=c:\Users\conno\Documents\BridgeCam\drivers\windows\build_x64\Release\BridgeCamFilter.dll
set DST=C:\Windows\System32\BridgeCamFilter.dll

echo Copying %SRC% to %DST%...
copy /Y "%SRC%" "%DST%"
if %ERRORLEVEL% NEQ 0 (
    echo FAILED to copy DLL. Is another process still locking it?
    pause
    exit /b 1
)

:: Re-register
echo Registering DLL...
regsvr32 /s "%DST%"

:: Restart Frame Server
echo Restarting Frame Server...
net start FrameServer >nul 2>&1
net start FrameServerMonitor >nul 2>&1

echo.
echo === Deploy complete! Restart OBS and BridgeCam desktop. ===
pause
