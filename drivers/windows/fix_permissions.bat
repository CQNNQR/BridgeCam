@echo off
:: Grant LOCAL SERVICE (Frame Server) and NETWORK SERVICE full access
:: to C:\ProgramData\BridgeCam so svchost can read framebuffer.dat and write logs.
:: Must run as Administrator!

echo Granting LOCAL SERVICE permissions on C:\ProgramData\BridgeCam ...
icacls "C:\ProgramData\BridgeCam" /grant "LOCAL SERVICE:(OI)(CI)F" /T
if %ERRORLEVEL% NEQ 0 (
    echo FAILED to set LOCAL SERVICE permissions.
    echo Try running as Administrator.
    pause
    exit /b 1
)

echo Granting NETWORK SERVICE permissions ...
icacls "C:\ProgramData\BridgeCam" /grant "NETWORK SERVICE:(OI)(CI)F" /T
if %ERRORLEVEL% NEQ 0 (
    echo FAILED to set NETWORK SERVICE permissions.
    pause
    exit /b 1
)

echo.
echo Verifying...
icacls "C:\ProgramData\BridgeCam"
echo.
echo SUCCESS: Permissions updated.
pause
