!define PRODUCT_NAME "BridgeCam Virtual Driver"
!define PRODUCT_VERSION "0.1"
!define PRODUCT_PUBLISHER "BridgeCam Project"
!define PRODUCT_DIR_REGKEY "Software\Microsoft\Windows\CurrentVersion\App Paths\bridgecamdriver.exe"

!include "MUI2.nsh"

Name "${PRODUCT_NAME}"
OutFile "BridgeCamDriverInstaller.exe"
InstallDir "$PROGRAMFILES\\BridgeCamDriver"

Page directory
Page instfiles

Section "Install"
    SetOutPath "$INSTDIR"
    File "BridgeCamFilter.dll"
    ; copy the DLL and then register it
    ExecWait 'regsvr32 /s "$INSTDIR\\BridgeCamFilter.dll"'
SectionEnd

Section "Uninstall"
    ExecWait 'regsvr32 /u /s "$INSTDIR\\BridgeCamFilter.dll"'
    Delete "$INSTDIR\\BridgeCamFilter.dll"
    RMDir "$INSTDIR"
SectionEnd