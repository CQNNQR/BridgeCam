@echo off
:: Run this script as Administrator to register BridgeCamFilter.dll (x64 + x86)
:: Right-click -> "Run as administrator"
:: Steps: copies DLLs to System32/SysWOW64 then calls regsvr32 from there so the
:: Windows Camera Frame Server (LocalSystem) can always locate the DLL.

echo ============================================
echo  BridgeCam Virtual Camera Registration
echo ============================================
echo.

set "DLL64=%~dp0build\Debug\BridgeCamFilter.dll"
set "DLL32=%~dp0build32\Debug\BridgeCamFilter.dll"
set "SYS64=%windir%\System32\BridgeCamFilter.dll"
set "SYS32=%windir%\SysWOW64\BridgeCamFilter.dll"

:: ── 64-bit: copy then register ──────────────────────────────────────
if not exist "%DLL64%" (
    echo WARNING: 64-bit DLL not found at %DLL64%
    echo          Run: cmake --build build --config Debug
    echo.
) else (
    echo Copying  64-bit to %SYS64%
    copy /y "%DLL64%" "%SYS64%" >nul
    echo Registering 64-bit...
    regsvr32 /s "%SYS64%"
    if %errorlevel% neq 0 (
        echo FAILED x64 - error %errorlevel%
        pause & exit /b 1
    )
    echo OK - 64-bit registered.
)

:: ── 32-bit: copy then register ──────────────────────────────────────
if not exist "%DLL32%" (
    echo WARNING: 32-bit DLL not found at %DLL32%
    echo          Run: cmake -S . -B build32 -A Win32
    echo               cmake --build build32 --config Debug
    echo.
) else (
    echo Copying  32-bit to %SYS32%
    copy /y "%DLL32%" "%SYS32%" >nul
    echo Registering 32-bit...
    %windir%\SysWOW64\regsvr32.exe /s "%SYS32%"
    if %errorlevel% neq 0 (
        echo FAILED x86 - error %errorlevel%
        pause & exit /b 1
    )
    echo OK - 32-bit registered.
)

echo.
echo SUCCESS - BridgeCam Source is now visible to both 64-bit and 32-bit apps.
echo Restart NVIDIA Broadcast / Zoom / OBS if already running.
echo.
pause
