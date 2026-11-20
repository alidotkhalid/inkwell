; Inkwell replaces the earlier build of this app, which was installed under the name "Blue Pencil".
; If that build is still installed, remove it first so only one copy is left. Its settings are kept:
; Inkwell copies them across the first time it starts.
!define OLD_APP_GUID "d2f04069-d1cb-5689-a6aa-7000d8d8b19e"

!macro customInit
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${OLD_APP_GUID}" "QuietUninstallString"
  ReadRegStr $R1 HKCU "Software\${OLD_APP_GUID}" "InstallLocation"
  ${if} $R0 != ""
  ${andIf} $R1 != ""
    ; _?= makes the old uninstaller run in place, so we can wait for it to finish
    ExecWait '$R0 /KEEP_APP_DATA _?=$R1'
    Delete "$R1\Uninstall Blue Pencil.exe"
    RMDir "$R1"
  ${endIf}
!macroend
