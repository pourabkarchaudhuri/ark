; Extra NSIS steps for the Ark installer (electron-builder nsis.include).
;
; customUnInstall: offer to delete the downloaded AI models. They live outside the install folder
; (%LOCALAPPDATA%\Ark\models, several GB), so the stock uninstaller never removes them.
;  - Only that one folder is ever touched; nothing else under %LOCALAPPDATA%\Ark or anywhere else.
;  - Skipped for silent uninstalls and for the uninstall that runs during an update, so models
;    survive updates and unattended removals.
;  - The answer defaults to No (keep).
;  - A models folder moved elsewhere in Settings is not covered (the uninstaller cannot read that setting).
!macro customUnInstall
  ${ifNot} ${isUpdated}
    IfSilent ark_models_done
    Push $R8
    ReadEnvStr $R8 LOCALAPPDATA
    StrCmp $R8 "" ark_models_pop
    IfFileExists "$R8\Ark\models\*.*" 0 ark_models_pop
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Ark saved AI models on this computer, in:$\r$\n$R8\Ark\models$\r$\n$\r$\nDo you also want to delete them to free up disk space? You can download them again later if you reinstall Ark.$\r$\n$\r$\n(If you moved the models folder in Settings, it is not removed.)" IDNO ark_models_pop
    RMDir /r "$R8\Ark\models"
    ark_models_pop:
    Pop $R8
    ark_models_done:
  ${endIf}
!macroend
