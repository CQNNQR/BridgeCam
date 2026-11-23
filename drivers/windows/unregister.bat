@echo off
:: Run this script as Administrator to unregister both 64-bit and 32-bit DLLs

set "DLL64=%~dp0build\Debug\BridgeCamFilter.dll"
set "DLL32=%~dp0build32\Release\BridgeCamFilter.dll"

if exist "%DLL64%" ( echo Unregistering 64-bit... & regsvr32 /u /s "%DLL64%" )
if exist "%DLL32%" ( echo Unregistering 32-bit... & %windir%\SysWOW64\regsvr32.exe /u /s "%DLL32%" )
echo Done.
pause
