@echo off
echo ============================================
echo BridgeCam Virtual Camera Admin Fix
echo ============================================
echo.
echo Stopping Windows Camera Frame Server...
net stop FrameServer /y
net stop FrameServerMonitor /y
timeout /t 3 /nobreak >nul

echo.
echo Rebuilding BridgeCamFilter.dll (clean build, DLL now unlocked)...
cmake --build "C:\Users\conno\OneDrive\old\Documents\CQNNQR\BridgeCam\drivers\windows\build" --config Debug --target BridgeCamFilter --clean-first
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Build failed. Check compiler output above.
    pause
    exit /b 1
)

echo.
echo Clearing stale logs and framebuffer...
del /Q "C:\ProgramData\BridgeCam\vcam_qi.log" 2>nul
del /Q "C:\ProgramData\BridgeCam\framebuffer.dat" 2>nul

echo.
echo Copying updated DLL to ProgramData...
copy /Y "C:\Users\conno\OneDrive\old\Documents\CQNNQR\BridgeCam\drivers\windows\build\Debug\BridgeCamFilter.dll" "C:\ProgramData\BridgeCam\BridgeCamFilter.dll"
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Copy failed. DLL still locked?
    pause
    exit /b 1
)

echo DLL updated. Timestamp:
dir "C:\ProgramData\BridgeCam\BridgeCamFilter.dll" | find "BridgeCamFilter"

echo.
echo Starting Windows Camera Frame Server...
net start FrameServerMonitor
net start FrameServer
echo.
echo Done! Now run frame_writer.exe (NOT test_vcam) and open NVIDIA Broadcast.
echo   frame_writer writes RGBA test bars; DLL converts to NV12 for consumers.
echo.
pause
