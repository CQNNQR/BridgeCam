@echo off
:: Deploy BridgeCamFilter.dll — must run as Administrator
:: Forcefully stops all Frame Server consumers, copies DLL, restarts.

echo === BridgeCam DLL Deployment ===
echo.

set SRC=c:\Users\conno\OneDrive\old\Documents\CQNNQR\BridgeCam\drivers\windows\build\Debug\BridgeCamFilter.dll
set DST=C:\ProgramData\BridgeCam\BridgeCamFilter.dll

echo Stopping Frame Server services...
net stop FrameServer /y 2>nul
net stop FrameServerMonitor /y 2>nul

:: Kill any svchost that might be holding the DLL
:: (taskkill on FrameServer svchost is risky, but the service stop should suffice)
timeout /t 3 /nobreak >nul

echo.
echo Copying new DLL...
copy /Y "%SRC%" "%DST%"
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ERROR: Could not copy DLL. File may be locked.
    echo Please close NVIDIA Broadcast and any camera apps, then retry.
    pause
    exit /b 1
)

echo.
echo Clearing old logs...
del "C:\ProgramData\BridgeCam\vcam_qi.log" 2>nul
del "%TEMP%\bridgecam_qi.log" 2>nul

echo.
echo Starting Frame Server services...
net start FrameServerMonitor
net start FrameServer

echo.
echo Verifying deployment...
dir "%DST%" | findstr "BridgeCamFilter"

echo.
echo === Deployment Complete ===
pause
