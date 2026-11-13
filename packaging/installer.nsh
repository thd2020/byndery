; byndery's additions to electron-builder's NSIS installer.
;
; byndery-handoff.exe (src/handoff) is the COM class Windows 11 hands console
; programs to when byndery is the default terminal. The finish page offers to
; make byndery the default terminal; the uninstaller gives the choice back.

!define BYNDERY_HANDOFF '"$INSTDIR\resources\handoff\byndery-handoff.exe"'

!macro customInstall
  ; Updates and reinstalls keep the choice and point it at this copy.
  nsExec::Exec '${BYNDERY_HANDOFF} --refresh'
  Pop $0
!macroend

!macro customUnInstall
  ; An update runs the old uninstaller first; the choice stays for the new copy.
  ${ifNot} ${isUpdated}
    nsExec::Exec '${BYNDERY_HANDOFF} --disable'
    Pop $0
  ${endIf}
!macroend

!macro customFinishPage
  ; The same "Run byndery" box electron-builder shows by default.
  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  Function MakeDefaultTerminal
    nsExec::Exec '${BYNDERY_HANDOFF} --enable'
    Pop $0
  FunctionEnd

  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !define MUI_FINISHPAGE_SHOWREADME
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "Make byndery the default terminal (instead of PowerShell and Command Prompt windows)"
  !define MUI_FINISHPAGE_SHOWREADME_FUNCTION "MakeDefaultTerminal"
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW ShowDefaultTerminalChoice
  !insertmacro MUI_PAGE_FINISH

  ; Offered only on Windows 11 22H2 and later, and when byndery is not already the default.
  ; Defined after MUI_PAGE_FINISH, which declares $mui.FinishPage.ShowReadme.
  Function ShowDefaultTerminalChoice
    nsExec::Exec '${BYNDERY_HANDOFF} --can-enable'
    Pop $0
    ${if} $0 != 0
      SendMessage $mui.FinishPage.ShowReadme ${BM_SETCHECK} 0 0
      ShowWindow $mui.FinishPage.ShowReadme ${SW_HIDE}
    ${endIf}
  FunctionEnd
!macroend
