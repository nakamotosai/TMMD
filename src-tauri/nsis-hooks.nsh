; TMMD NSIS hook file (wired via bundle.windows.nsis.installerHooks).
;
; Why this exists: Tauri's APP_ASSOCIATE writes HKCU\Software\Classes\.md (and .markdown) = "Markdown"
; plus HKCU\Software\Classes\Markdown\..., while APP_UNASSOCIATE on uninstall only deletes the ProgID
; key itself. Measured 2026-10-26 on a real uninstall: the extension kept pointing at a ProgID that no
; longer existed (a dead association - double-click falls back to "choose an app"), and the "Open with"
; leftovers naming this program survived. Details: docs/2026-10-25-验证清单.md section 9.3.
;
; ASCII ONLY: makensis reads .nsh using the machine's ANSI codepage, so CJK comments break parsing.
;
; Why POSTINSTALL exists: the in-app updater promises a restart ("installs silently, then restarts
; into the new version" - app.js upd.sub / upd.installing) but the helper script it writes only
; waits for the app to exit and runs this installer with /S: nothing brings the app back. Measured
; 2026-10-26 on a real 1.8.12 -> 1.8.16 in-app update: installer exit 0, file version 1.8.16, and
; zero TMMD processes afterwards. Silent installs now relaunch; the wizard path is untouched (its
; finish page already offers "run TMMD", and launching twice would be worse than not launching).

!macro NSIS_HOOK_POSTINSTALL
  IfSilent 0 tmmd_relaunch_done
    Exec '"$INSTDIR\tmmd.exe"'
  tmmd_relaunch_done:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; 1) Extension defaults: remove only when the current value is still the one WE wrote,
  ;    so a value the user changed afterwards is never touched.
  ReadRegStr $0 SHCTX "Software\Classes\.md" ""
  StrCmp $0 "Markdown" 0 tmmd_md_done
    DeleteRegValue SHCTX "Software\Classes\.md" ""
  tmmd_md_done:
  ReadRegStr $0 SHCTX "Software\Classes\.markdown" ""
  StrCmp $0 "Markdown" 0 tmmd_markdown_done
    DeleteRegValue SHCTX "Software\Classes\.markdown" ""
  tmmd_markdown_done:

  ; 2) "Open with" entries that name this program. The exe is gone, so these are dead links.
  DeleteRegValue SHCTX "Software\Classes\.md\OpenWithProgids" "TMMD.md"
  DeleteRegValue SHCTX "Software\Classes\.markdown\OpenWithProgids" "TMMD.md"
  DeleteRegKey SHCTX "Software\Classes\TMMD.md"
  DeleteRegKey SHCTX "Software\Classes\Applications\tmmd.exe"

  ; 3) Explorer's per-extension OpenWithProgids (exists on some systems).
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md\OpenWithProgids" "TMMD.md"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.markdown\OpenWithProgids" "TMMD.md"

  ; Deliberately NOT touched: ...\FileExts\.md\UserChoice. It is the user's own default-app choice,
  ; the OS refuses programmatic edits to it, and with the exe gone Windows asks again anyway.
!macroend