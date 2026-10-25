; TMMD NSIS hook file (wired via bundle.windows.nsis.installerHooks).
;
; Why this exists: Tauri's APP_ASSOCIATE writes HKCU\Software\Classes\.md (and .markdown) = "Markdown"
; plus HKCU\Software\Classes\Markdown\..., while APP_UNASSOCIATE on uninstall only deletes the ProgID
; key itself. Measured 2026-10-26 on a real uninstall: the extension kept pointing at a ProgID that no
; longer existed (a dead association - double-click falls back to "choose an app"), and the "Open with"
; leftovers naming this program survived. Details: docs/2026-10-25-验证清单.md section 9.3.
;
; ASCII ONLY: makensis reads .nsh using the machine's ANSI codepage, so CJK comments break parsing.

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