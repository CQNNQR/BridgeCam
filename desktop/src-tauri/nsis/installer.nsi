; SPDX-License-Identifier: GPL-3.0-or-later
; Copyright (C) 2026 BridgeCam Contributors

!macro NSIS_HOOK_POSTINSTALL
  IfFileExists "$INSTDIR\resources\BridgeCamMFSource_x64.dll" 0 bridgecam_driver_missing
  ${DisableX64FSRedirection}
  nsExec::ExecToLog '"$SYSDIR\regsvr32.exe" /s "$INSTDIR\resources\BridgeCamMFSource_x64.dll"'
  Pop $0
  ${EnableX64FSRedirection}
  ${If} $0 != 0
    DetailPrint "BridgeCam virtual camera registration failed (error $0)."
  ${EndIf}
  bridgecam_driver_missing:
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  IfFileExists "$INSTDIR\resources\BridgeCamMFSource_x64.dll" 0 bridgecam_no_driver
  ${DisableX64FSRedirection}
  nsExec::ExecToLog '"$SYSDIR\regsvr32.exe" /s /u "$INSTDIR\resources\BridgeCamMFSource_x64.dll"'
  Pop $0
  ${EnableX64FSRedirection}
  bridgecam_no_driver:
!macroend
