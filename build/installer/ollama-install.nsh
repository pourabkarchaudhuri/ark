; ─────────────────────────────────────────────────────────────────────────────
; Ollama AI Engine — Optional Installation Step
;
; Runs after Ark's own files are fully installed. Offers to download and
; silently install Ollama so the user gets semantic recommendations, the
; Galaxy Map, and AI-powered taste profiling out of the box.
;
; • Three-tier detection: default install path → Inno Setup registry → PATH.
; • Uses the INetC plugin (ships with electron-builder's NSIS resources)
;   for HTTPS download with a progress banner.
; • Ollama's Windows installer is Inno Setup; /VERYSILENT suppresses all UI.
; • On any failure the user is pointed to https://ollama.com/download and
;   Ark continues normally — the app degrades gracefully without Ollama.
; • During silent/unattended installs (/S flag), the Ollama step is skipped
;   via the /SD IDNO default on the MessageBox.
; ─────────────────────────────────────────────────────────────────────────────

!macro customInstall
  ; ── 1. Check if Ollama is already installed ───────────────────────────────

  ; 1a. Default Inno Setup install path
  IfFileExists "$LOCALAPPDATA\Programs\Ollama\ollama app.exe" _ark_ollama_found

  ; 1b. Inno Setup uninstall registry entry
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Ollama_is1" "InstallLocation"
  StrCmp $0 "" 0 _ark_ollama_found

  ; 1c. Ollama on PATH (covers winget / scoop / custom installs)
  nsExec::ExecToStack 'where ollama.exe'
  Pop $0
  StrCmp $0 "0" _ark_ollama_found

  ; ── 2. Ollama not detected — explain and offer installation ───────────────
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Ark includes an AI recommendation engine powered by Ollama.$\r$\n\
$\r$\n\
With Ollama installed, Ark can:$\r$\n\
$\r$\n\
  - Analyze your game library semantically$\r$\n\
  - Build a Galaxy Map of game relationships$\r$\n\
  - Deliver highly accurate, personalized recommendations$\r$\n\
$\r$\n\
Without Ollama, Ark still works but uses metadata-only$\r$\n\
scoring (~15% less accurate).$\r$\n\
$\r$\n\
For best performance, a dedicated GPU (NVIDIA / AMD)$\r$\n\
with 4 GB+ VRAM is recommended. Ollama will fall$\r$\n\
back to CPU if no compatible GPU is available.$\r$\n\
$\r$\n\
Install Ollama now? (~300 MB download)" \
    /SD IDNO IDNO _ark_ollama_skip

  ; ── 3. Download Ollama installer ──────────────────────────────────────────
  DetailPrint "Downloading Ollama AI engine..."
  SetDetailsPrint both

  inetc::get \
    /CAPTION "Downloading Ollama" \
    /BANNER "Downloading the Ollama AI engine for Ark..." \
    /TIMEOUT 600000 \
    "https://ollama.com/download/OllamaSetup.exe" \
    "$TEMP\OllamaSetup.exe" \
    /END
  Pop $0

  StrCmp $0 "OK" _ark_ollama_dl_ok

  ; Download failed or cancelled — clean up partial file
  DetailPrint "Ollama download failed: $0"
  Delete "$TEMP\OllamaSetup.exe"
  MessageBox MB_OK|MB_ICONEXCLAMATION \
    "Ollama could not be downloaded ($0).$\r$\n\
$\r$\n\
You can install it manually from:$\r$\n\
https://ollama.com/download$\r$\n\
$\r$\n\
Ark will continue to work without Ollama."
  Goto _ark_ollama_skip

_ark_ollama_dl_ok:
  ; ── 4. Run Ollama installer silently ──────────────────────────────────────
  DetailPrint "Installing Ollama (this may take a moment)..."
  ClearErrors
  ExecWait '"$TEMP\OllamaSetup.exe" /VERYSILENT /NORESTART /SUPPRESSMSGBOXES' $1
  IfErrors _ark_ollama_exec_err

  Delete "$TEMP\OllamaSetup.exe"
  IntCmp $1 0 _ark_ollama_install_ok _ark_ollama_install_warn _ark_ollama_install_warn

_ark_ollama_exec_err:
  ; ExecWait failed to launch the process (corrupted download, AV block, etc.)
  DetailPrint "Failed to launch Ollama installer"
  Delete "$TEMP\OllamaSetup.exe"
  MessageBox MB_OK|MB_ICONEXCLAMATION \
    "The Ollama installer could not be launched.$\r$\n\
It may have been blocked by your antivirus.$\r$\n\
$\r$\n\
You can install Ollama manually from:$\r$\n\
https://ollama.com/download$\r$\n\
$\r$\n\
Ark will continue to work without Ollama."
  Goto _ark_ollama_skip

_ark_ollama_install_warn:
  DetailPrint "Ollama installer exited with code: $1"
  MessageBox MB_OK|MB_ICONINFORMATION \
    "Ollama installation may not have completed successfully$\r$\n\
(exit code: $1).$\r$\n\
$\r$\n\
You can install it manually from:$\r$\n\
https://ollama.com/download$\r$\n\
$\r$\n\
Ark will continue to work without Ollama."
  Goto _ark_ollama_skip

_ark_ollama_install_ok:
  DetailPrint "Ollama installed successfully"
  Goto _ark_ollama_skip

_ark_ollama_found:
  DetailPrint "Ollama is already installed"

_ark_ollama_skip:
!macroend
