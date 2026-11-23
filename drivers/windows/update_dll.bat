@echo off
copy /Y "C:\Users\conno\OneDrive\old\Documents\CQNNQR\BridgeCam\drivers\windows\build\Debug\BridgeCamFilter.dll" "C:\ProgramData\BridgeCam\BridgeCamFilter.dll"
if %ERRORLEVEL% EQU 0 (
    echo SUCCESS: DLL updated in ProgramData
) else (
    echo FAILED: error %ERRORLEVEL%
)
echo Done.
pause
