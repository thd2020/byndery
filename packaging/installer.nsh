; byndery's additions to Tauri's NSIS installer (bundle.windows.nsis.installerHooks).
;
; - byndery 0.0.1 was an Electron build in %LOCALAPPDATA%\Programs\byndery.
;   Installing this version removes it, keeping settings, history and the
;   default-terminal choice (its uninstaller skips those with --updated).
; - byndery's Linux tools (MSYS2) unpack into %LOCALAPPDATA%\com.holarky.byndery
;   during install, so the first terminal opens at once. Updates keep them,
;   and the packages added to them.
; - byndery-handoff.exe (src/handoff) is the COM class Windows 11 hands console
;   programs to when byndery is the default terminal. An interactive install
;   offers it; uninstalling gives the choice back.

!define BYNDERY_HANDOFF '"$INSTDIR\handoff\byndery-handoff.exe"'
!define BYNDERY_OLD "$LOCALAPPDATA\Programs\byndery"

!macro NSIS_HOOK_PREINSTALL
  ${If} ${FileExists} "${BYNDERY_OLD}\Uninstall byndery.exe"
    DetailPrint "Removing byndery 0.0.1"
    ExecWait '"${BYNDERY_OLD}\Uninstall byndery.exe" /S --updated _?=${BYNDERY_OLD}'
    Delete "${BYNDERY_OLD}\Uninstall byndery.exe"
    RMDir /r "${BYNDERY_OLD}"
    ; Its shortcuts pointed into that folder; this install makes its own.
    Delete "$DESKTOP\byndery.lnk"
    Delete "$SMPROGRAMS\byndery.lnk"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Setting up byndery's Linux tools"
  nsExec::Exec '"$INSTDIR\byndery.exe" --seed-msys'
  Pop $0
  ; Keeps the default-terminal registration pointing at this copy.
  nsExec::Exec '${BYNDERY_HANDOFF} --refresh'
  Pop $0
  ${IfNot} ${Silent}
  ${AndIf} $UpdateMode <> 1
  ${AndIf} $PassiveMode <> 1
    ; 0: Windows 11 22H2 or later, and byndery is not the default yet.
    nsExec::Exec '${BYNDERY_HANDOFF} --can-enable'
    Pop $0
    ${If} $0 == 0
      MessageBox MB_YESNO|MB_ICONQUESTION "Make byndery the default terminal?$\r$\n$\r$\nPowerShell, Command Prompt and other console programs started from Start, Explorer or Run will open as byndery tabs instead of console windows. Settings > General can change this later." /SD IDNO IDNO byndery_no_default
      nsExec::Exec '${BYNDERY_HANDOFF} --enable'
      Pop $0
      byndery_no_default:
    ${EndIf}
  ${EndIf}
  ; 0.0.1's updater installs with /S --force-run when it should open byndery
  ; again afterwards (Tauri's own updates pass /R instead).
  ClearErrors
  ${GetOptions} $CMDLINE "--force-run" $0
  ${IfNot} ${Errors}
    nsis_tauri_utils::RunAsUser "$INSTDIR\byndery.exe" ""
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; An update keeps everything; a real uninstall gives Windows its choices back.
  ${If} $UpdateMode <> 1
    nsExec::Exec '${BYNDERY_HANDOFF} --disable'
    Pop $0
    nsExec::Exec '"$INSTDIR\byndery.exe" --unintegrate'
    Pop $0
  ${EndIf}
!macroend
