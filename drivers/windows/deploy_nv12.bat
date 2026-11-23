@echo off
:: BridgeCam NV12 DLL deployment
:: Right-click this file and choose "Run as administrator"

set X64=C:\Users\conno\OneDrive\old\Documents\CQNNQR\BridgeCam\drivers\windows\build\Debug\BridgeCamFilter.dll
set X86=C:\Users\conno\OneDrive\old\Documents\CQNNQR\BridgeCam\drivers\windows\build32\Debug\BridgeCamFilter.dll
set MARKER=%TEMP%\bcam_deployed_ok.txt

echo Stopping Windows Camera Frame Server...
net stop FrameServer 2>nul
net stop FrameServerMonitor 2>nul
timeout /t 2 /nobreak >nul

echo Copying x64 DLL to System32...
copy /Y "%X64%" "%SystemRoot%\System32\BridgeCamFilter.dll"
if errorlevel 1 ( echo ERROR: copy x64 failed - are you running as admin? && pause && exit /b 1 )

echo Copying x86 DLL to SysWOW64...
copy /Y "%X86%" "%SystemRoot%\SysWOW64\BridgeCamFilter.dll"
if errorlevel 1 ( echo ERROR: copy x86 failed && pause && exit /b 1 )

echo Registering x64 DLL...
regsvr32 /s "%SystemRoot%\System32\BridgeCamFilter.dll"
if errorlevel 1 ( echo ERROR: regsvr32 x64 failed && pause && exit /b 1 )

echo Registering x86 DLL...
regsvr32 /s "%SystemRoot%\SysWOW64\BridgeCamFilter.dll"
if errorlevel 1 ( echo ERROR: regsvr32 x86 failed && pause && exit /b 1 )

:: Write marker file so the IDE can confirm deployment succeeded
echo OK > "%MARKER%"

echo.
echo ============================================
echo  DONE - NV12 DLL deployed successfully!
echo  Build time of deployed x64 DLL:
forfiles /P "%SystemRoot%\System32" /M BridgeCamFilter.dll /C "cmd /c echo   @fdate @ftime"
echo ============================================
echo.
echo You can close this window, then:
echo  1. Open the BridgeCam desktop app
echo  2. Connect your phone
echo  3. Open NVIDIA Broadcast and select BridgeCam Source
pause
