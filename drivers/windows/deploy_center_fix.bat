@echo off
:: Must be run as Administrator — right-click → Run as administrator
echo ============================================
echo   BridgeCam DLL Deploy (Centering Fix)
echo ============================================
echo.

echo [1/4] Killing apps that lock the DLL...
taskkill /F /IM obs64.exe 2>nul
taskkill /F /IM obs32.exe 2>nul
taskkill /F /IM brave.exe 2>nul
taskkill /F /IM chrome.exe 2>nul
echo     Apps killed (OBS, browsers).
echo.

echo [2/4] Stopping Frame Server...
net stop FrameServer /y 2>nul
net stop FrameServerMonitor /y 2>nul
timeout /t 4 /nobreak >nul
echo     Services stopped.
echo.

echo [3/4] Copying DLL to System32...
copy /Y "C:\Users\conno\Documents\BridgeCam\drivers\windows\build\Debug\BridgeCamFilter.dll" "C:\Windows\System32\BridgeCamFilter.dll"
if %ERRORLEVEL% NEQ 0 (
    echo     ERROR: Copy FAILED! Is something still locking the file?
    pause
    exit /b 1
)
echo     DLL copied successfully!
echo.

echo [4/4] Restarting Frame Server...
net start FrameServerMonitor 2>nul
net start FrameServer 2>nul
echo     Services restarted.
echo.

echo ============================================
echo   SUCCESS! New DLL deployed.
echo   You can re-open OBS and Brave now.
echo ============================================
pause
