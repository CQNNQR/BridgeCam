@echo off
:: Self-elevating deploy script
NET SESSION >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting admin...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

echo === Admin mode ===
net stop FrameServer 2>nul
net stop FrameServerMonitor 2>nul
ping -n 3 127.0.0.1 >nul

copy /Y "C:\Users\conno\OneDrive\old\Documents\CQNNQR\BridgeCam\drivers\windows\build\Debug\BridgeCamFilter.dll" "%SystemRoot%\System32\BridgeCamFilter.dll"
if errorlevel 1 ( echo FAIL x64 & pause & exit /b 1 )
copy /Y "C:\Users\conno\OneDrive\old\Documents\CQNNQR\BridgeCam\drivers\windows\build32\Debug\BridgeCamFilter.dll" "%SystemRoot%\SysWOW64\BridgeCamFilter.dll"
if errorlevel 1 ( echo FAIL x86 & pause & exit /b 1 )
regsvr32 /s "%SystemRoot%\System32\BridgeCamFilter.dll"
regsvr32 /s "%SystemRoot%\SysWOW64\BridgeCamFilter.dll"
echo OK > "%TEMP%\bcam_deployed_ok.txt"
echo.
echo === DEPLOYED OK ===
echo System32 timestamp:
forfiles /P "%SystemRoot%\System32" /M BridgeCamFilter.dll /C "cmd /c echo   @fdate @ftime"
pause
