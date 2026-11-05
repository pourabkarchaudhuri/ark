# Ark v1.0.97 — fix plan (audit of the whole app)

Status: **plan only, nothing changed yet.** Generated 2026-10-30 from a read-only audit; every item below was confirmed by two independent reviewers reading the current code, then merged and re-checked per area.

## How this was built
- Audit: 8 areas × 3 lenses (correctness/security, memory leaks, performance), 3 rounds, each round told what earlier rounds found. 606 raw findings → 464 double-verified → 282 confirmed by both reviewers, 47 split votes, 135 rejected.
- Synthesis: per-area reviewers merged duplicates, settled the 47 split votes against the code, rechecked every fix; a merge pass removed 13 cross-area duplicates and grouped the rest into 34 batches.
- Result: **246 audit items + 12 from the earlier review = 258 fixes**.
- **Coverage gaps (honest):** the audit hit the 1,000-agent cap during round 3; ~140 round-3 findings were either repeats or left unverified (the log cannot tell which), and round 3 still produced 58 confirmed issues, so the search had not run dry. The final "what was missed" critic never ran. A second, capped audit after this release is recommended.

| | High | Medium | Low |
|---|---|---|---|
| security | 1 | 6 | 8 |
| correctness | 9 | 53 | 99 |
| performance | 3 | 23 | 36 |
| memory-leak | 0 | 3 | 5 |

Items that can change Oracle rankings: **20** (all in B34 or flagged in their batch) → one `ORACLE_ENGINE_VERSION` bump 14 → 15, golden top-20 reviewed once at the end.

## Act now (outside the code)
- **The installer ships the developer `.env` with the live Azure OpenAI key, the Steam Web API key and the GA secret** (`package.json:167` extraFiles). Every public installer since this entry was added contains them. My 1.0.84 `verify-release.mjs` allow-list wrongly treats the AZURE_* names as allowed. **Rotate the Azure OpenAI key now** (and the Steam key and GA secret). B01 fixes the build; rotation cannot wait for it.

## Decisions (user, 2026-10-30)
- **Analytics (`main-core#19`):** off by default, Settings toggle, game ids stripped from paths, privacy text corrected. `.analytics-cid` deleted on opt-out.
- **Chat provider (`main-apis#19`):** the provider chosen in Settings → AI Models is the only one a chat turn talks to. The Gemini "reviewer" runs only when Gemini itself is the chosen provider; no other provider is ever called behind the user's back.
- **Anthropic (`ui-other#3`, `ui-other#4`):** implemented for real through a bundled LiteLLM (Python) sidecar — new batch **B35**. `ui-other#4` changes from "hide it" to "make it work"; its key moves to main-side encrypted storage.
- **Badges (`ui-voyage#3`):** streak/backlog badges stay unlocked once earned (latched); XP and level never drop.
- **Built-in local AI (B36):** Ark ships its own llama.cpp runtime instead of requiring Ollama. Models are downloaded at runtime on the splash screen (installer and GitHub releases stay small). Oracle models are set up automatically; the chat model only when the user picks local chat. Ark always uses its own instance, on its own port and model folder; an advanced setting can point Ark at the user's own Ollama URL instead.
- **Settings redesign (B37):** the user-finalized Claude Design "Tracker Settings Page" ships in 1.0.97. Its AI providers page makes LiteLLM the router for chat, embeddings and reranking, so B35 now covers all three roles (not only Anthropic), with the built-in llama.cpp (B36) as the default connector.

## Ground rules
- One release (1.0.97), built batch by batch: each batch = its tests first, then the fix, then `tsc` (both projects) + `vitest --isolate`; commit per batch locally, ship once at the end with `ship.sh`.
- Order: security → main-process blockers → data-loss bugs → leaks/perf → UI → Oracle ranking last.
- No behaviour change beyond the fix; anything with UI copy changes is noted. Ranking changes only in B34.
- **Single release (user, 2026-10-30): every batch, B35 included, ships in 1.0.97. Nothing moves to a later release; if a batch is harder than described, the release waits for it.**

## High-severity items
- **Installer ships the developer .env with Azure OpenAI key, Steam Web API key and GA secret** (security) — `package.json:167`
- **Steam app-list sort with localeCompare options blocks the main process for many seconds** (performance) — `electron/steam-api.ts:1296`
- **System sleep while a game is running is counted as active playtime** (correctness) — `electron/session-tracker.ts:565`
- **ANN queryBatch runs 200 sequential HNSW searches synchronously on the main process per call** (performance) — `electron/ann-index.ts:627`
- **Library sorted cache goes stale after import and after boot hydration (old or empty library shown); import also skips date and status sanitising** (correctness) — `src/services/library-store.ts:1077`
- **useTrackerOverhead snapshot is a new array on every call, so the Telemetry tab crashes with 'Maximum update depth exceeded'** (correctness) — `src/services/tracker-overhead-store.ts:50`
- **Browse 'All'/Catalog adult-content check misses its cache on every game, every pass, and writes localStorage per miss** (performance) — `src/hooks/useDeferredFilterSort.ts:165`
- **Card Play action reads the raw browse object, which has no executablePath** (correctness) — `src/pages/dashboard.tsx:807`
- **An empty filter or search result shows the whole unfiltered list instead of the empty state** (correctness) — `src/pages/dashboard.tsx:394`
- **Library status change from a card reverts after 4 s; the deferred filter hook recomputes on stale data and then runs twice** (correctness) — `src/hooks/useDeferredFilterSort.ts:503`
- **Every 'Add to Library' from the dialog wipes addedAt, so that save and later status changes throw RangeError** (correctness) — `src/pages/dashboard.tsx:729`
- **Editing the hidden Gemini key saves the bullet characters as the real key** (correctness) — `src/components/settings-screen.tsx:1189`
- **Library import wipes library, journey, sessions and status history with no confirmation, while the UI says it merges** (correctness) — `src/components/settings-screen.tsx:230-248`

## Batches

### B01 Release secrets, packaging and identity (6)
_package.json build config, main.ts startup and analytics. Small, independent, highest security value. Verify with an installer build._

- **[high · security] Installer ships the developer .env with Azure OpenAI key, Steam Web API key and GA secret** `main-core#0`
  - Where: `package.json:167`, `electron/main.ts:22`, `electron/analytics.ts:22`, `electron/steam-api.ts:1260`
  - Problem: electron-builder extraFiles copies the project .env next to Ark.exe, and the installer is published on public GitHub releases. Anyone who installs Ark can open the file and read a working Azure OpenAI key (billable), the Steam Web API key and the GA Measurement Protocol secret. Packaged builds only use Azure in the --run-chat-prompts CLI.
  - Fix: Add a prebuild step (run by build:app) that writes build/.env.release from .env using an allowlist: STEAM_API_KEY, GA_MEASUREMENT_ID, GA_API_SECRET only, no AZURE_*. Point extraFiles at build/.env.release -> .env instead of the raw .env (deleting the entry outright breaks GetAppList/GetMostPlayedGames/GetTagList and analytics in packaged builds). Add an afterPack/CI check that fails if the packaged .env or any packaged file contains an AZURE_ name. Make steam-api send no key= param and degrade cleanly when the key is empty. Rotate the Azure key now, and also the Steam key and GA secret, since they shipped. Treat the Steam and GA values as extractable; a proxy or user-supplied Steam key is a later option.
  - Tests: Build-script unit test: given a fixture .env with AZURE_* and allowlisted keys, the generated file contains only the allowlisted keys. CI check: grep release/win-unpacked for AZURE_ and fail. Smoke test packaged build: Steam app list and most-played still load.
  - Risk: Low code risk. Main risk is forgetting a key that packaged code needs; the allowlist must be checked against every process.env read in electron/. Key rotation is an ops step that must happen regardless of the code change.
  - Coordinate with main-core#19: Removing the GA secret from the shipped .env changes how analytics.ts gets its config. Do the opt-out and config source change together, or ship analytics changes after secret removal.

- **[medium · correctness] AppUserModelId does not match the installer shortcut appId (dropped toasts, two taskbar icons)** `main-core#8`
  - Where: `electron/main.ts:316`, `package.json:148`
  - Problem: The app sets AppUserModelId 'com.ark.gametracker' but the installer shortcuts are stamped with build.appId 'com.ark.app'. Windows toasts (updater, Ark Wrapped) can be dropped or shown without Ark's name and icon, and the pinned shortcut and running window group as two taskbar icons. Only installed builds are affected.
  - Fix: Change the runtime call to app.setAppUserModelId('com.ark.app') from a shared constant, keep it at module top before any window or Tray is created, and leave build.appId unchanged (it is the NSIS uninstall key and updater identity). Add a test or build check that the constant equals package.json build.appId.
  - Tests: Unit test: AUMID constant === require('package.json').build.appId. Manual on installed build: updater toast shows with Ark icon; one taskbar icon when pinned.
  - Risk: Low. Users lose any per-app notification settings saved under the old id.

- **[low · correctness] Dev runs overwrite the installed app's Windows login item** `main-core#22`
  - Where: `electron/main.ts:951`, `electron/settings-store.ts:485`
  - Problem: Both startup and setAutoLaunch call setLoginItemSettings without an app.isPackaged check. A dev run registers node_modules electron.exe under the same Run value, so on a developer machine the installed Ark no longer starts at login.
  - Fix: Add applyLoginItem(enabled) that logs and returns when !app.isPackaged, otherwise calls app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] }). Call it from main.ts startup and SettingsStore.setAutoLaunch, still saving the preference.
  - Tests: Unit test: unpackaged -> setLoginItemSettings not called, preference saved; packaged -> called with --hidden.
  - Risk: Very low.

- **[low · security] Route changes including /game/:id are sent to Google Analytics with no opt-out** `main-core#19`
  - Where: `electron/analytics.ts:68`, `electron/ipc/analytics-handlers.ts:16`, `src/App.tsx:31`, `src/components/settings-screen.tsx:1840`
  - Problem: Every route change, including the id of each game opened, goes to GA4 with a persistent client id. There is no consent setting, and the Settings privacy text says no personal data leaves the machine unless a cloud AI provider is set up, which is not true.
  - Fix: Store an analyticsEnabled flag in the main-side settings store (default off, or ask once and treat no answer as off) and check it at the top of trackEvent so trackAppLaunch is covered. In trackPageView in main, normalize the path (replace /game/[^/?#]+.* with /game, drop query and hash). Allow-list event names, param keys and primitive values with length limits in analytics-handlers. Add a Settings toggle over IPC, delete .analytics-cid on opt-out, and update the privacy text.
  - Tests: Unit tests: trackEvent does nothing when disabled; /game/123?x=1 is sent as /game; unknown event name returns false; opt-out deletes the cid file.
  - Risk: Low. Default-off reduces analytics volume; that is a product decision to confirm.

- **[low · security] Developer-only full-catalog crawl is callable from the production renderer** `main-core#20`
  - Where: `electron/ipc/catalog-handlers.ts:208`, `electron/ipc/index.ts:37`, `electron/preload.cjs:218`
  - Problem: catalog:runFullCatalogAdultFilterTest is registered in packaged builds. One call starts an hour-long crawl of about 150k apps through the shared Steam rate limiter, slowing normal Steam calls, risking 429s, and writing files into the install directory; repeated calls stack.
  - Fix: In catalog-handlers register(), register the handler only when !app.isPackaged, leaving the exported function for the CLI path at main.ts:784. Remove the window.catalog binding from preload (or gate it on a flag passed via additionalArguments). Make getDocsDir() use path.join(app.getPath('userData'), 'docs') when packaged. Update src/vite-env.d.ts and docs/porn-vs-mature-filter-analysis.md.
  - Tests: Unit test: with app.isPackaged = true the channel is not registered; CLI flag path still runs the function.
  - Risk: Very low.

- **[medium · earlier review] Publish retry blocked by a half-uploaded asset of the same name; curl failure counted as success**
  - Where: `scripts/publish-github-release.mjs:53`
  - Fix: Delete non-"uploaded" assets with the same name before each attempt; check the HTTP status.

### B02 Navigation, CSP and webview hardening (7)
_main.ts navigation guard plus webview-handlers. Test by clicking links, Buzz, Decode Bay and markdown images._

- **[medium · security] Main window navigation guard and dev-server switch are too loose in packaged builds** `main-core#2`
  - Where: `electron/main.ts:460`, `electron/main.ts:436`, `electron/overlay-window.ts:89`, `electron/preload.cjs:649`, `src/components/game-details.tsx:2601`
  - Problem: will-navigate treats any file:// URL (including UNC hosts like file://attacker/share), any http://localhost* host (e.g. localhost.attacker.tld), or everything when getURL() is empty as internal. A protocol-relative href in sanitized Steam/Epic description HTML resolves to file://host/... and can navigate the privileged window (full preload bridge) to a remote SMB page, also leaking NTLM credentials. Separately, a packaged build loads http://localhost:5173 and opens DevTools when NODE_ENV=development is set in the user's environment, giving a blank window or handing the bridge to whatever listens on that port.
  - Fix: Add useDevServer = !app.isPackaged && !isProd && !isTest and use it for loadURL/openDevTools in main.ts and overlay-window.ts; in packaged builds always loadFile(indexPath). Add one isAppUrl(u) helper using new URL in try/catch: packaged allows only protocol 'file:', empty host and pathname === pathToFileURL(indexPath).pathname (any hash); dev allows only origin === new URL(devUrl).origin; never compare to getURL(). Use it in will-navigate and a new will-redirect handler, preventDefault on everything else, and call shell.openExternal only for http:/https:. In the renderer, handleContentLinkClick should preventDefault every anchor click and open only http(s) externally (treat // as https), and add a DOMPurify afterSanitizeAttributes hook that rewrites // hrefs to https:// and strips non-http(s)/mailto hrefs. Make preload's dev check use a flag from main via additionalArguments, not NODE_ENV.
  - Tests: Unit tests for isAppUrl: index path with hash allowed; file://host/x.html, file:///C:/other.html, http://localhost.evil.tld, http://localhost:5173 (packaged) rejected; dev origin allowed only when unpackaged. Renderer test: sanitized HTML with href="//host/x" ends up as https://host/x. Manual: packaged build with NODE_ENV=development still loads index.html without DevTools.
  - Risk: Medium-low. A wrong pathname comparison would block the app's own hash-route navigation, so test both dev and packaged. Unpackaged electron:dev, e2e and test flows must keep their current behavior.
  - Coordinate with ui-browse-details#16, ui-other#8: All touch the main.ts will-navigate/openExternal guard (~460). Tightening navigation must allow steam: URLs (ui-other#8) and block file:// navigation from relative links (ui-browse-details#16).

- **[low · security] Relative links in descriptions navigate the main window to a file:// path and blank the app** `ui-browse-details#16`
  - Where: `src/pages/game-details.tsx:420`, `src/pages/game-details.tsx:318`, `electron/main.ts:460`
  - Problem: Clicking a relative link in an Epic description (for example /en-US/p/slug) loads a missing local file in the main window: white screen, all state lost, restart needed. A '#x' link sends the app to an unknown route. The navigation guard allows any file:// URL and passes other URLs to the OS with no protocol check.
  - Fix: In handleContentLinkClick, for any clicked anchor with an href, always preventDefault and read the raw `anchor.getAttribute('href')`. '//x' -> prefix https:; '/x' -> resolve against the source store origin (https://store.epicgames.com for Epic, https://store.steampowered.com for Steam); '#x' -> ignore; otherwise open only if new URL(raw) parses with http: or https:. In main.ts will-navigate, allow only the URL (minus hash) equal to pathToFileURL(indexPath).href, keep localhost only when isDev, and run the same http/https/mailto allowlist as shell:openExternal before calling it.
  - Tests: Unit test the link resolver for '/en-US/p/x', '//cdn/x', '#x', 'javascript:x'. main.ts test: will-navigate to file:///C:/other is prevented; index.html with a hash is allowed; non-allowlisted protocols are not opened.
  - Risk: Non-http in-description anchors no longer work; acceptable.

- **[low · security] Renderer hardening: no CSP, sandbox off, and the Google AI key is readable from the renderer** `main-core#24`
  - Where: `electron/main.ts:418`, `electron/overlay-window.ts:210`, `index.html:1`, `electron/ipc/settings-handlers.ts:25`, `src/components/settings-screen.tsx:530`
  - Problem: There is no Content-Security-Policy, so any future bypass of DOMPurify could run inline script with the full preload bridge. Both windows use sandbox:false although the preload does not need Node. settings:getApiKey returns the decrypted Google AI key to the renderer, while gg.deals keys are write-only, and Azure/Anthropic keys sit in plain localStorage. No current exploit path was found; this is defense in depth.
  - Fix: Add a CSP for packaged file:// loads only, via session.defaultSession.webRequest.onHeadersReceived so the overlay gets it too: default-src 'self'; script-src 'self' (add 'wasm-unsafe-eval' if ONNX/three need it); style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' https: data: blob:; media-src https: blob:; connect-src 'self' (verify no renderer fetches); worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'. Set sandbox:true on both windows. Replace settings:getApiKey with getApiKeyHint returning { has, hint: first4…last4 }; in settings-screen show the hint as a placeholder, keep the field empty, and apply the reveal toggle only to typed text. In the same change move Azure and Anthropic keys from localStorage into settingsStore's encrypted, write-only storage.
  - Tests: Packaged smoke test with CSP: no CSP violations in console across main screens, game details with videos, charts, galaxy view, overlay. Settings test: stored key shows hint, empty save does not overwrite, new key saves. Migration test: localStorage keys move to settingsStore and are removed.
  - Risk: Medium. A too-strict CSP breaks fonts, inline styles, wasm or media; roll out with a violation log pass first. Key migration must not lose existing keys.
  - Coordinate with ui-other#16: A CSP img-src policy (main-core#24) is one fix for remote markdown images (ui-other#16). Decide the CSP first, then the markdown image handling.

- **[low · security] AI chat markdown loads remote images automatically, a zero-click data leak channel** `ui-other#16`
  - Where: `src/components/ai-chat-panel.tsx:344-355`
  - Problem: Assistant messages render markdown images as real img tags and there is no content security policy. A prompt-injected review or web result can make the model output an image URL carrying library titles or chat text, which loads as soon as the message renders.
  - Fix: In the ReactMarkdown components add img: ({ alt, src }) => <a href={src} target="_blank" rel="noopener noreferrer">{alt || 'image'}</a> (or disallowedElements={['img']} with unwrapDisallowed), and pass a urlTransform that only allows http(s) links. Do not ship a renderer-wide CSP img-src in this release; if added later, start with Report-Only after inventorying image hosts.
  - Tests: Rendering assistant content '![x](https://evil/p?d=1)' produces no img element and makes no network request; a link with text 'x' appears. javascript: links are stripped.
  - Risk: Low. Legit images in chat become links.

- **[low · security] Buzz inline web view lets any page window.open launch the OS browser, and has no download handler** `main-core#17`
  - Where: `electron/ipc/webview-handlers.ts:93`
  - Problem: setWindowOpenHandler sends every http(s) window.open target to shell.openExternal with no gesture check, disposition check or rate limit, and Electron has no popup blocker here, so ad scripts on an article can open browser tabs repeatedly, even while Ark is in the background. There is no will-download handler, so a download link inside the view pops a native Save dialog.
  - Fix: Track the last mouseDown/keyDown time per view via wc.on('before-input-event'). In setWindowOpenHandler always return { action: 'deny' } and call openExternal only when the URL is http(s), disposition is foreground-tab or new-window, input happened in the last ~1 s, the main window is focused, and no external open happened in the last ~3 s. Give the view its own non-persistent partition ('decode-bay') and register one will-download listener on that session in register() that calls preventDefault (never inside webview:open, which would stack listeners).
  - Tests: Unit tests: window.open without recent input is denied; with a click it opens once; a second within 3 s is denied; background-tab is denied; will-download on the view session is cancelled and main-session downloads are unaffected.
  - Risk: Low-medium. A separate partition drops shared cookies, so sites the user was logged into inside Buzz will be logged out once; check that the ad-block hook is also attached to the new session.

- **[low · correctness] Main renderer reload or crash leaves the Buzz web view attached, and a tripped crash breaker leaves a dead black window** `main-core#12`
  - Where: `electron/ipc/webview-handlers.ts:193`, `electron/main.ts:494`, `electron/main.ts:500`, `electron/main.ts:548`, `electron/main.ts:1117`, `electron/main.ts:327`, `electron/main.ts:979`
  - Problem: When the main renderer crashes and is reloaded (or does a full reload), the React cleanup that closes the inline WebContentsView never runs, so the old article view stays stacked over the new UI, keeps running its page and holds a renderer process until another article is opened. Separately, after three crashes in 30 s the breaker stops reloading and nothing ever reloads again: tray Show, double-click, second-instance and showAndFocus reveal a frameless black window with no controls.
  - Fix: In createWindow in main.ts (not webview-handlers.register, which runs before the window exists): call destroyWebContentsView() at the top of the render-process-gone handler before the clean-exit and breaker returns, and add mainWindow.webContents.on('did-start-navigation', d => { if (d.isMainFrame && !d.isSameDocument) destroyWebContentsView(); }). When the breaker trips, set rendererDead = true. Add revealMainWindow() used by all show/focus paths: if rendererDead or webContents.isCrashed(), show dialog.showMessageBox with 'Restart Ark' (app.relaunch(); app.exit(0)) and 'Quit' instead of a blind show().
  - Tests: Unit tests with mocked BrowserWindow: render-process-gone destroys the active view; hash-route navigation (isSameDocument) keeps it; full navigation destroys it. Breaker trip sets rendererDead and revealMainWindow shows the dialog instead of show().
  - Risk: Low. Must keep the isSameDocument filter so normal hash routing does not close articles.
  - Coordinate with main-core#17, ui-other#24: All modify webview-handlers.ts (attach/detach, window.open, download handlers, double open). Edit together.

- **[low · correctness] Decode Bay webview opens twice, reloading the page, when the first measured size is zero** `ui-other#24`
  - Where: `src/components/buzz-view.tsx:229-241`, `src/components/buzz-view.tsx:266`, `electron/ipc/webview-handlers.ts`
  - Problem: When the panel is still animating, both a resize observer and a 400 ms fallback timer try to open the webview. The observer opens it, then the timer opens it again, which destroys and reloads the page and flickers the spinner.
  - Fix: Add let opened = false. In the observer callback, clearTimeout(openTimer); openTimer = null before tryOpen(). tryOpen returns early if cancelled || opened, sets opened = true just before api.open once bounds are non-zero, and resets to false if the result is not success.
  - Tests: Fake timers: zero bounds then observer fires with size at 100 ms; advance to 500 ms; api.open called once.
  - Risk: Very low.

### B03 Exe analysis and launch paths (4)
_exe-info-handlers, dialog and launch handlers, and the steam: URL allowance. Self-contained IPC surface._

- **[medium · security] exe-info:analyze builds a shell command from the exe path (command injection, broken on [ ] and curly quotes)** `main-core#3`
  - Where: `electron/ipc/exe-info-handlers.ts:137`, `electron/ipc/exe-info-handlers.ts:127`
  - Problem: The handler puts the exe path inside a cmd.exe/PowerShell command string via exec. A path like C:\x" & calc & ".exe passes the checks and runs a second command; the path can come from imported library data, not only a compromised renderer. Paths with [ ] (treated as wildcards by -FilePath) or curly apostrophes silently fail, so no signer data is returned.
  - Fix: Use execFile('powershell.exe', ['-NoProfile','-NonInteractive','-Command', SCRIPT], { env: { ...process.env, ARK_EXE: exePath }, windowsHide: true, timeout: 10000 }) with no shell, where SCRIPT is a constant: [Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-AuthenticodeSignature -LiteralPath $env:ARK_EXE | ... (keep the existing ToString/ConvertTo-Json parts). Reject paths containing " < > | ? * or control characters up front, and skip the PowerShell step when stat fails.
  - Tests: Handler tests with mocked execFile: the path never appears in argv, only in env; paths with quotes/pipes are rejected; a path with [GOTY] and a curly apostrophe is passed through unchanged in env. Manual: a real signed exe in a folder with brackets returns signer data.
  - Risk: Low. Output parsing stays the same. UTF-8 output encoding change could alter how non-ASCII signer names decode; that is the intended fix.
  - Coordinate with main-core#6, main-core#21: exe-info-handlers.ts analyze path and launcher heuristic share code (127-185). Picker filter changes affect what analyze receives.

- **[medium · correctness] Launcher heuristic flags first-party games as launchers because it matches publisher signer names** `main-core#6`
  - Where: `electron/ipc/exe-info-handlers.ts:185`, `src/hooks/useSessionTracker.ts:107`
  - Problem: isLikelyLauncher is true when the Authenticode signer contains Valve, Electronic Arts, Riot, Rockstar, Epic, Bethesda and so on. Those publishers sign their own games (cs2.exe, GTA5, VALORANT, Fortnite), so with auto status transition on, these games are never promoted from Want to Play to Playing and are wrongly stamped launcherDetected.
  - Fix: Add a lowercase Set of known launcher basenames (steam.exe, steamwebhelper.exe, eadesktop.exe, origin.exe, epicgameslauncher.exe, battle.net.exe, battle.net launcher.exe, riotclientservices.exe, riotclientux.exe, upc.exe, ubisoftconnect.exe, galaxyclient.exe, bethesdanetlauncher.exe, rockstarlauncher.exe, launcher.exe, playgtav.exe, launcherpatcher.exe). Set isLikelyLauncher = knownBasename || (nameLooksLikeLauncher && signerLooksLikeLauncher). Drop the signer-only branch, match 'loader'/'bootstrap' on word boundaries, and remove the broad 'Origin' and 'GOG' signer substrings. In useSessionTracker, clear a stale launcherDetected:true when analyze now returns false.
  - Tests: Table test of the heuristic: cs2.exe signed Valve -> false; steam.exe -> true; GTA5.exe signed Rockstar -> false; PlayGTAV.exe -> true; MyGameLauncher.exe signed Ubisoft -> true; MyGameLauncher.exe unsigned -> false. Hook test: stale launcherDetected is cleared.
  - Risk: Low. Some real third-party launchers not on the list may stop being flagged; they still get caught when the name contains launcher and the signer matches.

- **[medium · correctness] Audit 'Open it' button never launches Steam games because main blocks steam: URLs** `ui-other#8`
  - Where: `src/components/journey-audit-view.tsx:1046`, `src/components/journey-audit-view.tsx:447`, `src/components/journey-audit-view.tsx:1104`, `electron/ipc/window-handlers.ts:64`, `electron/preload.cjs:16`
  - Problem: For Steam games with no playtime, the audit offers 'Open it', which calls openExternal with a steam://rungameid URL. The main-process handler only allows http, https, mailto and magnet, so the click silently does nothing.
  - Fix: Add a narrow IPC 'steam:launchGame' (appId: number) in window-handlers.ts; validate Number.isInteger(appId) && appId > 0 && appId < 2**32, then shell.openExternal(`steam://rungameid/${appId}`) and return {success, error}. Expose in preload.cjs and type in vite-env.d.ts. In applyLaunch, await it and toast on failure ('Steam is not installed or could not be opened'). Do not add steam: to the generic allowlist.
  - Tests: Handler test: valid id calls shell.openExternal with the exact URL; non-integer, negative or string ids are rejected without calling it. Component test: failure result shows a toast.
  - Risk: Low. New narrow IPC; input strictly validated.

- **[low · correctness] Executable picker accepts .lnk/.bat/.cmd that tracking and launching then silently reject** `main-core#21`
  - Where: `electron/ipc/dialog-handlers.ts:123`, `electron/ipc/session-handlers.ts:22`, `electron/ipc/launch-handlers.ts:44`, `src/components/journey-audit-view.tsx:1034`
  - Problem: The picker offers exe, lnk, bat and cmd, and callers store any chosen path, but session tracking and launch only accept .exe. A user who picks a shortcut or batch file gets a game that is never tracked and is told 'Executable path stored'.
  - Fix: Set the filter to { name: 'Executables', extensions: ['exe'] } plus All Files. In dialog:selectExecutable return { success: false, error: "Pick the game's .exe (shortcuts and .bat/.cmd files cannot be tracked)" } for non-.exe paths, using one shared isValidExePath helper also used by session-handlers and launch-handlers. In custom-game-dialog, game-dialog, my-progress-tab and journey-audit-view show result.error, and in journey-audit only resolve the finding on success. Optional: resolve .lnk with shell.readShortcutLink and accept an .exe target.
  - Tests: Handler test: .bat returns success:false with error; .exe returns the path. Component tests: error is shown and journey-audit finding stays open.
  - Risk: Low.

### B04 Main lifecycle and PersistentCache (7)
_persistent-cache.ts and the main.ts quit/shutdown path. Order: cache policy, then app-list split, then shutdown flush of all caches._

- **[medium · correctness] Windows shutdown or log-off skips all quit cleanup** `main-core#5`
  - Where: `electron/main.ts:541`, `electron/main.ts:1153`, `electron/main.ts:1176`
  - Problem: On Windows, before-quit/will-quit are not emitted during shutdown, restart or log-off, and nothing listens for session-end. The active play session is not finalized (only recovered on next launch), debounced chat and cache writes are lost, and the clean-exit marker is not written, so a shutdown inside the 3-minute stable window counts as an abnormal boot.
  - Fix: Move the synchronous before-quit body into finalizeShutdownSync(), guarded by a once flag: stopSessionTracker, steamAPI.flushCache, epicAPI.flushCache, chatStore.flushSync, markCleanExit. Call it from before-quit and from mainWindow.on('session-end') (attached in createWindow) after setting isQuitting = true, then app.quit(). In the session-end path do only sync work plus a fire-and-forget getLevelStore().close(), skip overlay teardown, and run session finalisation first. Optionally add powerMonitor.on('shutdown') for macOS/Linux.
  - Tests: Unit test finalizeShutdownSync: calling it twice runs each step once; session-end handler sets isQuitting and calls the steps synchronously (mocked modules). Manual: start a session, log off Windows, relaunch: session is finalized and no abnormal-boot count.
  - Risk: Low. Running finalization twice is prevented by the guard. Windows gives about 5 s, so keep the path synchronous and short.
  - Coordinate with main-apis#16, main-apis#12, main-core#11, main-core#10: Quit cleanup in main.ts:1153-1176 and PersistentCache save/flush policy are intertwined. Moving the Steam app list out of the cache (main-core#10) changes flush sizes. Fix persistent-cache first, then wire shutdown and session-end paths to flush all caches.

- **[medium · correctness] Ad-block engine cache is never refreshed, and a bad cache file disables blocking permanently** `main-core#4`
  - Where: `electron/main.ts:1006`, `electron/main.ts:1024`, `electron/main.ts:1056`
  - Problem: Once adblocker-engine.bin exists it is always used, so filter lists stay at their first-install contents forever. If deserialize throws (library version bump changes ENGINE_VERSION, or a truncated file from a crash mid-write), the outer catch logs 'non-fatal' and returns before onBeforeRequest is registered, and the bad file is never deleted, so tracker blocking stays off on every launch with no notice. The one-time sync parse on first run is minor.
  - Fix: Name the cache with the engine version (adblocker-engine-${ENGINE_VERSION}.bin from @ghostery/adblocker, or app.getVersion() if not exported) and best-effort delete older adblocker-engine*.bin files. Wrap only the deserialize in its own try/catch; on failure unlink the file and fall through to download/parse in the same launch. Check r.ok on each list fetch. Write atomically to cachePath + '.tmp' then rename. Register onBeforeRequest once with a closure reading a mutable let engine. If the cache mtime is older than 7 days, refresh in the background after startup (same 15 s timeout) and reassign engine only on a successful parse; keep the old engine on failure. Keep the sync parse; no worker needed.
  - Tests: Unit tests with a mocked fs/fetch: corrupt cache -> file unlinked, lists downloaded, blocking active; version-mismatch filename -> fresh build; 8-day-old cache -> cached engine used immediately and swapped after background refresh; refresh failure keeps old engine; non-ok fetch is not parsed or cached.
  - Risk: Low. Background refresh adds one download per week. Make sure the handler is not registered twice.

- **[low · correctness] PersistentCache eviction and save policy: long-lived entries evicted first, no max-wait, isDirty race** `main-core#11`
  - Where: `electron/persistent-cache.ts:151`, `electron/persistent-cache.ts:116`, `electron/persistent-cache.ts:129`
  - Problem: Over 2,000 entries, set() evicts by write order with no protection for long-lived entries, so the app list and tag list are dropped after a long browsing session and then re-downloaded. The save is a trailing-only 15 s debounce, so during a long active burst nothing reaches disk and a crash loses that burst's entries. The async save callback clears isDirty even if a newer set() arrived after the snapshot, and flushSync rewrites the whole file even when clean.
  - Fix: In set(), when over the cap: first delete entries where now - timestamp > expiresAfter(e) (never entries still within expiresAfter, which allowStale callers need); then evict oldest-first skipping ttl >= LONG_LIVED_TTL, falling back to long-lived only if they alone exceed the cap. In saveToDisk add a max-wait: record firstDirtyAt; if a timer is pending and 60 s have passed, do not re-arm; otherwise re-arm with min(15000, 60000 - elapsed); reset when it fires. Add a generation counter incremented in set()/clear(), capture it before stringify, and set isDirty = false only if unchanged. Then change flushSync's guard to return when !isDirty (only together with the counter).
  - Tests: Unit tests with fake timers: 2,001 short-lived sets keep the long-lived entry; expired entries are swept first; steady sets every 5 s still save by 60 s; a set during an in-flight save keeps isDirty true and is flushed at quit; flushSync is a no-op when clean.
  - Risk: Low. The flushSync change without the generation counter would lose writes, so ship them together. Session-end flush is covered by the shutdown item.

- **[low · performance] PersistentCache.flushSync rewrites the whole cache on quit even when nothing changed** `main-apis#12`
  - Where: `electron/persistent-cache.ts:233`
  - Problem: The early return only fires when the cache is clean and empty, so the large Steam and Epic caches are re-serialized synchronously on every quit, adding hundreds of ms to shutdown.
  - Fix: Track versions: `version` incremented in set()/clear(), `savedVersion` updated after a successful save (capture v before stringify; savedVersion = max(savedVersion, v)). In flushSync clear any pending timer, then return when version === savedVersion; after a sync write set savedVersion = version.
  - Tests: flushSync on a clean non-empty cache performs no write; a set() during an in-progress async save is still written by flushSync.
  - Risk: None.

- **[low · performance] Steam app list lives in the shared JSON cache: parsed at startup and re-stringified on every save** `main-core#10`
  - Where: `electron/persistent-cache.ts:94`, `electron/persistent-cache.ts:129`, `electron/steam-api.ts:1299`, `electron/steam-api.ts:339`
  - Problem: The 155k-entry app list (about 7 MB) is stored in steam-cache.json with a 24 h TTL. The cache is read and parsed synchronously at module import, before the window exists (about 155 ms measured), and every debounced save stringifies the whole file again on the main thread (tens of ms), including a full synchronous rewrite at every quit even when nothing changed.
  - Fix: Take 'full-app-list-v2' out of PersistentCache. In SteamAPI keep it in a private field backed by steam-applist.json: write it with atomicWriteFile only in refreshAppList, and load it lazily on the first getAppList() with fs.promises.readFile behind a memoised promise (getAppList is already async). On first load, migrate from the old cache key if present, then delete that key. Optionally make PersistentCache loading lazy via a sync ensureLoaded() called at the top of get/set/has/hasStale/isStale/flushSync/getStats (flushSync must load first so it never writes an empty map).
  - Tests: Unit tests: getAppList reads the new file once and memoises; refreshAppList writes it; old cache entry is migrated and removed; steam-cache.json no longer contains the app list after a save. Startup check: Steam cache load time drops.
  - Risk: Low. One-time migration path; if it fails the list is just refetched.

- **[low · correctness] HLTB and gg.deals caches are not flushed on quit, losing recent lookups** `main-apis#16`
  - Where: `electron/main.ts:1164`, `electron/hltb-api.ts:308`, `electron/ggdeals-api.ts:251`
  - Problem: Only Steam and Epic caches are flushed in before-quit; HLTB and gg.deals rely on a 15s debounced save, so entries from the last seconds are refetched next launch.
  - Fix: In each module keep `let defaultCache: PersistentCache | null = null` set in createDefaultClient, and export flushHltbCache()/flushGgDealsCache() that call defaultCache?.flushSync(). Call both in before-quit inside try/catch next to the steam/epic flushes (before-quit cannot await the client promises).
  - Tests: After a set() and immediate flush hook call, the cache file contains the entry.
  - Risk: Small sync write at quit only when dirty (pairs with the flushSync dirty-check fix).

- **[low · correctness] withTimeout leaves its timer armed when the promise rejects** `main-core#23`
  - Where: `electron/main.ts:104`
  - Problem: The timer is only cleared on success. If the wrapped call fails (e.g. ad-block download while offline), a misleading 'timed out' warning is logged 15-20 s later.
  - Fix: return Promise.race([promise, new Promise<null>(resolve => { timer = setTimeout(() => { logger.warn(...); resolve(null); }, ms); })]).finally(() => clearTimeout(timer)); and drop the promise.then clearTimeout wrapper.
  - Tests: Fake-timer test: rejected promise -> no timeout log after ms; slow promise -> timeout log and null.
  - Risk: Very low.

### B05 Overlay and hotkeys (3)
_main.ts overlay block plus overlay-window.ts only._

- **[medium · correctness] Overlay hotkeys Ctrl+Shift+O and Win+Shift+D are grabbed system-wide even with the overlay off** `main-apis#39`
  - Where: `electron/main.ts:537`, `electron/main.ts:621`
  - Problem: The overlay is off by default, but its global shortcuts are always registered, so Ctrl+Shift+O stops working in Chrome, VS Code and other apps while Ark runs.
  - Fix: Extract applyOverlayHotkeys(enabled) in main.ts that calls registerOverlayHotkey/registerOverlayCycleHotkey when enabled and unregisterOverlayHotkey() otherwise. Call it at startup with settingsStore.getOverlayEnabled() and from settings:setOverlayEnabled after saving (via a hook so handlers are not duplicated).
  - Tests: Overlay disabled at startup registers no shortcut; toggling on/off registers/unregisters.
  - Risk: Low.

- **[medium · correctness] Overlay hotkey dismiss is undone within 15s and rebuilds the overlay window each time** `main-apis#26`
  - Where: `electron/main.ts:610`, `electron/main.ts:623`, `electron/session-tracker.ts:683`
  - Problem: Pressing Ctrl+Shift+O hides the HUD, but the next poll sees a running game and shows it again, creating a brand-new overlay window and renderer each time.
  - Fix: In the hotkey dismiss branch (main.ts:623-624) call deactivateOverlay() but do not call syncOverlayVisibilityLatch(false), so the latch keeps meaning 'show edge already handled' for this session. The level-triggered hide path resets the latch when activeSessions drops to 0, so the next game shows the HUD. In the overlay callback, when shouldShow is true but the overlay is disabled, do nothing and keep the latch.
  - Tests: Dismiss with an active session: subsequent pollTicks do not call activateOverlay; after all sessions end and a new one starts, HUD shows again; hotkey re-show still works.
  - Risk: Low; settings toggle-off path is unchanged.
  - Coordinate with main-apis#39, main-core#13: All in main.ts:537-623 overlay hotkey and overlay window lifecycle. Make registration conditional, the dismiss state sticky, and crash recovery consistent in one change.

- **[low · correctness] In-game overlay HUD has no crash recovery** `main-core#13`
  - Where: `electron/overlay-window.ts:224`, `electron/main.ts:353`, `electron/main.ts:621`
  - Problem: The overlay window has no render-process-gone handler. With renderer-process-limit=1 it likely shares a process with the main UI, so a main-UI crash also kills the HUD; the main window is reloaded but the overlay stays blank and isOverlayVisible stays true until the user toggles the hotkey twice or the session ends.
  - Fix: In createOverlayWindow add overlayWindow.webContents.on('render-process-gone', (_e, d) => { if (d.reason === 'clean-exit') return; setImmediate(() => { if (win !== overlayWindow) return; const wasVisible = isOverlayVisible(); destroyOverlay(); if (wasVisible && crashBudgetOk()) activateOverlay(); else syncOverlayVisibilityLatch(false); }); }), with its own rolling limit of 3 recreates per 60 s, separate from the main safe-mode counter. Do not change renderer-process-limit or the overlay partition.
  - Tests: Unit test with mocked BrowserWindow: non-clean crash destroys and recreates once when visible; clean-exit does nothing; 4 crashes in 60 s leave it destroyed with latch false; a stale window's handler does not touch a newer overlay.
  - Risk: Low. Destroy/recreate reuses the existing lifecycle hooks so session-tracker rebinds its webContents ref.

### B06 Steam API client and Steam handlers (8)
_steam-api.ts, steam-handlers and event-scraper. RateLimiter first. main-core#1 adds the shared collator that B20 reuses._

- **[high · performance] Steam app-list sort with localeCompare options blocks the main process for many seconds** `main-core#1`
  - Where: `electron/steam-api.ts:1296`, `src/hooks/useDeferredFilterSort.ts:381`, `src/components/dashboard.tsx:422`
  - Problem: refreshAppList sorts about 155k names in the main process with localeCompare(b, undefined, {sensitivity:'base'}), which builds a collator per comparison. Measured at about 19 s versus about 0.5 s with a reused Intl.Collator. It runs on first launch and every daily background refresh, freezing IPC, window events and request hooks.
  - Fix: Add a module-level const NAME_COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base' }) and sort with allApps.sort((a, b) => NAME_COLLATOR.compare(a.name, b.name)). Keep the sort: catalog-handlers.ts:100 slices the sorted list and steam-service.getAppList relies on it being sorted. Apply the same module-level collator in useDeferredFilterSort.ts:381 and dashboard.tsx:422 for consistency.
  - Tests: Unit test: sorting a fixture with mixed case and accents gives the same order as the old comparator. Perf test: 155k synthetic names sorts in under 2 s.
  - Risk: Very low. Same collation options, same order.
  - Coordinate with hooks#4: Both replace localeCompare-with-options with a shared Intl.Collator (main-core#1 cites the same useDeferredFilterSort:381 and dashboard:422 sites). Add one collator helper and use it in both.

- **[medium · correctness] Steam RateLimiter does not limit concurrency or spacing: same-tick calls all fire at once** `main-apis#0`
  - Where: `electron/steam-api.ts:247`, `electron/steam-api.ts:252`, `electron/steam-api.ts:265`
  - Problem: The limiter only counts a request as active after its spacing wait, so every call made in the same tick skips the queue and fires together. A 200-id player-count sweep sends about 200 requests at once, and recommendation scoring sends 50 appdetails at once, which triggers Steam 429s and the app-wide 60s appdetails pause. MAX_QUEUE_SIZE never applies.
  - Fix: In execute(): if activeRequests < max, increment activeRequests synchronously before any await and run the task; otherwise push to the queue (apply the queue-full check only on the queue path). Remove the increment inside task(). Reserve spacing synchronously: start = max(Date.now(), this.nextSlot); this.nextSlot = start + delay; await (start - now). In finally decrement and call processQueue(), which loops while slots are free and also increments synchronously. Give the constructor options {delay, maxConcurrent, maxQueue} and configure playerCountLimiter separately (about 8 concurrent, 25-50ms spacing) so 200-id sweeps do not become 40s waits.
  - Tests: Unit test with fake timers: fire 50 execute() calls, assert peak concurrency <= 3 and start times >= 200ms apart; separate test for the player-count config; queue-full rejection only when queued.
  - Risk: Sweeps and recommendations become slower but steady. Renderer callers with tight deadlines (reco-store runWithDeadline, player-count sweeps) may time out until budgets are raised.
  - Coordinate with main-apis#8, main-core#1, main-core#10, main-apis#36, main-apis#46: All in steam-api.ts. The RateLimiter fix changes the timing that getAppList dedupe and the recommendations fan-out depend on, so do the RateLimiter first.

- **[medium · performance] getAppList has no in-flight dedupe, so concurrent callers each download the 155k app list** `main-apis#8`
  - Where: `electron/steam-api.ts:1235`
  - Problem: At startup the catalog loader and catalog sync both call getAppList; on a stale or cold cache each starts its own refresh, downloading, parsing and sorting about 155k entries twice and doubling peak memory.
  - Fix: Add `private appListInFlight: Promise<Array<{appid:number;name:string}>> | null = null` and in both stale and cold branches use `this.appListInFlight ??= this.refreshAppList(APP_LIST_TTL).finally(() => { this.appListInFlight = null; })`; the stale branch attaches its .catch to the shared promise and returns stale data immediately. Optionally add a module-level in-flight promise in useGameStore's loadCatalogAppList.
  - Tests: Two concurrent getAppList() calls on an empty cache trigger exactly one fetch sequence.
  - Risk: None.

- **[medium · correctness] Steam getRecommendations only scores chart games and caches results ignoring limit and rate-limit failures** `main-apis#36`
  - Where: `electron/steam-api.ts:1101`, `electron/steam-api.ts:917`
  - Problem: The top-50 cut keeps only top sellers, new releases and most-played, so developer/publisher/genre matches are never scored and results are generic. The cache key ignores limit (a 3-result answer is reused for a 10-result request) and an empty list from a 429 pause is cached for 30 minutes.
  - Fix: Have getCandidateGames return ordered buckets; build toScore as dev/publisher search ids (~15), then genre ids (~15), then alternate top_sellers/new_releases/mostPlayed to fill 50, deduped against excludeSet; optionally drop DLC/soundtrack/demo names first. Cache the full scored array under a key without limit and slice on read. Skip cache.set when scored is empty, when the run overlapped appDetailsPausedUntil, or when over half the details were null.
  - Tests: With search ids present, they appear in toScore; limit 3 then 10 returns 10; empty or paused run not cached.
  - Risk: Search-derived candidates are less often cached, so more appdetails calls.

- **[medium · performance] AI getGameRecommendations tool fires about 60 uncached Steam store requests per message** `main-apis#46`
  - Where: `electron/ai-chat.ts:373`, `electron/steam-api.ts:1106`
  - Problem: One 'what should I play?' message costs about 62 store requests in a burst; two or three such questions trigger a 429 and pause appdetails for the whole app.
  - Fix: Depends on the Steam RateLimiter fix. In scoreAndRankCandidates score cached (fresh or stale) candidates without starting background refresh, and cap uncached appdetails fetches at about 10 per call. Cache the tool result per library signature. In ai-chat, choose a meaningful seed (most-played or highest-rated Steam entry) rather than steamAppIds[0].
  - Tests: With an empty cache, at most ~10 appdetails requests per call; cached candidates are scored without network.
  - Risk: Fewer live-scored candidates can change chat recommendations.

- **[medium · correctness] A rate-limited or offline Steam appdetails call is shown as 'Game not found' and redirects after 5 s** `ui-browse-details#11`
  - Where: `src/pages/game-details.tsx:1336`, `electron/steam-api.ts:468`, `electron/ipc/steam-handlers.ts:47`
  - Problem: When Steam is rate limiting or the network is down, opening a game from Similar Games, Oracle or Voyage shows 'Game not found' and bounces the user back to the dashboard after 5 s, with no retry. The app cannot tell 'delisted' from 'temporarily unavailable'.
  - Fix: Keep steam:getAppDetails returning null for existing callers. Add steam:getAppDetailsWithStatus (used only by game-details) returning { data, status: 'ok'|'not_found'|'rate_limited'|'error' }, where not_found means success:false and rate_limited means the 429 pause is active. In the page, before setError, fall back to library cachedMeta or journey metadata for that gameId. For rate_limited / error / !navigator.onLine, show a non-redirecting 'Steam is busy or unreachable' state with a Retry button. Optionally call setNavigatingGame with a minimal Game from the Similar Games strip, journey-view and oracle-view clicks.
  - Tests: steam-api unit test: status is rate_limited during the pause and not_found on success:false. Details test: rate_limited shows the retry state and does not navigate after 5 s; not_found keeps today's behaviour; a library game with cachedMeta renders minimal details.
  - Risk: New IPC surface; keep the old channel unchanged so steam-service and similar-games are unaffected.

- **[low · correctness] Failed upstream fetches are cached as fresh (Steam upcoming 1 h, event scraper 24 h)** `main-core#14`
  - Where: `electron/ipc/steam-handlers.ts:422`, `electron/ipc/event-scraper-handlers.ts:452`, `electron/ipc/event-scraper-handlers.ts:425`, `electron/ipc/event-scraper-handlers.ts:394`
  - Problem: When offline or when Steam's featured call fails, steam:getUpcomingReleases caches an empty list for an hour. The event scraper writes every failed page as an empty entry and stamps the whole cache fresh for 24 h, and when serving cache it ignores event ids that are missing or whose URL changed, so new or failed events show no dates or links for a day.
  - Fix: steam-handlers: only write upcomingReleasesCache when comingSoon.length + newReleases.length > 0, otherwise skip or use a 60 s TTL. Event scraper: mark failed entries failed:true and keep a previous good entry for that id instead of overwriting it; skip writeCache (or back-date updatedAt to give a ~10 min retry) when every fetch failed; in the handler treat the cache as stale if any requested id is missing, has a different URL, or is a failed entry older than ~10 min, then serve cache and run the existing deduped scrapeInBackground (await it when no requested id is cached). Have buzz-view forceRefresh await clearCache() before bumping refreshKey.
  - Tests: Handler tests with mocked fetch: offline -> nothing cached, next online call refetches; partial failure keeps old good entries; new id in request triggers background scrape; all-failed cold start does not write a 24 h cache.
  - Risk: Low. More retries while offline; the background scrape is already single-flight.

- **[low · security] events:scrapeAll fetches any renderer-supplied URL, bypassing the fetch allow-list** `main-core#18`
  - Where: `electron/ipc/event-scraper-handlers.ts:395`, `electron/ipc/event-scraper-handlers.ts:71`, `electron/ipc/event-scraper-handlers.ts:445`
  - Problem: The handler only checks that URLs are http(s), so script in the renderer can make main fetch localhost or intranet hosts with the default session and get back extracted fields, and can overwrite the persisted event cache. Every other main-process fetcher is restricted.
  - Fix: Move the GAMING_EVENTS id-to-URL map (or its hostnames) into a shared module main imports. In the handler accept only entries whose id matches /^[a-z0-9-]{1,64}$/ and whose URL exactly equals main's URL for that id; drop everything else; cap the array at the list length. Pass credentials: 'omit', and check res.url after redirects against the same host set. Have scrapeInBackground use main's list, not the caller's array.
  - Tests: Handler tests: http://127.0.0.1 and unknown ids are dropped without fetching; redirect to a LAN host is rejected; __proto__ id is rejected; legit GAMING_EVENTS request still scrapes.
  - Risk: Low. Must derive the allow-list from the same source as the renderer list so new events are not silently ignored.

### B07 Epic and egdata clients (7)
_epic-api.ts and egdata-handlers plus the renderer egdata fetch timeout. One subsystem._

- **[medium · correctness] Epic RateLimiter releases every same-tick acquire, ignoring MAX_CONCURRENT=2 and 300ms spacing** `main-apis#1`
  - Where: `electron/epic-api.ts:47`, `electron/epic-api.ts:53`
  - Problem: processQueue checks the concurrency cap when it schedules a timer, not when the timer fires, so a batch of 8 catalog page requests all go out together. Full crawls hit the Cloudflare-protected GraphQL endpoint 8 at a time, making the 403 circuit breaker and hidden solver window more likely.
  - Fix: Add `private timer: ReturnType<typeof setTimeout> | null = null`. processQueue returns early if timer is set, queue is empty, or active >= MAX_CONCURRENT. Otherwise `this.timer = setTimeout(() => { this.timer = null; if (!this.queue.length || this.active >= MAX_CONCURRENT) return; this.active++; this.lastRequestTime = Date.now(); this.queue.shift()!(); this.processQueue(); }, waitTime)`. Lower browseCatalog BATCH_SIZE to 2-4 and review the 120s race in catalog-handlers and the 180s prefetch-store budget.
  - Tests: Fake-timer unit test: 8 acquire() calls, assert peak active <= 2 and releases spaced >= 300ms; release() reschedules without creating extra timers.
  - Risk: Full Epic crawl slows to roughly 30-60s+; launch prefetch timeouts may need raising.
  - Coordinate with main-apis#2, main-apis#14, main-apis#15, main-core#15: All in epic-api.ts (RateLimiter, cache keys, the solver). Do them in one change set.

- **[medium · correctness] Epic browseCatalog(limit) caches a partial crawl under the full-catalog key** `main-apis#2`
  - Where: `electron/epic-api.ts:1318`, `electron/epic-api.ts:1413`, `electron/epic-api.ts:1415`, `electron/epic-api.ts:1424`
  - Problem: Top Sellers calls browseCatalog(99), which crawls about 120 items and stores them as 'epic:catalog-browse-full'. For the next 30 minutes Browse and catalog sync get 120 games instead of about 6-8k, and the shrunken catalog can be persisted. In the other direction a limited call returns the whole cached catalog over IPC.
  - Fix: In browseCatalogUncached: for totalLimit > 0, read the full key first and if an entry exists return entry.slice(0, totalLimit) in main. Otherwise crawl only the needed pages and either do not cache or cache under `epic:catalog-browse:${totalLimit}`. Write 'epic:catalog-browse-full' only when totalLimit === 0 and the crawl passes the truncation guard. In the GQL-failure fallback (`if (cached) return cached`) use the matching key and slice when a limit is given.
  - Tests: browseCatalog(99) then browseCatalog(0) must not return the 120-item result; with a full cache, browseCatalog(99) returns exactly 99 items without crawling.
  - Risk: Low; the first limited call after a cold start does its own small crawl.

- **[low · correctness] Epic searchGames returns the stale cached result after a successful fresh fetch** `main-apis#14`
  - Where: `electron/epic-api.ts:859`
  - Problem: With a stale entry the code fetches and caches fresh results, then returns the old list, so Epic search and the AI tool show outdated prices once per stale key.
  - Fix: Delete `if (cached) return cached;` on the success path and return results; keep the stale return only in the error/fallback path (line 883).
  - Tests: Stale cache + successful GQL returns the fresh results.
  - Risk: None.

- **[low · performance] Epic details-page lookups never cache misses, refetching reviews, news, content and addons on every visit** `main-apis#15`
  - Where: `electron/epic-api.ts:1131`, `electron/epic-api.ts:1624`, `electron/epic-api.ts:1655`, `electron/epic-api.ts:1869`
  - Problem: Most games have no reviews or news, so each Epic details open sends 4+ requests through the shared limiter again, adding Cloudflare pressure.
  - Fix: Store an explicit miss marker `{__miss: true}` under a separate key (e.g. `epic:reviews:miss:<slug>`) with a ~6h TTL, checked before fetching; for arrays test Array.isArray rather than truthiness. Cache misses only when definitive (all SKUs 404 or OK-but-empty and OpenCritic returned no data); never after a throw, 429 or 5xx.
  - Tests: Definitive miss is cached and not refetched; a 429 is not cached.
  - Risk: Reviews or news added later appear up to one miss-TTL late.

- **[low · performance] Epic Cloudflare solver loads the full Epic store in a hidden window on every launch** `main-core#15`
  - Where: `electron/main.ts:1066`, `electron/epic-api.ts:601`, `electron/epic-api.ts:702`
  - Problem: Every startup, including --hidden auto-start at login, opens a hidden window that loads the whole Epic store page and polls up to 25 s for a cf_clearance cookie, even when one is already saved or no challenge appears. That is an extra renderer (about 100-300 MB plus CPU) per launch, with all its requests going through the ad-block hook.
  - Fix: Remove the eager initCloudflare call at main.ts:1063-1069 and rely on the existing lazy trigger in gqlFetch after a 403. At the top of _solveCloudflare, check session.defaultSession.cookies.get({ url: 'https://store.epicgames.com', name: 'cf_clearance' }); if a value exists set cfInitialized = true and return true. In the solver window set webPreferences { images: false, backgroundThrottling: true } and, after did-finish-load plus about 3 s, destroy early if no challenge page is present. Align the caller's withTimeout with the solver's 25 s deadline.
  - Tests: Unit tests with mocked session/BrowserWindow: existing cookie -> no window created; no challenge -> window destroyed within ~5 s; 403 path still triggers the solver once.
  - Risk: Low. First Epic GraphQL call after launch may now pay the solve latency on a 403 instead of at boot.

- **[low · performance] egdata:getTopSellers has no cache and fetches 10 pages one after another on every call** `main-core#16`
  - Where: `electron/ipc/egdata-handlers.ts:79`, `electron/ipc/egdata-handlers.ts:59`, `electron/ipc/egdata-handlers.ts:33`
  - Problem: Each call makes 10 sequential HTTPS requests (up to 30 across fallbacks when the API is degraded), and several renderer paths call it repeatedly, so the Top Sellers view waits several seconds each time. One failed page throws away the pages already fetched. On non-200 the response body is not drained, holding the socket.
  - Fix: Add a module-level cache { elements, total, at } with a 15 min TTL storing only non-empty results, plus a shared in-flight promise. Fetch pages 1-10 with concurrency 3-5 via Promise.allSettled, merge successful pages with the existing namespace:id dedup and sort by position, and only fall back to strategies 2/3 if nothing merged. In fetchTopSellersViaHttps call res.resume() before rejecting on non-200 and add res.on('error', reject). Use or remove the unused skip arg.
  - Tests: Handler tests with mocked https: second call within TTL makes no requests; concurrent calls share one fetch; one failing page still returns the other 9; empty result is not cached.
  - Risk: Low. Parallel requests are more load per burst on api.egdata.app; keep concurrency small.

- **[low · correctness] Renderer egdata top-sellers fetch clears its timeout before reading the body, so a stalled body hangs Top Sellers for the session** `renderer-stores#31`
  - Where: `src/services/game-service.ts:67`, `src/services/game-service.ts:81`, `src/services/prefetch-store.ts`
  - Problem: If the egdata server sends headers and then stalls, the body read never ends, Top Sellers never loads, and the preload guard prevents any retry for the rest of the session.
  - Fix: In fetchEgdataTopSellersPage remove both clearTimeout calls and use try { fetch; if (!res.ok) return []; const data = await res.json(); ... } catch { return []; } finally { clearTimeout(timeout); }. Optional: overall ~30 s Promise.race on startTopSellersPreload and clear topSellersPromise on timeout.
  - Tests: Mock fetch whose json() never resolves until aborted: page returns [] after the 12 s timer (fake timers) and getTopSellers settles.
  - Risk: Very low.

### B08 HLTB, gg.deals, Metacritic, web search (8)
_Independent third-party lookup modules with small, testable fixes._

- **[medium · correctness] Custom games send their 'added' date as release year to HowLongToBeat, so the match is rejected** `ui-browse-details#12`
  - Where: `src/pages/game-details.tsx:1039`, `src/pages/game-details.tsx:2007`, `electron/hltb-api.ts:148`
  - Problem: Custom games added more than two years after their real release never get a HowLongToBeat badge. The page uses the date the game was added as its release year, which pushes an exact title match below the acceptance score, and the miss is cached.
  - Fix: At line 2007 pass `year={isCustomGame ? undefined : releaseYearOf(details.release_date?.date)}`. Optionally stop storing addedAt in release_date for custom games and show it under its own 'Added' label. The cache key changes to title| so old wrong-year misses are no longer read.
  - Tests: Details test: custom game added 2025 for an older title renders HltbBadge with year undefined. hltb-api test: exact title with no year still matches at >= 0.95.
  - Risk: None. Without a year, matching uses the stricter title-only threshold.

- **[low · correctness] HLTB and gg.deals clear the request timeout before reading the body, so a stalled body hangs lookups and in-flight entries forever** `main-apis#3`
  - Where: `electron/hltb-api.ts:246`, `electron/hltb-api.ts:252`, `electron/ggdeals-api.ts:203`, `electron/ggdeals-api.ts:204`
  - Problem: Both clients cancel their abort timer once headers arrive. If the server stalls mid-body, the lookup never settles and stays in the in-flight map, so every later request for that title or price joins a dead promise and never loads for the rest of the session.
  - Fix: HLTB: mirror steam/epic and clear the timer only when fetch rejects, or wrap request+readJson in one fetchJson helper that clears the timer in finally after the body is read. gg.deals: inside the serial() callback read the body before the finally that clears the timer: `const res = await fetch(...); const body = await res.json().catch(() => null); return { res, body };` so an abort yields null and goes to the existing breaker path. Optionally race joined in-flight promises against a timeout.
  - Tests: Fake fetch whose body promise never resolves: assert getTimes()/getPrices() settle after the timeout and the in-flight maps are emptied.
  - Risk: None.

- **[low · correctness] HLTB maps standalone 'x' to '10', so Mega Man X and Mega Man 10 share a cache entry** `main-apis#44`
  - Where: `electron/hltb-api.ts:72`
  - Problem: Titles like 'Mega Man X' and 'Mega Man 10' normalise to the same cache key, so whichever is looked up first is returned for the other for 30 days.
  - Fix: Keep ROMAN for scoring but build the cache key from the actual search terms: `hltb:v2:${hltbSearchTerms(query.title).join(' ')}|${query.year ?? ''}` (in-flight dedupe uses the same key). Bumping to v2 drops possibly wrong v1 entries.
  - Tests: 'Mega Man X' and 'Mega Man 10' produce different keys; 'Final Fantasy X' still matches the HLTB entry.
  - Risk: Old v1 entries are refetched once.

- **[low · correctness] Metacritic caches transient network failures as 'no data' for an hour** `main-apis#22`
  - Where: `electron/metacritic-api.ts:374`, `electron/metacritic-api.ts:389`, `electron/metacritic-api.ts:407`
  - Problem: A brief network drop or rate limit while opening a game page stores 'no Metacritic score' for that game for an hour, in the UI and the AI tool.
  - Fix: In fetchUrl throw an error carrying res.status. In tryFetchWithPatterns track sawTransientError (no status, or 403/408/429/5xx; 404 does not count) and return {html, transient}. In fetchMetacriticReviews cache a null result for CACHE_TTL only when no transient error occurred; otherwise skip caching or use a 2-5 min TTL via a per-entry expiresAt.
  - Tests: All-404 caches null for 1h; a timeout or 429 does not cache (or caches short).
  - Risk: More retries when Metacritic is down; keep a short negative TTL.

- **[low · performance] Metacritic lookup probes legacy URLs one by one with no in-flight dedupe** `main-apis#51`
  - Where: `electron/metacritic-api.ts:183`, `electron/metacritic-api.ts:237`
  - Problem: Split vote, kept as low. For a game with no direct match, each slug tries 5 URL prefixes in sequence plus a search, about 7-17 requests, and the 4 legacy platform prefixes almost always miss now. Concurrent lookups for the same title (details page and AI tool) run the whole cascade twice. Impact is a slower background spinner, not a UI freeze.
  - Fix: Add an inflight Map<string, Promise> keyed by cacheKey in fetchMetacriticReviews. After the 'game/' probe misses, run the four platform prefixes in parallel and pick the first hit in the existing priority order (or drop them). Delete expired entries on read or cap the Map at about 200 entries. Do not persist misses.
  - Tests: Two concurrent calls for one title make one cascade; 'game/' hit costs one request; Map stays bounded.
  - Risk: Probe order change could pick a different platform page; keep 'game/' first.

- **[low · correctness] web-search decodes each socket chunk separately, corrupting multi-byte characters** `main-apis#10`
  - Where: `electron/web-search.ts:117`, `electron/ollama-setup.ts:265`
  - Problem: Characters like é or CJK that straddle a chunk boundary turn into replacement characters, so search snippets sent to the model contain garbled text.
  - Fix: web-search.ts: collect Buffer chunks (keep the byte-limit check on chunk.length) and resolve Buffer.concat(chunks).toString('utf8') on 'end'. ollama-setup.ts pull progress (NDJSON parsed as it streams): use a StringDecoder or res.setEncoding('utf8'). egdata-handlers does not need changing.
  - Tests: Feed a response split in the middle of a multi-byte character; assert decoded text is intact.
  - Risk: None.

- **[low · correctness] Web search pairs snippets with links by position, so one missing snippet misattributes every later result** `main-apis#41`
  - Where: `electron/web-search.ts:173`
  - Problem: Links and snippets are collected in separate passes and zipped, so a result without a snippet shifts descriptions onto the wrong URLs; one bad %-escape makes the whole search return nothing.
  - Fix: Split the HTML into per-result blocks (e.g. match each result__body section) and read result__a and optional result__snippet inside each, with the s flag on the title regex. Wrap decodeURIComponent in try/catch and keep the raw URL. Optionally skip ad blocks.
  - Tests: Saved DDG HTML fixture including a result with no snippet and a malformed uddg URL.
  - Risk: Depends on DDG markup; keep the fixture current.

- **[low · earlier review] Region change mid-request caches old-region prices under the new region**
  - Where: `src/services/ggdeals-service.ts:203`
  - Fix: Read the region once per flush and key the cache with it.

### B09 Updater (8)
_Updater state machine end to end (main, then UI). Test with a staged update feed._

- **[medium · correctness] Alternate updater download has no stall timeout; a stalled connection blocks the fallback for the whole session** `main-apis#4`
  - Where: `electron/resumable-download.ts:136`, `electron/resumable-download.ts:209`, `electron/auto-updater.ts:550`
  - Problem: reader.read() can wait forever on a stalled connection, so the retry/resume logic never runs and isFallbackDownloading stays true. Every later click says an alternate download is already running until restart, and the file handle and stream stay open. If writeSync throws (disk full) the reader is never cancelled.
  - Fix: Inside downloadWithResume, per attempt: create an AbortController linked to opts.signal (listener removed in finally), pass it to doFetch, arm an idle timer (default 60s, configurable idleTimeoutMs) before the fetch and reset it after every chunk. On fire set stalled=true, abort, and reader.cancel(). In catch, check the outer signal first (user cancel stays a cancel); if stalled, treat as a transient error so the resume path retries. Clear the timer and cancel the reader in the finally next to fs.closeSync. Make auto-updater always reset isFallbackDownloading in a finally.
  - Tests: Fake fetch that stops sending after N bytes: assert retry from the .part offset after idleTimeoutMs; user abort still reported as cancelled; writeSync error cancels the reader.
  - Risk: A very slow link with gaps longer than the idle window retries and resumes, which is intended.
  - Coordinate with main-apis#45, main-apis#9, ui-other#14, ui-other#15: The updater state machine spans auto-updater.ts, resumable-download and the snackbar/settings UI. Make main state changes before UI state changes.

- **[medium · correctness] Update snackbar disappears on every background poll and stays hidden if that check fails** `ui-other#14`
  - Where: `src/components/update-snackbar.tsx:146`, `src/components/update-snackbar.tsx:293`, `electron/auto-updater.ts`
  - Problem: Every 30-minute update poll sends a 'checking' event, which hides the snackbar even when it was showing 'Update Available' or a download error with recovery buttons. If that quiet check fails (offline), no follow-up event arrives, so the snackbar stays hidden and the error's recovery actions are lost.
  - Fix: In onChecking use setState(prev => prev === 'idle' ? 'checking' : prev), never leaving 'available', 'downloading', 'ready' or 'error'. Leave handleRetryReachability's direct setState('checking'). Optional follow-up: in onUpdateAvailable only setDismissed(false) when info.version differs from the version shown.
  - Tests: State 'available' + onChecking stays 'available'. State 'error' + onChecking stays 'error'. State 'idle' + onChecking -> 'checking'. Retry reachability still moves to 'checking'.
  - Risk: Low. 'checking' renders the same as idle, so nothing visible is lost.

- **[low · memory-leak] Alternate updater leaves every installer and abandoned .part file in %TEMP%/ark-update forever** `main-apis#45`
  - Where: `electron/updater-fallback.ts:62`
  - Problem: Each release downloaded through the alternate path leaves a full installer (hundreds of MB), and failed downloads leave .part files that are never resumed or removed.
  - Fix: In runFallbackDownload, before downloading, rmSync (force, try/catch) every entry except Ark-Setup-${info.version}.exe and its .part. A few seconds after startup, delete in the background any Ark-Setup-<v>.exe/.part with version <= app.getVersion() (semver), skipping EBUSY/EPERM quietly.
  - Tests: Temp dir with old versions and current .part: old removed, current .part kept; startup cleanup skips locked files.
  - Risk: Low.

- **[low · correctness] Update notifications are not retained, so a later click can do nothing** `main-apis#9`
  - Where: `electron/auto-updater.ts:157`, `electron/auto-updater.ts:223`
  - Problem: The 'update available' and 'update ready' notifications are local variables. On Windows a garbage-collected Notification stops delivering clicks, so clicking the toast minutes later does not install or focus the window.
  - Fix: Add module-level `availableNotif` and `readyNotif`. Close the previous one before showing a new one, assign the new instance, and null it in 'click' and in 'close' only if it is still the same instance.
  - Tests: Unit test with a mocked Notification: references are kept after the handler returns and replaced/closed on a second show.
  - Risk: None.

- **[low · correctness] Update UI never offers install after a download: About tab shows 'Download v<installed version>' and a dismissed snackbar stays hidden through completion** `ui-other#15`
  - Where: `src/components/settings-screen.tsx:1665-1667`, `src/components/settings-screen.tsx:1679`, `src/components/settings-screen.tsx:1740-1747`, `electron/auto-updater.ts:415-418`, `electron/auto-updater.ts:476-483`, `src/components/update-snackbar.tsx:163`, `src/components/update-snackbar.tsx:169`
  - Problem: Once an update is downloading or downloaded, About > Check for Updates reports the installed version as the new one and shows a Download button that does nothing; About never switches to an install state after its own download either. Separately, if the user clicked 'Later' on the snackbar and then downloads from About, the snackbar stays hidden, so 'Ready to Install' never appears (only the native notification remains).
  - Fix: auto-updater.ts short-circuit: return { updateAvailable: true, currentVersion, latestVersion: lastUpdateInfo?.version ?? currentVersion, status: isDownloading ? 'downloading' : 'downloaded' }; add optional status to vite-env.d.ts. AboutTab: add 'downloading' (disabled 'Downloading...') and 'ready' states; set 'ready' when downloadUpdate resolves with success or status==='downloaded'; show 'Install & Restart vX' calling window.updater.installUpdate. update-snackbar.tsx: call setDismissed(false) in onUpdateDownloaded (not on every progress event).
  - Tests: updater:check while downloaded returns real version and status 'downloaded'; About shows Install button that calls installUpdate. Snackbar dismissed then onUpdateDownloaded -> visible 'ready'. Later on 'ready' still dismisses.
  - Risk: Low. Additive optional fields keep runMountCheck compatible.

- **[medium · earlier review] Flaky link or GitHub 5xx reported as "blocked by security software"; alternate download hidden**
  - Where: `electron/resumable-download.ts:162`
  - Fix: Count an attempt toward the same-offset stop only when it received bytes; never count 5xx/429/connection-setup errors.

- **[medium · earlier review] Download started from Settings > About that fails leaves the snackbar spinning**
  - Where: `electron/auto-updater.ts:250`
  - Fix: After the retry loop fails, send one final updater:error so every listener sees it.

- **[low · earlier review] Startup reachability error keeps later download errors in the "Couldn't reach GitHub" layout**
  - Where: `src/components/update-snackbar.tsx:55`
  - Fix: Clear isReachabilityError on update-available, error, and at the start of each download.

### B10 Session tracker and auto-hold (11)
_session-tracker.ts and the useSessionTracker/useAutoOnHold hooks. Playtime correctness. Needs careful manual tests (sleep, idle, shared exe)._

- **[high · correctness] System sleep while a game is running is counted as active playtime** `main-apis#18`
  - Where: `electron/session-tracker.ts:565`
  - Problem: If the PC sleeps for hours with a game open, the process is still there on resume, so the whole sleep is counted as play. Nothing handles suspend/resume or checks the gap between polls.
  - Fix: Keep a module-level lastTickMs updated on every completed tick. In the `running && existingSession` branch compute gap = nowMs - lastTickMs; if gap > 4 * POLL_INTERVAL_MS add (gap - POLL_INTERVAL_MS) to idleAccumulatedMs, reset lastIdleCheck and skip the activeInputMs increment for that tick. Also subscribe to powerMonitor 'suspend' (record suspend time) and 'resume' (add the suspended span as idle).
  - Tests: Simulated tick gap of 8h with the process still running adds ~8h to idle, not to duration; suspend/resume events add the span as idle; a normal 15s tick is unaffected.
  - Risk: Changes recorded durations (lower); idle minutes reported grow.
  - Coordinate with main-apis#42, main-apis#21, main-apis#37, main-apis#7, main-apis#11, hooks#16: All change session-tracker.ts process matching and session end-time logic. hooks#16 orphan ending and main-apis#11 untrack end-time both touch ~799-806.

- **[medium · correctness] Session tracker relies on tasklist every 15s; a failing tasklist keeps exited games 'running'** `main-apis#7`
  - Where: `electron/session-tracker.ts:144`, `electron/session-tracker.ts:229`
  - Problem: Every poll spawns cmd.exe + tasklist even though the native snapshot already has full paths, which is constant idle CPU while Ark sits in the tray. When tasklist fails (antivirus pauses, policy blocks), the old basename list is kept, so a game that has exited still matches and keeps accruing playtime.
  - Fix: Have the native session_enumerate return a basename for every process (Toolhelp32 szExeFile) and fill _runningBasenames from it. Run tasklist only when native is unavailable or empty, via execFile('tasklist', ['/FO','CSV','/NH']) with no shell, and wrap it in its own try/catch with a _basenameSnapshotStale flag. When tasklist fails but native succeeds, derive basenames from native paths for that tick. When both fail, pollTick must neither bump lastSeenMs nor count misses for that tick. Keep MISSES_BEFORE_END unchanged.
  - Tests: Mock native + tasklist: native success skips tasklist; tasklist throw with stale basenames does not extend a session whose process is gone; both failing leaves sessions frozen without extension.
  - Risk: Elevated processes native cannot read still need the fallback; while all snapshots fail, sessions neither extend nor end.

- **[medium · correctness] Basename fallback credits playtime to the wrong game when another exe has the same name** `main-apis#21`
  - Where: `electron/session-tracker.ts:256`
  - Problem: A tracked 'Game.exe' or 'Launcher.exe' matches any running process with that name even when the fresh path snapshot shows it lives in another folder, so the wrong game gets a session.
  - Fix: In setTrackedGames compute a canonical key per game once (path.win32.normalize lowercased, plus fs.realpathSync.native lowercased when it resolves). In refreshProcessSnapshot build Map<basename, Set<fullPathLower>> and a set of basenames with unresolved paths. In isProcessRunning match canonical keys against _runningPaths first; refuse the basename fallback only when the snapshot is fresh, the basename has known paths, none equals the tracked keys, and no process with that basename had an unresolved path.
  - Tests: Tracked C:\Games\A\Game.exe vs running D:\B\Game.exe returns false; unresolved-path process with matching name still returns true; junction/realpath case still matches.
  - Risk: Paths differing only by subst/8.3/junction could stop matching; realpath normalisation mitigates.

- **[low · correctness] Two tracked games sharing one exe each record the full session, doubling playtime** `main-apis#37`
  - Where: `electron/session-tracker.ts:538`, `src/hooks/useSessionTracker.ts:184`
  - Problem: If the same exe is tracked under two entries (Steam and Epic copies, or two titles pointed at one launcher), both get a full session, doubling hours, streaks and badges.
  - Fix: In setTrackedGames group by path.normalize(p).toLowerCase() and pick one owner per path: (1) a gameId that already has an ActiveSession for that path, (2) library over custom, (3) first in input order. Log one warning per collision when the set changes.
  - Tests: Two entries with the same path yield one session; resync mid-session keeps the same owner.
  - Risk: Users deliberately tracking two entries on one launcher get time on only one; UI should show the owner.

- **[low · correctness] Idle detection still counts the first 5+ minutes of each AFK break as playtime** `main-apis#42`
  - Where: `electron/session-tracker.ts:491`, `electron/session-tracker.ts:829`
  - Problem: Idle time is only subtracted after it is confirmed, and then 15s per tick, so the initial 5 minutes of every break count as play. getActiveSessions also reports elapsed time without idle subtracted.
  - Fix: On the tick idle is first confirmed (new idleConfirmed flag false), add min(systemIdleS*1000, nowMs - startTime) once and set idleConfirmed; then keep adding POLL_INTERVAL_MS per tick; clear the flag when not idle. Do not clamp with lastSeenMs. Make getActiveSessions subtract idleAccumulatedMs like liveUpdate.
  - Tests: Simulated 10-min AFK removes ~10 min; idle starting before game launch clamps to session elapsed; getActiveSessions matches liveUpdate.
  - Risk: Lowers recorded durations; controller-only play may be read as idle (GetLastInputInfo ignores XInput), so keep the two-tick confirmation.

- **[low · correctness] Untracking a game ends its session at the current time instead of when it was last seen** `main-apis#11`
  - Where: `electron/session-tracker.ts:806`
  - Problem: If a game already exited and is in its miss window when it is removed from tracking, the unseen 45-60s (or longer after suspension) is added as playtime.
  - Fix: Add helper sessionEndMs(session, nowMs) = Math.max(session.startTime.getTime(), Math.min(nowMs, session.lastSeenMs || nowMs)) and use it in setTrackedGames, stopSessionTracker and the miss path.
  - Tests: Session with lastSeenMs 60s ago removed from the tracked list records duration ending at lastSeenMs.
  - Risk: None.

- **[low · correctness] Read-only library store sends a tracked list without library games, ending running sessions as orphans** `hooks#16`
  - Where: `src/hooks/useSessionTracker.ts:184`, `src/services/library-store.ts:366`, `electron/session-tracker.ts:799`
  - Problem: If the library store opens read-only with no entries (LevelDB read failure), the renderer sends only custom games; main then finalizes every running library session as orphaned and stops tracking library games, despite the banner saying tracking still works. Same for a read-only custom store.
  - Fix: Extend setTrackedGames IPC with an options arg, e.g. { keepSources: ('library'|'custom')[] }. In syncTrackedGames, include 'library' when libraryStore.isReadOnly() and it has no entries, and 'custom' likewise. In main's setTrackedGames, keep existing trackedGames entries for kept sources (library = ids without 'custom-' prefix, custom = 'custom-*') and skip orphan-finalizing their active sessions; replace only the other source. Cold-start read-only tracking is out of scope.
  - Tests: Main unit test: active library session, then setTrackedGames(customOnly, { keepSources: ['library'] }) keeps the session and library exes. Renderer test: read-only empty library sends keepSources ['library'].
  - Risk: Low-medium; IPC signature change touches preload and main.

- **[low · correctness] Startup auto-hold sweep runs before the tracker knows which games are running** `hooks#14`
  - Where: `src/hooks/useAutoOnHold.ts:239`
  - Problem: On launch the live-games set is empty until the tracker's first poll, but the sweep runs as soon as stores are ready. A game the user is playing right now, last played weeks ago, can be moved to On Hold with a toast, and stays there if the session is under 10 minutes.
  - Fix: Do not run the sweep immediately at mount; schedule the first sweep with window.setTimeout(~60-90 s) and clear it in the effect cleanup next to the interval. At sweep start, await window.sessionTracker?.getActiveSessions() and merge those ids (normalise numeric ids to steam-<id>) into the live set before isStalePlaying.
  - Tests: Hook test with fake timers: stale 'Playing' game that getActiveSessions reports active; assert no status change at mount or after the delayed sweep. A stale game not active is held after the delay.
  - Risk: Low; holds are applied about a minute later than today.
  - Coordinate with hooks#15, oracle#17: Auto-hold semantics: sweep timing and un-hold-on-disable change which games carry auto-held status, which oracle#17 reads in engagement weighting. Do Oracle last.

- **[low · correctness] Turning Auto On Hold off strands games it already held** `hooks#15`
  - Where: `src/hooks/useAutoOnHold.ts:196`
  - Problem: The resume-on-play logic exits as soon as the Auto On Hold switch is off, so games the sweep held earlier stay On Hold forever even after long play sessions.
  - Fix: Remove the isAutoOnHoldTransitionEnabled() check from maybeResumeAutoHeld only; keep it in runAutoOnHoldSweep. Resume relies on status === 'On Hold' && isAutoHeld(statusHistoryStore.getForGame(id)). Confirm isAutoHeld reads only the latest row's source so manual holds are never reverted.
  - Tests: Auto-hold a game, set ark:autoOnHoldTransition='false', end a 10+ minute session; expect 'Playing' with source 'auto-promote'. A manual hold is not reverted.
  - Risk: Low.

- **[medium · earlier review] Custom games from before 1.0.87 auto-held right after upgrade though set to Playing recently**
  - Where: `src/hooks/useAutoOnHold.ts:156`
  - Fix: Use the custom game's updatedAt as a status-change floor when it has no history rows (or stamp statusChangedAt).

- **[medium · earlier review] Startup sweep runs before crash-recovered sessions are recorded; recovered sessions never auto-resume**
  - Where: `src/hooks/useSessionTracker.ts:327`
  - Fix: Hold the first sweep until recovered sessions are processed; run maybeResumeAutoHeld for recovered sessions.

### B11 Ollama runtime (5)
_ollama-setup, ollama-handlers, rerank-engine and gpu-stats. Resource policy while gaming._

- **[medium · performance] Ollama models are pinned in RAM/VRAM forever with keep_alive:-1, even while gaming and after Ark quits** `main-apis#5`
  - Where: `electron/ollama-setup.ts:576`, `electron/rerank-engine.ts:645`, `electron/ipc/ollama-handlers.ts:155`, `electron/ollama-setup.ts:956`, `electron/main.ts`
  - Problem: Every embed and rerank request tells Ollama never to unload, so about 2-3 GB of models stay resident in GPU memory or RAM until the Ollama server restarts, including during games and after Ark is closed. The boot warm-up loads the embedder even on hidden auto-start with no work queued.
  - Fix: Replace -1 with one shared finite constant (for example '30m'). Add unloadArkModels() in ollama-setup.ts that fire-and-forget POSTs keep_alive:0 for each loaded Ark model (/api/embed {model, input: [], keep_alive:0}; /api/generate {model, prompt:'', keep_alive:0} for rerankers) with a ~1s abort timeout. Call it on session-tracker session:started (and hold the embed/rerank queues while a game runs), in before-quit, and when the pass queue drains. Do not unload on blur/minimize (would bring back the v1.0.60 reload thrash). Skip the boot warm-up when started --hidden with no pending work.
  - Tests: Unit test that all request bodies use the shared constant; unloadArkModels sends one keep_alive:0 per loaded model and never blocks quit beyond its timeout; game-start hook triggers unload.
  - Risk: The first embed or rerank after an unload pays a 30-80s cold load; raise the first-call deadline or warm on focus.
  - Coordinate with main-apis#28: Both change the Ollama keep_alive and background-mode policy while gaming.

- **[medium · performance] Hidden auto-start never enters embedding background mode, so embedding runs at full GPU throughput while the user plays** `main-apis#28`
  - Where: `electron/ipc/ollama-handlers.ts:237`, `electron/ipc/ollama-handlers.ts:378`, `electron/main.ts:562`
  - Problem: Background mode is only set by window events, which never fire when Ark starts hidden in the tray at login, so catalog embedding and reranking run in the full-speed profile exactly when the user is likely gaming.
  - Fix: In ready-to-show, after the show decision, call setEmbeddingBackgroundMode(!mainWindow.isVisible() || !mainWindow.isFocused()) (in practice true in the --hidden branch); the existing show/focus handlers switch it off. Separately, gate on session-tracker: while any tracked session is active, force background (or pause) via a combined flag (windowBackground || gameRunning) rather than overwriting the window state.
  - Tests: Hidden start sets background true; showing the window turns it off; session:started forces background and session:ended restores the window-derived state.
  - Risk: Hidden-start embedding is slower until the window is opened.

- **[low · correctness] ensureRerankModelPull in-flight bookkeeping breaks when pulls for two tags overlap** `main-apis#27`
  - Where: `electron/ollama-setup.ts:398`
  - Problem: When two different models are pulled at once, the first one's cleanup clears the shared slot while the second is still running, so later callers start duplicate downloads.
  - Fix: Replace the two globals with Map<string, Promise<boolean>> keyed by trimmed tag; dedupe via map.get, map.set before returning, and in .finally delete only if map.get(model) === pull.
  - Tests: Overlapping pulls for tags A and B; after A finishes, a new call for B reuses B's promise.
  - Risk: Minimal.

- **[low · correctness] Ollama pullModel reports success on truncated streams and can hang or crash if the stream errors** `main-apis#23`
  - Where: `electron/ollama-setup.ts:302`
  - Problem: A pull that ends early is reported as success, and there is no error/aborted handler, so an Ollama restart mid-pull raises an uncaught exception and leaves setup waiting forever.
  - Fix: Add a settled guard and finish(ok). Register res.on('error')/('aborted') -> finish(false) and res.on('close') -> finish(false) if !res.complete; req 'error'/'timeout' -> finish(false). On 'end': false if sawError; else if sawSuccess true; else confirm via /api/tags that the tag is installed.
  - Tests: Stream ending without success and tag missing -> false; stream 'error' -> false and no uncaught exception; normal success -> true.
  - Risk: Builds without a final 'success' line rely on the /api/tags check.

- **[low · correctness] VRAM meter gives up on nvidia-smi for the whole session after one slow or failed call** `ui-other#21`
  - Where: `electron/gpu-stats.ts:34-36`, `src/components/settings/embedding-batch-size.tsx:151`
  - Problem: If nvidia-smi is slow once (for example under GPU load from a game), the app marks it as missing forever and the VRAM meter shows Unknown until restart, even though the tool exists. The 2-second polling itself is a minor cost.
  - Fix: In runNvidiaSmi set nvidiaSmiMissing = true only when every candidate failed with err.code === 'ENOENT' (or EACCES). On timeout (err.killed/signal) or non-zero exit, return null for this poll and set a backoff (skip nvidia-smi for 15-30 s) instead of latching. Optional: remember the working candidate path. Leave POLL_MS.
  - Tests: Mock execFile: timeout -> null, next poll after backoff retries; ENOENT on both -> latched missing; success after a failure returns stats.
  - Risk: Very low.

### B12 AI chat engine (main) (12)
_ai-chat.ts turn loop and tools, edited sequentially. oracle#24 copy follows the main-apis#19 decision._

- **[medium · correctness] Azure chat model cache ignores API key changes until restart** `main-core#7`
  - Where: `electron/ai-chat.ts:121`, `electron/ai-chat.ts:155`
  - Problem: The cached Azure client key is built from endpoint, deployment and version only. If the user fixes or rotates the Azure key, every later chat call reuses the old client with the old key and keeps failing until the app restarts.
  - Fix: Include a short hash of the key: azure:${baseUrl}:${deployment}:${version}:${createHash('sha256').update(apiKey).digest('hex').slice(0,16)} (node:crypto), and use the same hashed form in the Gemini branch for consistency. Also reset cachedModel and cachedModelKey when a call fails with 401/403.
  - Tests: Unit test getModelForProvider: same config with a different key builds a new client; same key reuses it. Test that a 401 error clears the cache.
  - Risk: Very low.

- **[medium · performance] AI getLibraryGames tool dumps the entire library as JSON into the model context** `main-apis#32`
  - Where: `electron/ai-chat.ts:288`
  - Problem: A 2000-game library becomes 40-60k tokens re-sent on every tool round; on Ollama's small default window the system prompt and question get cut off, and on cloud providers it costs seconds and tokens per question.
  - Fix: Return {totalGames, byStatus: {Status: [names]}} without addedAt/priority/store ids, with optional `status` and `limit` (default ~50 per status plus '+N more') and a hard cap of ~8-12 KB serialized. Add a `nameQuery` argument returning gameId for matches so removals can still find ids.
  - Tests: 2000-entry library payload stays under the cap; status filter returns only that status; nameQuery returns the gameId.
  - Risk: Model sees fewer titles per call and must filter to page.

- **[medium · performance] Independent LLM tool calls in one turn run one after another** `main-apis#47`
  - Where: `electron/ai-chat.ts:1115`
  - Problem: When the model asks for details, reviews, Metacritic and HLTB in one turn, the user waits for the sum of all their latencies (often 10-30s) before the next round.
  - Fix: Run read-only calls with Promise.allSettled(calls.map(tc => executeTool(tc.name, tc.args))) and push ToolMessages and chain-of-thought entries in original index order using tc.id. Run add/remove tools sequentially after the read-only ones (or have them return actions appended in call order) so pendingActions stays deterministic.
  - Tests: Two slow mocked tools complete in ~max not sum; ToolMessage order matches tool_calls; add/remove actions keep call order.
  - Risk: Parallel calls can hit the same upstream at once (shared Steam limiter).

- **[medium · correctness] AI chat summary after hitting the tool-iteration cap sends unanswered tool_calls, so Azure/Gemini reject the turn** `main-apis#35`
  - Where: `electron/ai-chat.ts:1144`
  - Problem: When the model still wants tools after 5 rounds, the summary request includes its tool_calls with no tool results, and Azure/Gemini return a 400, so the user gets an error instead of a summary.
  - Fix: In 6b, if response.tool_calls?.length, do not push the raw response (or push new AIMessage({content: response.content ?? ''}) without tool_calls). Invoke the summary on the unbound model, not modelWithTools.
  - Tests: Mock model that always returns tool_calls: after the cap, the summary message list has no dangling tool_calls and the unbound model is used.
  - Risk: Low; only the exhausted-loop path changes.

- **[medium · security] Gemini reviewer sends every chat turn to Google even when the user picked Ollama or Azure** `main-apis#19`
  - Where: `electron/ai-chat.ts:1156`
  - Problem: If any Google AI key is saved, the full user message and answer (which can include library contents and image analysis) is posted to Gemini on every message, even when the user chose a local or corporate provider.
  - Fix: Have getModelForProvider return the effective provider id (accounting for per-request providerOptions) and run validateResponse only when effective === 'gemini', or when an explicit opt-in setting 'Use Google Gemini to review replies from other providers' (default off) is enabled.
  - Tests: processMessage with provider ollama and a stored Gemini key never calls the reviewer; with gemini it does; opt-in setting enables it for others.
  - Risk: Slightly less polished formatting for Ollama/Azure replies.
  - Coordinate with main-apis#48, main-apis#35, main-apis#47, main-apis#50, main-apis#49: All restructure the ai-chat.ts turn loop (1093-1163: web search pre-pass, tool execution, cap summary, Gemini reviewer). Edit sequentially in one batch.
  - Coordinate with oracle#24: The 'no data leaves your machine' copy depends on whether the Gemini reviewer and rerank paths send data off-device.

- **[medium · correctness] Gemini reviewer rewrite is capped at 512 tokens and replaces full answers with truncated ones** `main-apis#48`
  - Where: `electron/ai-chat.ts:199`, `electron/ai-chat.ts:1163`
  - Problem: An 'IMPROVE' verdict replaces the complete streamed answer with a rewrite cut off mid-list, often losing the follow-ups, and every reply waits for an extra Gemini call.
  - Fix: In validateResponse read response_metadata finishReason; if MAX_TOKENS keep the original. Accept IMPROVE only if it is >= ~70% of the original length, starts with '## ', and keeps 'Suggested follow-ups:' when the original had it. Raise maxOutputTokens to >= 4096 and set thinking budget 0 if supported. Skip the reviewer when the answer already passes local format checks.
  - Tests: Truncated or short IMPROVE keeps the original; well-formed answer skips the reviewer call.
  - Risk: Higher Gemini cost per reviewed message; some formatting differences.

- **[medium · performance] ~14 KB duplicated system prompt is re-sent on every model call and ChatOllama uses the default small context** `main-apis#49`
  - Where: `electron/ai-chat.ts:178`, `electron/ai-chat.ts:602`
  - Problem: The system prompt repeats sections two or three times and is sent up to 7 times per message; on Ollama the default 2-4k window overflows so instructions or the question are cut off.
  - Fix: Merge SYSTEM_PROMPT into one copy of each section (drop the prose tool list at 659-670; keep the follow-ups block matching parseSuggestedFollowUps). Pass numCtx to ChatOllama from a getOllamaSettings setting (default 8192) included in configKey. Insert web-search context after the stable prefix rather than at index 1. Re-run the chat-prompts harness.
  - Tests: Prompt length check; ChatOllama constructed with numCtx; changing the setting rebuilds the model; chat-prompts harness passes.
  - Risk: Wording changes can shift answer style; larger numCtx raises Ollama VRAM use.

- **[low · correctness] AI add/remove library tools break on the 'steam-123' style ids that getLibraryGames returns** `main-apis#6`
  - Where: `electron/ai-chat.ts:291`, `electron/ai-chat.ts:919`, `electron/ai-chat.ts:935`
  - Problem: getLibraryGames gives the model ids like 'steam-123', 'epic-...' or 'custom-4', but the add and remove tools coerce them to numbers, which become 0. Removing reports 'Game 0 is not in the library', Epic and custom games can never be removed, and adding queues a junk 'Game 0' (steam-0) entry that the renderer actually adds.
  - Fix: Rename the getLibraryGames field to gameId and add steamAppId (number|null). Add a parseSteamAppId(v) helper (number, numeric string, or 'steam-<digits>' -> positive int or null) used only by add/remove in executeTool; return a tool error ('Invalid appId; call searchSteamGames first') on null. removeGameFromLibrary also accepts a gameId string validated against currentLibraryData and queues that exact entry. addToLibraryTool rejects appId <= 0 and queues nothing when getAppDetails returns null. Do not change safeInt globally.
  - Tests: executeTool with 'steam-123' removes the right entry; 'epic-ns:offer' gameId removes the Epic entry; add with 'abc' or 0 returns an error and queues no action.
  - Risk: Widens what the model can remove; ship together with the removal confirmation item.
  - Coordinate with main-apis#32: Both change the getLibraryGames tool output and id format (ai-chat.ts:288-291). Add/remove tools depend on the ids it returns.

- **[low · correctness] parseSuggestedFollowUps deletes everything after the last '---' when there is no follow-up block** `main-apis#17`
  - Where: `electron/ai-chat.ts:736`
  - Problem: If the model uses --- as a section divider and has no follow-ups block, the whole section after the divider is silently removed from the shown and stored answer.
  - Fix: When no follow-up label follows the marker, return { content: content.trim(), suggestedFollowUps: [] }. Also only strip when at least one follow-up line was collected, and anchor the bare '---' fallback to a line start so table rows like '|---|' never match.
  - Tests: Content with '---\n### Option B' and no follow-ups stays intact; normal follow-up block still parsed.
  - Risk: None.

- **[low · correctness] AI chat price tool always uses the US gg.deals region** `main-apis#43`
  - Where: `electron/ai-chat.ts:575`
  - Problem: Users with another region see local prices on the details page but USD prices from the chat, and the chat fills the US cache entry.
  - Fix: Add a ggRegion field to the processMessage IPC payload filled from getGgRegion(), normalize with normalizeRegion(), and pass it to the deals tool through a per-request factory or closure (not a module global). Default 'us'.
  - Tests: processMessage with ggRegion 'gb' calls getPrices with 'gb'.
  - Risk: None.

- **[low · performance] Ollama chat runs a blocking DuckDuckGo search before nearly every message** `main-apis#50`
  - Where: `electron/ai-chat.ts:1093`, `electron/web-search.ts:23`
  - Problem: Common words like 'new', 'free' or 'review' trigger a search, and the search can wait 10s or more on slow networks before the model starts.
  - Fix: Give webSearch an overall 2.5-3s deadline (AbortController/Promise.race; destroy the request and return []). Drop generic triggers (new, free, update, review, worth, mod, event, won, current, 'like .+ but', 'when (is|does|will)', 'where (can|do)') and keep explicit freshness intents (search, latest, release date, patch notes, price, news). Cache results per query for a few minutes.
  - Tests: needsWebSearch false for 'games like Hades'; true for 'latest patch notes'; slow mocked search returns [] after the deadline.
  - Risk: Fewer grounded answers for borderline current-events questions.

- **[low · security] Oracle loading panel claims 'no data leaves your machine'** `oracle#24`
  - Where: `src/components/oracle-view.tsx:624`, `src/services/reco-store.ts:1541`, `src/services/reco-store.ts:2159`
  - Problem: The overlay says everything runs locally and no data leaves the machine, but each compute sends taste-ranked game ids to Steam (always) and to gg.deals (when a key is set), which reveals the user's taste. The privacy claim is false.
  - Fix: Replace the line with fixed copy such as 'Scoring runs on your machine; only game IDs are sent to Steam (and gg.deals, if configured) for store data'. Do not make it depend on the gg.deals key, since the Steam call always happens.
  - Tests: Snapshot/text test of the loading overlay copy.
  - Risk: None.

### B13 API key storage and AI settings (8)
_settings-store.ts and settings-screen. Decide the Anthropic provider first, then move keys into main with encryption._

- **[high · correctness] Editing the hidden Gemini key saves the bullet characters as the real key** `ui-other#0`
  - Where: `src/components/settings-screen.tsx:1189`, `src/components/settings-screen.tsx:1190`, `src/components/settings-screen.tsx:596-605`, `src/components/settings-screen.tsx:530`, `electron/ipc/settings-handlers.ts:34`
  - Problem: When a Gemini key is saved and hidden, the input shows a masked copy (first 8 chars, bullets, last 4). One keystroke or Backspace turns that masked text into the key state, and 800 ms later it is saved over the real key. The UI says Saved, and every Gemini chat call fails from then on.
  - Fix: Stop binding the masked string to an editable value. Add a separate newKeyDraft state that starts empty; bind the input to it; when hasExistingKey is true, show placeholder 'Key saved - paste a new one to replace it' (same pattern as GgDealsSection). The debounced save runs only for a non-empty trimmed draft. Backstop in the settings:setApiKey handler: reject keys that do not match /^[A-Za-z0-9_-]+$/ (rejects bullets). Check the returned {success} in the renderer and show an error. Optionally drop the renderer's settings:getApiKey and use hasApiKey; if reveal is still wanted, fetch read-only on eye-toggle and never write it back.
  - Tests: Component test: with a saved key, type one char / Backspace in the hidden field and advance timers 800 ms; assert setApiKey not called with any string containing '•'. Paste a new key; assert setApiKey called with exactly that key. Handler unit test: settings:setApiKey with a bullet string returns success:false and does not call setGoogleAIKey.
  - Risk: Low. Users lose the ability to edit a key partially in place (they must paste a full new key), which is the intended behaviour.

- **[medium · security] Gemini API key 'encryption' uses a key derived from the userData path** `main-apis#34`
  - Where: `electron/settings-store.ts:134`, `electron/settings-store.ts:264`
  - Problem: The encryption key is a hash of a predictable path, so anyone with settings.json can decrypt the Google AI key; the gg.deals key already uses OS-protected storage.
  - Fix: setGoogleAIKey uses encryptSecret() (safeStorage 'ss:'). Migrate lazily in getGoogleAIKey(): if the stored value lacks 'ss:', decrypt with legacy decrypt(), re-encrypt with encryptSecret() and save only if the result has 'ss:'. Keep decryptSecret's fallback to decrypt(). Add a memo like ggKeyMemo to avoid repeated DPAPI calls.
  - Tests: Legacy value migrates to 'ss:' on first read; new set stores 'ss:'; safeStorage unavailable keeps legacy value.
  - Risk: A settings.json copied to another PC can no longer decrypt the key (same as gg.deals today).
  - Coordinate with main-core#24, ui-other#0, ui-other#3, ui-other#4, ui-other#5: Key storage redesign: Gemini key encryption, renderer readability, bullet-masked edits, moving Azure/Anthropic keys to main. Dropping Anthropic (ui-other#4) shrinks the scope of ui-other#3. Decide that first.

- **[medium · security] Azure and Anthropic API keys are stored as plaintext in localStorage while the UI says all keys are encrypted** `ui-other#3`
  - Where: `src/components/settings-screen.tsx:608-609`, `src/components/settings-screen.tsx:501`, `src/components/settings-screen.tsx:514`, `src/components/settings-screen.tsx:1282-1283`, `src/components/ai-chat-panel.tsx:496-512`, `src/components/ai-chat-panel.tsx:637-643`, `src/hooks/useAIChat.ts:163`, `src/hooks/useChatAvailability.ts:41-45`, `electron/ipc/ai-handlers.ts:18-36`, `electron/settings-store.ts:280-294`
  - Problem: The Azure OpenAI and Anthropic keys are written unencrypted to localStorage (the profile's LevelDB), readable by any local process, backup, or renderer script. The settings page tells every user that all API keys are stored securely and encrypted, which is only true for Gemini and gg.deals.
  - Fix: Step 1 (this release, immediate): change the line 1282-1283 copy to only claim encryption for Gemini and gg.deals. Step 2: add encrypted secret slots for azureKey (and anthropicKey if kept, see the Anthropic item) in settings-store.ts reusing the existing 'ss:' safeStorage helper with local-cipher fallback, behind has/set/clear IPC (no get). ai:sendMessage reads the Azure key from the store in main; drop azureKey from the renderer payload. Keep endpoint/deployment/apiVersion in localStorage. useChatAvailability and the chat panel use has*Key IPC. Move the Test connection fetch to main. One-time migration on startup: copy any localStorage key into the store via set IPC, then removeItem.
  - Tests: Migration test: a localStorage 'ark-azure-key' is moved into the store and removed from localStorage. IPC test: ai:sendMessage with Azure provider uses the stored key when the payload has none. Renderer test: useChatAvailability reports Azure available from hasAzureKey. Snapshot of the corrected copy.
  - Risk: Medium. Touches the Azure chat request path and adds migration; a migration bug could lose a beta user's key (they would re-enter it). Beta-only feature limits exposure.

- **[medium · correctness] AI Models settings: pending debounced saves are lost on leaving the tab, and a bad Ollama URL leaves the status stuck on 'Saving...'** `ui-other#5`
  - Where: `src/components/settings-screen.tsx:554`, `src/components/settings-screen.tsx:569-594`, `src/components/settings-screen.tsx:596-605`, `src/components/settings-screen.tsx:189`, `src/components/settings-screen.tsx:719`, `electron/ipc/settings-handlers.ts:104-111`
  - Problem: Toggles and key pastes in AI Models are saved 800 ms later, but leaving the tab within that window unmounts it and cancels the timer, so the change is lost and reverts next time. Separately, if the Ollama address is briefly invalid (for example 'localhost:11434' with no scheme), main rejects the whole batch including toggles, the empty catch leaves the status on 'Saving...' forever, and nothing tells the user. setApiKey and setAutoLaunch also ignore a {success:false} result and still show success.
  - Fix: 1) Keep pendingOllamaRef and pendingKeyRef holding the latest payload whenever a timer is scheduled; clear them when the save runs. In the mount-only cleanup (line 554), if a timer is pending, clear it and fire-and-forget window.settings.setOllamaSettings(pendingOllamaRef.current).then(() => embeddingService.clearUnavailableVerdict()).catch(()=>{}) and setApiKey(pendingKeyRef.current).catch(()=>{}); no setState there. Make the per-change cleanup at line 604 only clear the timer. 2) Add an 'error' value to ollamaSaveStatus; set it in the catch with a message. Validate the URL in the renderer (new URL(), http/https); if invalid, mark the field and send the batch without the url key so toggles still save. 3) Treat result.success === false from setApiKey as an error; in handleAutoLaunchToggle roll back on !result?.success like handleOverlayToggle. Optional: save boolean toggles immediately.
  - Tests: Fake timers: toggle Compact mode, unmount within 800 ms, assert setOllamaSettings called once with the new value. Type a key and unmount; assert setApiKey called with the full trimmed key (not partials). Enter 'localhost:11434' and toggle rerank; assert setOllamaSettings called without url and status shows error message. setAutoLaunch returning success:false reverts the toggle.
  - Risk: Low. Flush-on-unmount must not write partial keys; keep flushing only in the mount cleanup.

- **[low · correctness] Anthropic is offered as a chat provider but main always rejects it** `ui-other#4`
  - Where: `src/components/settings-screen.tsx:564`, `src/components/ai-chat-panel.tsx:499-500`, `src/components/ai-chat-panel.tsx:512`, `src/hooks/useChatAvailability.ts:45-46`, `electron/ai-chat.ts:140-143`, `electron/settings-store.ts:451-455`, `electron/ipc/settings-handlers.ts:168`
  - Problem: With Beta on and an Anthropic key entered, users can pick 'Anthropic (Claude)' in Settings and the chat panel, and the chat button appears even if Anthropic is the only key. Every message then fails with 'not yet supported'. The key is collected and kept in plaintext for a provider that is never used.
  - Fix: Add one shared CHAT_IMPLEMENTED_PROVIDERS constant (without 'anthropic') and filter on it in settings-screen.tsx:564, ai-chat-panel.tsx:500/512 and useChatAvailability.ts:46. In main, make settingsStore.getPreferredChatProvider treat 'anthropic' as invalid and fall back to the default, and have settings:setPreferredChatProvider reject it. Replace the Anthropic settings section with a disabled 'coming soon' note and remove 'ark-anthropic-key' from localStorage once. Keep 'anthropic' in type unions.
  - Tests: useChatAvailability returns unavailable with only an Anthropic key. getPreferredChatProvider with stored 'anthropic' returns the fallback. Settings provider list excludes Anthropic. Migration removes the stored key.
  - Risk: Low. Removes a non-working option; users who saved it silently move to the fallback provider.

- **[low · correctness] Corrupt or unreadable settings.json is silently overwritten with defaults, wiping keys and preferences** `main-apis#40`
  - Where: `electron/settings-store.ts:207`
  - Problem: Any read error, parse error or version mismatch falls back to defaults, and the next save overwrites the file, permanently losing API keys and all preferences.
  - Fix: ENOENT: defaults as now. EBUSY/EPERM/EACCES: retry once or twice; if still failing set loadFailed and do not write until the user changes a setting, then back up first. Parse failure or unexpected version: copyFileSync to settings.json.corrupt-<ts> (or .v<N>.bak) before using defaults, and log the path.
  - Tests: Malformed JSON produces a backup file before any save; locked-file read does not overwrite on the next unrelated save.
  - Risk: None.

- **[low · correctness] Chat button availability is checked only when Beta toggles, so provider changes in Settings are not reflected** `hooks#24`
  - Where: `src/hooks/useChatAvailability.ts:71`, `src/pages/dashboard.tsx:222`
  - Problem: Settings is a view inside the same Dashboard, so after adding or removing an AI provider the chat button's enabled state and tooltip stay stale until the Dashboard remounts.
  - Fix: Give the hook an optional refreshKey param added to the effect deps; call useChatAvailability(viewMode) from dashboard.tsx:222 so it re-checks when the user leaves Settings. Do not re-check on every keystroke or rely on window focus.
  - Tests: Render with viewMode 'settings', change provider mocks, switch viewMode to 'browse'; assert availability recomputed.
  - Risk: None.

- **[low · correctness] Settings progress for re-chunk and force re-index freezes after leaving and reopening Settings** `ui-other#17`
  - Where: `src/components/settings-screen.tsx:1039`, `src/components/settings-screen.tsx:1131`, `src/components/settings-screen.tsx:966`, `src/components/settings-screen.tsx:440-463`
  - Problem: Progress listeners for long jobs are tied to the button click, not the screen. Reopening Settings during a re-chunk or full re-index shows the job as running but progress counts stay frozen or missing. The old closures are held only until the job ends, so it is not a growing leak. ANN rebuild progress already re-syncs correctly.
  - Fix: Extend the existing mount effect at line 453: in sync() also set rechunkBusy/rechunkMessage/rechunkProgress/rechunkSuggestAnn from embeddingService, and setForceReindexProgress(running ? { ...embeddingService.catalogProgress } : null) (clone only while running). Remove the per-click subscribe/unsub pairs at 966, 1039, 1131 so handlers only start the job and set final status. Clear progress state when the busy flag drops.
  - Tests: Start a mocked re-chunk, unmount and remount Settings, emit progress events; assert the new instance shows updated counts. After completion progress clears. No subscriptions remain after unmount.
  - Risk: Low. Must keep final status messages that the click handlers currently set.

### B14 AI chat panel (renderer) (4)
_ai-chat-panel.tsx and useAIChat. Confirmation for destructive actions plus render performance._

- **[medium · security] AI chat applies LLM-issued library actions unchecked: removes games without asking, and writes arbitrary status strings** `ui-other#2`
  - Where: `src/components/ai-chat-panel.tsx:708`, `src/components/ai-chat-panel.tsx:714-716`, `src/hooks/useAIChat.ts:90-106`, `electron/ai-chat.ts:311-347`, `electron/ai-chat.ts:933`, `src/services/library-store.ts:530`
  - Problem: The model can queue 'remove from library' actions, and the renderer runs them right away with no confirmation, no cap and no undo. Third-party text the model reads (Steam reviews, store descriptions, web search) can steer it into removing games, and status, notes and ratings are lost. The 'add' action also stores whatever status string the model gave (for example 'Backlog' or 'want to play'), so the game matches no filter or chip and the bad status persists.
  - Fix: Move action handling into one shared helper used by both ai-chat-panel.tsx and useAIChat.ts. Apply 'add' actions immediately but pass status through a shared normalizeGameStatus(s) helper (case/space-insensitive match against the five GameStatus values including 'Playing Now', map dropped/paused to 'On Hold', finished/beaten to 'Completed', backlog/wishlist to 'Want to Play', fallback 'Want to Play'); also call it in the electron addToLibrary tool before queueing so the model's confirmation text names the saved status. Do not apply 'remove' actions: attach them to the assistant message as a pending confirmation card listing game names with 'Remove N games' / 'Cancel', and call removeFromLibrary only on click. Optional: in main, flag removals for confirmation when more than 3 are queued in a turn; snapshot removed entries for an Undo toast.
  - Tests: Unit tests for normalizeGameStatus (exact, case variants, synonyms, garbage -> 'Want to Play'). Component test: a response with remove actions renders a confirm card and removeFromLibrary is not called until Remove is clicked; Cancel leaves the library intact. Same tests via the useAIChat path. Add action with status 'backlog' stores 'Want to Play'.
  - Risk: Low. One extra click for genuine 'remove X' requests, consistent with the dashboard's existing delete confirmation. Normalizing may map an intended status differently in rare synonym cases.

- **[medium · performance] AI chat re-renders and re-parses every message on each keystroke and stream token, and smooth-scrolls on every token** `ui-other#10`
  - Where: `src/components/ai-chat-panel.tsx:920`, `src/components/ai-chat-panel.tsx:264`, `src/components/ai-chat-panel.tsx:344-353`, `src/components/ai-chat-panel.tsx:531-533`, `src/components/ai-chat-panel.tsx:656-664`, `src/components/ai-chat-panel.tsx:736`, `electron/ipc/ai-handlers.ts:57-59`
  - Problem: Message bubbles are memoized, but each gets a new follow-up callback every render, so typing one character or receiving one streamed token re-renders and re-parses the markdown of every message. Each token also starts a new smooth scroll, which jitters and keeps pulling the user back to the bottom if they scroll up to read. Long chats make typing and streaming laggy.
  - Fix: 1) handleSendRef = useRef(handleSend); assign current each render; pass onFollowUp = useCallback(q => handleSendRef.current(q), []). 2) Hoist REMARK_PLUGINS = [remarkGfm] and MARKDOWN_COMPONENTS to module scope. 3) Coalesce stream chunks: keep the latest fullContent in a ref and flush one setMessages per requestAnimationFrame; cancel the pending frame in unsubscribe and before the final setMessages at line 736. 4) Keep stickToBottomRef updated by the container's onScroll (true when within ~80 px of bottom); only auto-scroll when true; while streaming set container.scrollTop = scrollHeight once per frame; use smooth scrollIntoView only when messages.length changes. Optional: send only deltas over IPC with fullContent kept as source of truth in the final response.
  - Tests: Render-count test: typing in the input does not re-render existing MessageBubbles. Streaming 100 chunks in one frame produces one setMessages. After stream ends no late frame resurrects the streaming message. Follow-up chip sends with the latest attachedImage/gameContext. Scrolled-up user is not pulled down during streaming.
  - Risk: Low-medium. rAF batching must not drop the final chunk or reorder the final replace; follow-up must use the latest handleSend via the ref.

- **[low · correctness] New conversation or Clear history during an in-flight AI reply puts the old exchange into the new conversation** `ui-other#18`
  - Where: `src/components/ai-chat-panel.tsx:784`, `src/components/ai-chat-panel.tsx:816-833`, `electron/ipc/ai-handlers.ts:65-66`, `electron/chat-store.ts:204-209`
  - Problem: The New conversation and Clear history buttons stay active while a reply is pending. When the reply finishes, main saves it into whatever conversation is now active, so the old exchange appears in the new chat, or history comes back right after clearing.
  - Fix: Add disabled={isLoading} to both header buttons with a title explaining why, and an `if (isLoading) return;` guard in handleNewConversation and handleClearHistory. Keep applying library actions (the user asked for them).
  - Tests: While isLoading, both buttons are disabled and handlers are no-ops. After reply, they are enabled.
  - Risk: Very low.

- **[low · performance] Dashboard bundle always loads the AI chat panel, emoji data and markdown libraries, even with Beta off** `ui-other#19`
  - Where: `src/pages/dashboard.tsx:70`, `src/components/ai-chat-panel.tsx:26-29`
  - Problem: The chat panel and its heavy dependencies (about 430 KB of emoji data plus markdown parsing) are part of the Dashboard chunk, so every launch parses them even though chat is off by default. It costs tens of milliseconds at startup.
  - Fix: dashboard.tsx: const AIChatPanel = lazy(() => import('@/components/ai-chat-panel').then(m => ({ default: m.AIChatPanel }))); render in <Suspense fallback={null}>, gated by a sticky hasOpenedChat ref set when betaFeatures && isAIChatOpen first becomes true, and keep it mounted afterwards. Inside the panel, lazy-load @emoji-mart/react and pass data={async () => (await import('@emoji-mart/data')).default}, rendering the picker only while open. Optional: prefetch on hover of the chat toggle.
  - Tests: Build check: dashboard chunk no longer contains emoji-mart data or micromark. Opening chat mounts the panel; closing keeps state; emoji picker loads data on first open.
  - Risk: Low. Brief Suspense delay on first chat open.

### B15 ANN and ML off main thread (6)
_ann-index.ts, level-store, ml-model and ml-synth. Move heavy work to workers or async. Measure boot and query latency._

- **[high · performance] ANN queryBatch runs 200 sequential HNSW searches synchronously on the main process per call** `main-apis#29`
  - Where: `electron/ann-index.ts:627`, `electron/ann-index.ts:52`
  - Problem: Building the game graph sends hundreds of 200-vector batches; each blocks the Electron main process for 1-2 seconds, freezing IPC, the overlay and the session tracker repeatedly during graph builds.
  - Fix: Pack the prepared vectors into one Float32Array(n*DIMS) and make a single index.search(matrix, k, threads) call with threads ~ os.cpus().length-1, mapping BatchMatches row i to keys/distances[i*k..(i+1)*k] and skipping sentinel/Infinity entries. Also cap per-call blocking: process in sub-chunks of 32-50 vectors with await setImmediate between. Keep EF_SEARCH unchanged so neighbours stay identical.
  - Tests: queryBatch returns the same neighbours as the per-vector loop on a fixture index; padding entries are filtered; a 200-vector batch yields to the event loop between sub-chunks.
  - Risk: Result mapping changes to BatchMatches; any ef change would alter graph neighbours (avoid it).

- **[medium · performance] Multi-GB ANN index is loaded with a synchronous native load() on the main process at every renderer boot** `main-apis#30`
  - Where: `electron/ann-index.ts:286`, `electron/ann-index.ts:307`
  - Problem: Loading the whole index and its id map blocks the main process for seconds at startup, stalling the splash, tray, overlay and every other startup IPC call.
  - Fix: Short term: defer ann:load until after first paint/library hydrate, and read the id map with fs.promises.readFile before the native load so only the native part blocks. Longer term (separate release): move the whole ANN manager (load, search, add, save) into an Electron utilityProcess with ann-handlers proxying to it; a usearch Index cannot be moved between threads, so a worker_thread load alone does not work.
  - Tests: Startup sequence test: ann:load runs after hydrate; id map read is async.
  - Risk: Deferring delays first Oracle availability slightly; a utilityProcess move is a large refactor.

- **[medium · performance] ONNX ensemble scoring and model load block the Electron main thread** `main-apis#52`
  - Where: `electron/ml-model.ts:194`, `electron/ml-model.ts:333`, `electron/ipc/ml-handlers.ts:55`
  - Problem: Split vote, kept. One verifier measured each fold run blocking the main thread up to 1.67s at 3000 rows (reco-store sends 2000-row batches, 8 folds each), plus ~166ms profile parse and up to 633ms per session create on first load. During Oracle computes the main process stalls IPC and the tray repeatedly. A worker rewrite is not justified now.
  - Fix: Cheap fix: in scoreGames split rows into sub-batches of ~250, run each fold per sub-batch, and await setImmediate between runs so no single blocking slice is long (scores are identical since rows are scored independently). In _doLoadModel use fs.promises.readFile for the JSON files and fs.promises.copyFile in ensureDataFiles. Set sessOpts.intraOpNumThreads to about half the cores. Optionally warm loadModel at idle after startup.
  - Tests: scoreGames output identical (within float tolerance) between chunked and unchunked runs on a fixture; load reads files asynchronously.
  - Risk: Slightly longer total scoring time from extra run calls; scores unchanged.

- **[low · performance] Coherent ANN index is re-serialized synchronously on the main thread every 60s during embedding passes** `main-apis#31`
  - Where: `electron/ann-index.ts:383`, `electron/ann-index.ts:425`
  - Problem: During long catalog embedding passes, the whole index (hundreds of MB to GB) is written synchronously about once a minute, freezing the main process each time.
  - Fix: In the re-chunk caller drop the periodic maybeSaveAnn() after each success or raise ANN_SAVE_INTERVAL_MS to 10-15 min. Keep forced end-of-phase saves (maybeSaveAnn(true)) and before-quit flushAnnIndexSync; keep SAVE_MIN_INTERVAL_MS as the safety throttle.
  - Tests: Interval constant test; end-of-phase save still forced.
  - Risk: A crash between saves loses more additions; backfill rebuilds them from cached vectors.

- **[low · performance] Embedding scans parse heavy vector rows on the main process; store:batch has no size cap** `main-core#25`
  - Where: `electron/storage/level-store.ts:336`, `electron/storage/level-store.ts:293`, `src/services/embedding-service.ts:395`, `src/services/embedding-service.ts:458`
  - Problem: Embedding rows store 1024-number arrays as JSON (about 4 KB each). Each 1000-row getChunk hop makes main parse about 4 MB and structured-clone a million numbers, a stall of tens of ms per hop, repeated over full scans of the embedding namespaces; the first pooled count does a full scan just to count. Catalog rows are small and fine. store:batch accepts any number of ops.
  - Fix: Add a store:count IPC using db.iterator({ gte, lt, values: false }) (modelled on hasImpl) and use it in levelPooledCount and key-index seeding so counting never decodes vectors. Cap store:batch at 5k ops and return an error above it. Follow-up only: store q as base64 Int8Array with a version flag and read-side fallback for old number[] rows. Do not add raw-string getChunk for UI-thread callers.
  - Tests: Unit test: store:count matches row count without calling JSON.parse; batch of 5,001 ops returns error; levelPooledCount uses count IPC.
  - Risk: Low for count and cap. The storage-format follow-up needs a migration test that decoded vectors are byte-identical.

- **[low · correctness · ranking] ML synthetic profiles map 'Massively Multiplayer' to 'mmo', a tag missing from the model vocabulary** `main-apis#38`
  - Where: `electron/ml-synth.ts:33`
  - Problem: MMO games outside the bundled set lose their most distinctive tag, and some fall below the minimum tag count and get no ML score.
  - Fix: Reverse the alias: map 'mmo' and 'mmorpg' to 'massively multiplayer', remove 'massively multiplayer' -> 'mmo'. Export ALIASES and add a test that every alias target is a key in buildTagIndex(tag_mapping.json).
  - Tests: src/test/electron/ml-synth.test.ts: every ALIASES value exists in the vocabulary; 'Massively Multiplayer' and 'MMO' both resolve to a valid index.
  - Risk: Changes synthetic ML scores for MMO candidates.

### B16 Library import, export and clear (7)
_library-store import and clear plus custom-game-store and the settings confirmation. Must land together._

- **[high · correctness · ranking] Library sorted cache goes stale after import and after boot hydration (old or empty library shown); import also skips date and status sanitising** `renderer-stores#0`
  - Where: `src/services/library-store.ts:1077`, `src/services/library-store.ts:1147`, `src/services/library-store.ts:340`, `src/services/library-store.ts:392`, `src/services/library-store.ts:427`, `src/services/library-store.ts:906`, `src/services/library-store.ts:1091`, `src/services/library-store.ts:635`, `src/services/splash-screen.tsx:343`
  - Problem: getAllEntries() caches its sorted list and keeps returning it until a mutation clears it. Import (importData/importDataWithDelta) replaces every entry without clearing the cache, so the old library and stats stay on screen. At boot, an early getAllEntries() from the splash backfill runs before LevelDB has loaded, caches an empty list, and hydration never clears it, so Medals, Voyage, auto-on-hold and the splash Oracle compute see an empty library for the session. Import also builds dates with new Date(...) and does not map legacy 'Dropped', so a hand-edited or old file can leave an Invalid Date that makes later updateEntry calls throw.
  - Fix: 1) Call this.invalidateSortedCache() at the end of ingestEntries(), after this.entries.clear() in the migration-failure branch, and at the end of initializeAsync() after isInitialized=true. 2) In getAllEntries(), while !this.isInitialized, return a fresh sort without writing _sortedCache. 3) In importData, replace the hand-written loop with `const { count } = this.ingestEntries(entries)` (gets migrateGameId, toValidDate, Dropped->On Hold and the cache invalidation) and make sure the invalidate happens before saveNow()/notifyListeners(). Delete importDataWithDelta (no callers) or have it delegate to importData. Do not route the imports through clear(). 4) Defensive: line 635 uses LibraryStore.toValidDate(updated.addedAt, new Date()).toISOString(). Optional: have ensureArkBackfill await libraryStore.ready.
  - Tests: (a) getAllEntries(), then importData with different rows, then assert getAllEntries() returns the imported rows and getStats() matches. (b) Mock getAll to resolve late with rows, call getAllEntries() before ready, await ready, assert length > 0. (c) Import an entry with addedAt '2023-13-45' and status 'Dropped': assert addedAt is valid, status is 'On Hold', and a later updateEntry does not throw.
  - Risk: Low. ingestEntries also runs migrateGameId on import rows, which current exports already have in the new form. A notify after hydration may cause one extra render. Pairs with the cross-store sweep item, which also touches the pre-hydration path.
  - Coordinate with renderer-stores#5, renderer-stores#10, renderer-stores#21, renderer-stores#22, ui-other#1, renderer-stores#6: All in the library-store importLibrary/clear path (1024-1147) plus the custom-game counter. The import order, sanitising, custom-game inclusion and confirmation UI must be designed together.

- **[high · correctness] Library import wipes library, journey, sessions and status history with no confirmation, while the UI says it merges** `ui-other#1`
  - Where: `src/components/settings-screen.tsx:230-248`, `src/components/settings-screen.tsx:395`, `src/services/library-store.ts:1066-1080`
  - Problem: Import Library goes straight to importData, which clears every library entry, journey, session and status-history record and then refills from the file. The card says import merges. Importing an older or partial backup permanently deletes everything not in the file, with no warning and no backup.
  - Fix: 1) Split importData into parse/validate and apply. 2) After the file is picked, parse it and show the existing ConfirmDialog with real counts ('This replaces your library: N games now, M in file, plus journey, sessions and status history'). 3) Before applying, take an automatic snapshot via libraryStore.exportData() and write it to userData (or keep it in memory with a 'Restore previous library' action). 4) If the file lacks journeyHistory/sessionHistory/statusHistory arrays, keep the existing data for that store instead of clearing it. 5) Change line 395 copy to say the import replaces data. 6) Rename or fix importDataWithDelta so it does not imply merge.
  - Tests: Component test: choosing a file opens a confirm dialog and importData is not called until confirm; cancel leaves the store unchanged. Store test: importing a file with entries but no sessionHistory keeps existing sessions; a snapshot is written before clear. Snapshot restore round-trips exactly.
  - Risk: Medium-low. Touches the import path; a bug in the split could block imports. Snapshot writing adds disk IO but only on import.

- **[medium · correctness · ranking] Journey removedAt is not kept in step with the library: re-added games stay 'removed', cleared games stay 'owned'** `renderer-stores#5`
  - Where: `src/services/library-store.ts:553`, `src/services/library-store.ts:530`, `src/services/library-store.ts:1024`, `src/services/custom-game-store.ts:761`, `src/services/reco-store.ts:1128`, `src/components/dashboard.tsx:913`
  - Problem: Removing a game sets removedAt on its journey row, but re-adding it never clears it, so it shows as Removed in Voyage and Oracle gives it near-zero weight even after hours of play. 'Clear library' does the opposite: it never sets removedAt, so cleared games still count as owned and active in Voyage and Oracle and are excluded from candidates.
  - Fix: 1) Add journeyStore.clearRemoved(gameId) (no-op if no row or no removedAt; else delete, markDirty, invalidate, scheduleSave, notify) and call it from libraryStore.addToLibrary after entries.set (and the custom-game add path). Do not use record(). 2) Add journeyStore.markRemovedBatch(ids) (one shared timestamp, only rows without removedAt, one invalidate/save/notify). In handleClearLibraryFinalConfirm (or a new libraryStore.clearAll used only there) collect library and custom ids before clearing and call it; keep generic clear() side-effect free. 3) reco-store.ts:1128 uses `removedAt: libEntry ? undefined : entry.removedAt`. 4) One-time idempotent boot repair after library, custom and journey stores are ready: clear removedAt for rows whose id is in the library or custom store.
  - Tests: Remove then re-add: removedAt undefined and reco snapshot weight > 0. Clear library: every cleared id has removedAt, existing removedAt values unchanged, one notify. Boot repair: a stuck row for an in-library game is cleared.
  - Risk: The boot repair changes Oracle taste inputs for affected users (intended). markRemovedBatch must run before the clears or ids are lost.

- **[medium · correctness] Library export/import leaves out custom games while import wipes their history** `renderer-stores#10`
  - Where: `src/services/library-store.ts:1052`, `src/services/library-store.ts:1077`, `src/services/custom-game-store.ts`, `src/components/settings-screen.tsx:205`
  - Problem: Backups do not include custom games. Restoring on a new machine loses them, while their sessions, journey and status rows come back as orphans.
  - Fix: Add customGames: { entries, nextCounter } to exportData. Add customGameStore.importData(entries, nextCounter): refuse when isReadOnly(), replace entries, set nextCounter = max(payload, recomputeCounterFromEntries(), current), persist via _writeQueue after a queued clearNamespace, notify. Call it from importData (and importDataWithDelta if kept) before the history stores replay, only when parsed.customGames exists; for old files leave existing custom games alone and still bump nextCounter past any custom-N id in the imported history. Include the custom count in the toasts.
  - Tests: Export with 2 custom games, clear everything, import: both custom games back, ids unchanged, a new custom game gets the next id. Import an old file without customGames: existing custom games untouched.
  - Risk: Low; export format gains a field, old files stay compatible.

- **[medium · correctness] Clear Library resets the custom-game id counter, so new custom games inherit old games' sessions, hours and history** `renderer-stores#6`
  - Where: `src/services/custom-game-store.ts:763`, `src/services/custom-game-store.ts:348`, `src/services/custom-game-store.ts:494`
  - Problem: After 'Clear library', the next custom game gets id custom-1 again. Sessions, status history and journey rows for the old custom-1 are kept, so the new game shows the old game's playtime and dates.
  - Fix: In clear(), do not reset nextCounter. In the queued _writeQueue task, after clearNamespace succeeds, put m:nextCounter with the current value and only then set _lastPersistedCounter. In the failed-migration branch (line 348) keep max(current, recomputed). Safety net for already-affected users: in addGame (lazily, since other stores may load later), bump the counter to at least 1 + the highest custom-N id found in sessionStore, statusHistoryStore and journeyStore.
  - Tests: Add custom-1, record a session, clear library, add a new custom game: id is custom-2 and getTotalHours is 0. Restart (re-init from mocked LevelDB) after clear: counter persists. Pre-existing orphan custom-3 session: new id is >= custom-4.
  - Risk: Low. Ids are never reused, which is the intent.

- **[low · correctness] Import restores the journey before sessions and status history, so firstPlayedAt falls back to addedAt** `renderer-stores#21`
  - Where: `src/services/library-store.ts:1103`, `src/services/library-store.ts:1108`, `src/services/library-store.ts:1120`, `src/services/journey-store.ts:800`
  - Problem: During import the journey backfill looks up first sessions and first Playing transitions while those stores are still empty, so played games without timing get the add date as their first-played date, and it is never corrected.
  - Fix: In importData (and importDataWithDelta if kept) import statusHistory and sessionHistory before journeyHistory (both fill memory synchronously). Keep the ark:libraryImportedAt write. Sturdier option: move the backfill into a public journeyStore.backfillFirstPlayedFromEvidence() called after all three imports.
  - Tests: Import a played entry with no timing, a session starting 2024-05-01 and addedAt 2023-01-01: firstPlayedAt is 2024-05-01.
  - Risk: Low.

- **[low · correctness] Status-history and session imports skip the validation and gameId migration that hydrate applies** `renderer-stores#22`
  - Where: `src/services/status-history-store.ts:461`, `src/services/session-store.ts:502`, `src/services/journey-store.ts:733`
  - Problem: Imported rows with unknown statuses, bad timestamps or old numeric game ids go straight into the live timeline and session totals, which can break the Voyage timeline and miss hours for the game until the next restart.
  - Fix: statusHistoryStore.importData: skip non-objects, build `{ ...e, gameId: migrateGameId(e) }`, drop rows failing isValidStatusEntry (count as skipped), then compute the dedupe key from the migrated row (also for the _preHydration push). sessionStore.importData: skip non-objects, migrate gameId before dedupe, skip rows whose durationMinutes is not finite or startTime does not parse. Verify journeyStore.importData already migrates.
  - Tests: Import a status row with gameId 123 and one with status 'Bogus': first stored as 'steam-123', second skipped. Session with gameId 123 counted by getTotalHours('steam-123').
  - Risk: Low.

### B17 Store persistence and migrations (5)
_LevelDB save retry and migration-flag hardening across the history stores._

- **[medium · correctness] Status-history migration trusts a localStorage flag, so a missing flag overwrites the LevelDB history** `renderer-stores#9`
  - Where: `src/services/status-history-store.ts:106`, `src/services/status-history-store.ts:181`, `src/services/status-history-store.ts:197`
  - Problem: If localStorage is lost while LevelDB survives (or the flag write failed once), boot writes only this boot's rows over the whole saved status log. All past status changes are lost, along with first-played fallbacks, auto-hold detection and the Voyage timeline.
  - Fix: In the !migrated branch, first readWithRetry(() => store.get(LEVEL_NAMESPACE, LEVEL_DATA_KEY)). On read failure do not put; fall back like the existing failure path. If a row exists (and _clearedBeforeHydrate is false), map its entries through migrateGameId, filter with isValidStatusEntry, union with this.entries, dedupe by entryKey, sort by timestamp, then put, stamp the flag, set mode 'leveldb' and notify if rows were added. Only when LevelDB is empty put the in-memory payload as today. Log if the flag write throws.
  - Tests: Mock LevelDB with 50 rows and no localStorage flag: after init, entries contain all 50 plus pending rows, and the put payload has them. Read failure: no put issued.
  - Risk: Low.

- **[low · correctness] Failed localStorage-to-LevelDB migration is never retried once any row is written, orphaning the legacy data** `renderer-stores#23`
  - Where: `src/services/library-store.ts:338`, `src/services/library-store.ts:409`, `src/services/journey-store.ts:176`, `src/services/session-store.ts:112`, `src/services/custom-game-store.ts`
  - Problem: For a pre-v1.0.61 upgrader whose migration batch fails, the store shows an empty library but stays writable. Any add in that session writes a row, so later boots never retry and the old library in localStorage is lost for good.
  - Fix: On a failed migration batch, call this.enterReadOnly(res.error) in each of library, journey, session and custom-game stores instead of clearing entries and returning false. enterReadOnly already shows the legacy snapshot and blocks writes, so the next boot sees an empty namespace and retries. Do not merge on missing marker.
  - Tests: Mock the migration batch to fail: store is read-only, legacy entries visible, addToLibrary does not write; next init with empty LevelDB retries migration.
  - Risk: Low; the user sees their data read-only for that session instead of an empty library.

- **[low · correctness] A failed LevelDB save is never retried, so library, journey and custom-game edits are lost on quit** `renderer-stores#24`
  - Where: `src/services/library-store.ts:245`, `src/services/library-store.ts:178`, `src/services/journey-store.ts:465`, `src/services/custom-game-store.ts:189`
  - Problem: If a save batch fails once and no other edit follows, nothing retries, and the beforeunload flush only writes when a save timer is pending, so the change is lost when the app closes.
  - Fix: In each store: on res.error or throw set _saveFailed = true, log once per streak, and schedule a retry on a separate retry timer with backoff (2 s, 5 s, 15 s, max 3). Clear flag and counter on success. flushSave calls saveNowLevelDB when _saveTimer is pending, a retry is pending, or _saveFailed is set (unless read-only). custom-game-store keeps its identity/counter diff and adds the same flag.
  - Tests: Mock batch to fail once then succeed: change is persisted by the retry. Fail always: exactly 3 retries. beforeunload after a failure calls saveNowLevelDB.
  - Risk: Low.

- **[low · correctness] reco-history and shelf-bandit write the frozen v1.0.61 localStorage snapshot back over LevelDB when the boot read fails** `renderer-stores#18`
  - Where: `src/services/reco-history-store.ts:116`, `src/services/reco-history-store.ts:200`, `src/services/reco-history-store.ts:394`, `src/services/shelf-bandit-store.ts:105`, `src/services/shelf-bandit-store.ts:152`, `src/services/shelf-bandit-store.ts:163`
  - Problem: Both stores always load the old localStorage data first. If the LevelDB read fails at boot, the next dismiss, click or impression saves that stale data over the real rows: un-dismissed games come back as dismissed, and months of learned shelf ordering are overwritten.
  - Fix: In both constructors, call hydrateFromLocalStorage() only when the migration markers are absent or LevelDB is not in use. Wrap getAll in readWithRetry('RecoHistoryStore'/'ShelfBanditStore', ...). On final failure or a throw, set a private _readOnly flag that makes saveNowLevelDB (and save/flushSave in shelf-bandit) return early; keep in-memory updates. reco-history calls reportStorageReadOnly; shelf-bandit only logs. When getAll succeeds with zero rows and markers are set, clear the maps except _touchedD/_touchedH ids. Fix the misleading comment at reco-history lines 194-196.
  - Tests: Mock getAll to return {error} with markers set: call dismiss/recordImpression, advance timers, assert window.store.batch is never called. Markers set and empty namespace: dismissals empty after init.
  - Risk: Low. Normal boots already replace the maps with LevelDB rows, so normal output is unchanged.

- **[low · correctness] Transmissions decode history evicts by key order after a restart, not by age** `renderer-stores#30`
  - Where: `src/services/transmissions-history-store.ts:139`, `src/services/transmissions-history-store.ts:101`, `src/services/transmissions-history-store.ts:188`
  - Problem: After a restart, once 2,000 items are decoded, each new decode deletes the alphabetically first id instead of the oldest, so something read minutes ago can show as unread again.
  - Fix: Write value: Date.now() in persistLevelDB and base + i in the migration batch. On hydrate sort rows by Number(value) ascending (legacy value 1 sorts oldest), key as tiebreak, then build _cache, merging ids added by markDecoded before _ready instead of replacing them.
  - Tests: Hydrate rows with mixed values and keys, decode one more past MAX_IDS: the evicted id is the lowest value, not the lowest key. Pre-ready markDecoded ids survive hydrate.
  - Risk: Very low.

### B18 Library status propagation and backfill (4)
_library-store status sweep plus the cachedMeta backfill chain._

- **[medium · correctness · ranking] Cross-store status sweep runs on an empty map before hydration, and once fixed it is O(buckets x library) normalizeTitle calls** `renderer-stores#1`
  - Where: `src/services/library-store.ts:819`, `src/services/library-store.ts:848`, `src/services/library-store.ts:911`, `src/services/library-store.ts:767`, `src/services/library-store.ts:771`, `src/services/dedup.ts:18`, `src/services/dedup.ts:35`
  - Problem: The one-time startup sweep that repairs Steam/Epic status mismatches marks itself done on the first getAllEntries() call, which usually happens before the library has loaded, so it never runs on the real library. If it does run (once that is fixed, or on the localStorage path), each matching title bucket calls propagateStatusByTitle, which re-normalises every library title. That is about 0.75 to 3 s of main-thread blocking on a 2,000-game library, plus one save and notify per bucket. normalizeTitle itself rebuilds 19 regexes per call.
  - Fix: 1) Change the guard to `if (!this._crossStoreSweepDone && this.isInitialized) this.syncCrossStoreStatusesOnce();` (do not run it inside initializeAsync, since statusHistoryStore/journeyStore may not be hydrated; alternatively run it after Promise.all of the three stores' ready). Skip when read-only. 2) Extract a private applyPropagation(source, sibling, newStatus, nowIso) that holds the existing rules (NEVER_OVERWRITE, targets, same status, stamps, statusHistory record, journey sync) and does not save or notify. propagateStatusByTitle keeps its scan and calls it, then invalidate/save/notify if changed. The sweep passes each byKey bucket's members directly and does one invalidateSortedCache, scheduleSave and notifyListeners at the end. 3) Optional: hoist romanMap in dedup.ts to module scope (keep output byte-identical, the existing dedup tests guard this); optional per-entry key cache Map<gameId,{title,key}>.
  - Tests: Sweep test: hydrate a mocked LevelDB with a steam/epic pair (Completed vs Want to Play), call getAllEntries() once before ready and once after, assert the pair is synced after ready and only one notify fired. Benchmark-style test: 2,000 entries with 200 twin buckets, assert normalizeTitle is called about N times, not N x buckets (spy). Existing normalizeTitle tests unchanged.
  - Risk: The sweep will now actually change statuses on users' libraries on the first launch after the release (that is its intended repair, but it is new behaviour in production). Land after the same-store guard item so the sweep cannot wrongly sync remasters.
  - Coordinate with renderer-stores#2: Same status-propagation code in library-store.ts:767-911.

- **[medium · correctness · ranking] Status propagation syncs same-store games whose titles normalise the same (remasters, remakes)** `renderer-stores#2`
  - Where: `src/services/library-store.ts:767`
  - Problem: Marking a game Completed or Playing also marks any other library game with the same normalised title, even on the same store. 'Age of Empires II HD' and 'Age of Empires II: Definitive Edition', or Dead Space 2008 and 2023, change each other's status and write fake 'sync' history.
  - Fix: Add storeOf(entry): 'steam' or 'epic' from the gameId prefix (including 'epic-fn:'), falling back to cachedMeta.store, else null. In propagateStatusByTitle skip a sibling when either store is null or both stores are equal. Second guard: when both entries have a real release year in cachedMeta.releaseDate (reuse the confirmed-release-date helper, ignore TBA/sentinels) and they differ by more than 1, skip. Do not require matching developers. syncCrossStoreStatusesOnce inherits this through the shared helper.
  - Tests: Two steam-* entries ('Age of Empires II HD', 'Age of Empires II: Definitive Edition'): marking one Completed leaves the other unchanged. Steam 'Dead Space' 2008 vs Epic 'Dead Space' 2023: no propagation. Existing Steam-to-Epic Cyberpunk test still passes. Custom-id sibling is never touched.
  - Risk: Some genuine cross-store pairs with very different metadata years would stop syncing. Already-mis-synced entries are not repaired (optional one-time undo using crossStoreSyncedFrom).

- **[low · performance] Bulk cachedMeta backfill notifies the whole library per game and two backfill loops can run at once** `renderer-stores#34`
  - Where: `src/services/library-store.ts:626`, `src/hooks/useGameStore.ts:1711`, `src/services/game-service.ts:463`, `src/components/settings-screen.tsx:237`
  - Problem: Kept as low. After importing a legacy file without cached metadata, every game's backfill triggers a full library notify and O(N) rebuilds, and the settings backfill and the useLibraryGames backfill can walk the same ids together, doubling fetches. It is a one-time transient cost.
  - Fix: Put the backfill in one place: guard gameService.backfillLibraryMissingCachedMeta with a module-level in-flight promise/Set and have the useLibraryGames effect call it instead of its own queue. Add a narrow LibraryStore.setCachedMetaBatch(map) that applies only cachedMeta, runs syncTitleIfPlaceholder for ids with a journey row, and calls invalidateSortedCache/scheduleSave/notifyListeners once; the loop flushes every ~25 games or ~2 s and at the end. No general beginBatch/endBatch.
  - Tests: Backfill of 100 games triggers about 4-5 notifies, not 100. Two concurrent callers share one run (getGameDetails called once per id).
  - Risk: Low.
  - Coordinate with hooks#8: Both are the cachedMeta backfill loop (useGameStore:1692-1711, game-service:431-463). Make it a single shared, cancellable chain with batched notify.

- **[low · performance] cachedMeta backfill chain is never cancelled or shared, so each Dashboard remount starts another parallel chain over the same ids** `hooks#8`
  - Where: `src/hooks/useGameStore.ts:1692`, `src/services/game-service.ts:431`
  - Problem: Returning from a game page remounts the Dashboard, and each mount starts its own backfill walking the same entries without metadata. During a large import this sends duplicate rate-limited Steam/Epic detail requests and repeated library writes and notifications.
  - Fix: Move the backfill state to module scope: backfillAttempted Set, backfillQueue array, backfillRunning flag. The effect only enqueues ids lacking cachedMeta that are not in the set and starts runNext if idle. In runNext re-check libraryStore.getEntry(id)?.cachedMeta before fetching and skip filled ids. Keep failed ids in the set for the session. Do not cancel on unmount (it writes to the global store). Have gameService.backfillLibraryMissingCachedMeta use the same module-level set/runner. Clear module state when the library is cleared or replaced by import.
  - Tests: Hook test with fake timers: mount, unmount, remount three times with 10 entries lacking cachedMeta; assert getGameDetails is called once per id. Assert an id filled elsewhere mid-run is skipped.
  - Risk: Low. Failed ids are not retried until restart.

### B19 Catalog store and IDB cache (6)
_catalog-store and epic-catalog-store stream helpers, the idb-cache worker and the storage panel._

- **[medium · correctness] Catalog IDB-to-LevelDB migration stream (Steam and Epic) never settles when a batch write fails, hanging every catalog API for the session** `renderer-stores#4`
  - Where: `src/services/catalog-store.ts:158`, `src/services/catalog-store.ts:183`, `src/services/epic-catalog-store.ts:220`, `src/services/epic-catalog-store.ts:241`
  - Problem: For users upgrading from the old IndexedDB catalog, if one LevelDB batch write fails while the cursor is still reading, the stream stops reading but never resolves or rejects. The migration promise stays pending, so Oracle candidates, the release calendar, player counts and Epic browse all wait forever, and the rejection goes unhandled.
  - Fix: Extract a shared helper (e.g. src/services/idb-stream.ts) used by both stores: `pending = pending.then(() => failed ? undefined : onBatch(drain)).catch((err) => { if (!failed) { failed = err; reject(err); } });` (no rethrow). Keep `if (failed) return` in onsuccess. In the !cursor branch, after `await pending`, return if failed before the final onBatch/resolve. Do not await IPC inside onsuccess (the IDB transaction auto-commits). Optional separate change: backpressure (stop after ~4 queued batches, reopen with IDBKeyRange.lowerBound(lastKey, true)) and an overall timeout around runMigration.
  - Tests: Fake IDB cursor with 3+ batches where onBatch rejects on the 2nd: assert the stream promise rejects (no timeout), no unhandled rejection, and runMigration clears _migrationPromise and counts the attempt. Same test for epic-catalog-store.
  - Risk: Low. Failed migrations now reach the existing retry/disable path instead of hanging.
  - Coordinate with renderer-stores#29, renderer-stores#32: catalog-store.ts stream helpers. Error propagation (renderer-stores#32) changes how the migration (renderer-stores#4) and resume counting behave.

- **[low · correctness] LevelDB stream helpers swallow getChunk errors, so a partial scan is treated as complete (watermarks, graph, skip index)** `renderer-stores#32`
  - Where: `src/services/catalog-store.ts:255`, `src/services/epic-catalog-store.ts:307`, `src/services/embedding-service.ts:533`, `src/services/embedding-service.ts:578`, `src/services/embedding-service.ts:3592`, `electron/storage/level-store.ts`
  - Problem: Kept after review, at low severity. A rate limit is not a realistic trigger, but one corrupt stored row makes its chunk fail on every scan. Every full walk then silently stops at that row, so the embedding pass can mark itself done with games unembedded, and the graph and candidate pool are built from a partial set with only a console error.
  - Fix: (1) In level-store getChunkImpl, decode each row in its own try/catch; skip and log undecodable rows (return them as skipped keys) so one bad value does not poison the range. (2) Make the renderer stream helpers retry a failed hop once, then return {count, complete:false} (levelStreamPooled already computes complete). _runCatalogPass skips the watermark write and reports 'error'; graph persistence skips saving; a partial skip index is treated as unusable; queryForCandidates and UI getAllEntries keep partial results with a warning.
  - Tests: getChunkImpl with one corrupt JSON row returns the other rows plus skipped. Stream helper with a persistent error returns complete:false, and _runCatalogPass does not write the watermark.
  - Risk: Low; touches main-process store code and several callers.

- **[low · performance] Catalog sync resume reads every pending catalog row over IPC just to count how many exist** `renderer-stores#29`
  - Where: `src/services/catalog-store.ts:646`, `src/services/catalog-store.ts:782`, `src/services/store-bulk.ts`
  - Problem: Resuming an incomplete catalog sync loads and copies full rows for up to ~155K ids, tens to hundreds of MB of work on both processes, only to use the count. It repeats every 15 minutes while the catalog is incomplete.
  - Fix: Add a main-process store:countExisting(namespace, keys) (db.getMany on encoded keys, return count of non-undefined, no JSON.parse), with the 10k-key cap and rate limiter, plus preload binding. Renderer fallback: loop window.store.getMany in 2000-key slices summing filter(Boolean).length and dropping each slice. On error, use the non-resume totalEntries arithmetic (Math.max(prevTotal, totalGamesStored)) instead of treating the count as 0.
  - Tests: countExisting returns the right count for a mix of present and missing keys. Resume path with mocked handler sets totalEntries correctly; handler error falls back without inflating.
  - Risk: Low.

- **[low · performance] Browse IDB cache slimming misses longDescription, so every save and load carries full Steam description HTML** `renderer-stores#28`
  - Where: `src/workers/idb-cache.worker.ts:31`, `src/services/steam-service.ts:94`
  - Problem: The cache strips fields no game has (detailedDescription, aboutTheGame) but keeps longDescription, so the ~600 Steam browse games carry a few MB of HTML through the worker and IndexedDB on every save and boot. (Epic browse rows already have it empty.)
  - Fix: In slimGames, strip HTML tags and truncate longDescription to 1500 chars (the cap adult-content-filter's getCombinedText reads), leave '' as is. Remove the dead STRIP_KEYS entries. Bump CACHE_FORMAT_VERSION only if a one-time refetch at boot is acceptable; otherwise old fat entries are replaced on the next save.
  - Tests: slimGames on a Steam game with 20 KB HTML returns <= 1500 plain chars; adult filter verdict on cache rows unchanged for a fixture.
  - Risk: Low; adult filter sees the same first 1500 chars only if tag stripping does not shift content, so test the verdict equality (strip tags after reading, or truncate raw, to be exact).
  - Coordinate with oracle#25, oracle#5, renderer-stores#26: idb-cache worker changes (slimming, reopen on failure) affect the browse cache payload that reco-store re-reads (1264-1269).

- **[low · correctness] idb-cache worker keeps a failed IndexedDB open forever** `oracle#25`
  - Where: `src/workers/idb-cache.worker.ts:47-67`
  - Problem: If opening the browse cache fails once, the worker keeps the rejected promise, so every later save and load fails for the rest of the session and the next launch re-fetches everything. It is the only IDB store in the repo that does not follow the reset pattern. Rare, but cheap to fix.
  - Fix: Copy the catalog-store.ts:76-95 pattern: in req.onerror set dbPromise = null before reject(req.error); in onsuccess set dbInstance.onclose = () => { dbInstance = null; dbPromise = null; } and onversionchange to close and null both. Optionally null dbInstance when db.transaction() throws InvalidStateError in the save/load/clear handlers.
  - Tests: Worker unit test with a fake indexedDB whose first open fails and second succeeds: the second save succeeds.
  - Risk: Very low.

- **[low · correctness] Storage panel catalog rows measure the frozen legacy IndexedDB after the LevelDB migration** `oracle#23`
  - Where: `src/services/system-status.ts:196`, `src/services/catalog-store.ts`
  - Problem: After migration the live Steam and Epic catalogs (and embeddings) live in LevelDB, but the storage rows still count the old IndexedDB copy, so they show migration-day numbers forever, or 0 on a fresh install.
  - Fix: Add a main-process IPC store:namespaceStats(namespaces[]) in electron/ipc/store-handlers.ts and preload.cjs (keys-only iterator count + db.approximateSize on the prefix). Map the Steam Catalog, Epic Catalog and Embeddings rows to their LevelDB namespaces and use the IPC only when the migration marker (ark-steam-catalog-migrated-v1, ark-epic-catalog-migrated-v1, ark-embeddings-migrated-v1) is 'yes' and window.store exists; otherwise keep the IDB measurement. Do not call catalogStore.getEntryCount() from the panel (it would trigger the migration). Deleting the legacy IDB is a separate later step.
  - Tests: system-status test: marker 'yes' -> rows use the IPC values; marker missing -> IDB measurement; no migration triggered by opening the panel.
  - Risk: Low; new IPC surface.

### B20 Release dates and dedup (6)
_One shared date parser in steam-service and dedup, then the consumers._

- **[medium · correctness] Non-ISO Steam release dates ('Coming soon', 'TBA', 'Q1 2027') break Browse: games are hidden and release-date lists come out unsorted** `hooks#6`
  - Where: `src/hooks/useGameStore.ts:561`, `src/hooks/useGameStore.ts:588`, `src/services/dedup.ts:147`, `src/hooks/useDeferredFilterSort.ts:198`, `src/hooks/useDeferredFilterSort.ts:221`, `src/hooks/useDeferredFilterSort.ts:303`, `src/hooks/useDeferredFilterSort.ts:331`, `src/services/steam-service.ts:66`
  - Problem: Steam returns text dates for unreleased games and the app keeps them raw. The release timestamp then becomes NaN, which the '?? 0' fallback does not catch, so Coming Soon, New Releases, Trending and Free come out in jumbled order. Separately, the filter compares the first four characters against '2099' as text, and letters sort after digits, so all these games are hidden from every Browse category except Coming Soon and never match a year filter.
  - Fix: Add exported helpers in dedup.ts: releaseTsOf(d?: string) => { if (!d) return 0; const t = Date.parse(d); return Number.isFinite(t) ? t : 0; } and releaseYearOf(d?: string) using /\b(19|20)\d\d\b/ (reuse the useHltbTimes version). Use releaseTsOf in dedupSortAndStamp (:147) and useGameStore.ts:561/:588 (keep the re-stamp on the 'all' branch; it becomes idempotent). In useDeferredFilterSort replace the lexical `y >= '2099'` checks (:221, :303) with a numeric `const y = releaseYearOf(...); if (y != null && y >= SENTINEL_YEAR) hide` using the shared SENTINEL_YEAR (2090) from dedup.ts, and use releaseYearOf for the year filter (:198, :331). Map non-finite values to 0 in the comparator at :397 as a backstop. Do NOT rewrite releaseDate to 'Coming Soon' or set comingSoon=true in dedup in this release: reco-store reads releaseDate/comingSoon from the browse cache (reco-store.ts:1295-1301), so that would change Oracle output.
  - Tests: Unit: releaseTsOf/releaseYearOf on 'Coming soon', 'To be announced', 'Q1 2027', 'December 2026', '2027', ISO strings. Sort test: list with NaN-producing dates is strictly ordered by timestamp. Filter test: a 'Q1 2027' game appears in All/Trending and matches year 2027; a parsed 2099 date stays hidden.
  - Risk: Low. Previously hidden TBA games now appear in Browse lists; confirm that is wanted. Keep dedup's releaseDate/comingSoon output unchanged to avoid an Oracle change.
  - Coordinate with renderer-stores#25, renderer-stores#7, ui-browse-details#18, ui-voyage#28: All depend on Steam release-date parsing (steam-service.ts:64, dedup.ts:126-147). Add one shared parser that marks precision, then update the consumers.

- **[medium · correctness · ranking] Dedup drops distinct same-store games with similar titles and re-merges a merged Steam+Epic entry with a later Epic edition** `renderer-stores#7`
  - Where: `src/services/dedup.ts:126`, `src/services/dedup.ts:86`, `src/services/dedup.ts:63`
  - Problem: deduplicateGames keys only on the normalised title. Two different Steam apps such as Skyrim and Skyrim Special Edition, or Dead Space 2008 and 2023, collapse and the second silently disappears from browse and search. Separately, after Steam 'X' and Epic 'X' merge, a later Epic 'X Deluxe Edition' merges again and the Epic link and price switch to the Deluxe offer.
  - Fix: Rewrite the grouping: (1) first drop exact repeats by game.id (keeps removing the same app from several browse lists and duplicate Epic offers); (2) store Map<key, Game[]> so distinct same-store ids under one key are all kept; (3) pair each Epic entry with at most one Steam entry, preferring an exact match on a stricter key (punctuation removed, numerals mapped, edition words kept), else the first Steam entry; track a local Set of keys/stores already merged in this call and skip further Epic offers for a paired Steam entry (do not use availableOn, it comes from cache). Optionally collapse same-namespace Epic edition offers. Update game-service.test.ts:213 to expect 2 results for two Steam ids with the same title.
  - Tests: Two Steam ids titled 'Dead Space' -> 2 results. Same id twice -> 1. Mafia II Classic + Definitive (Steam) + Epic Definitive -> Epic merges with Definitive. Steam X + Epic X + Epic X Deluxe -> merged entry keeps the base Epic offer.
  - Risk: Browse lists get slightly longer; card order changes. Browse rows feed the Oracle candidate pool, so pools can change.

- **[low · correctness · ranking] Year-only Steam release dates ('2026') are stored as 1 January and treated as an exact past release** `renderer-stores#25`
  - Where: `src/services/steam-service.ts:64`, `src/services/detail-enricher.ts:42`, `src/services/dedup.ts:146`, `src/components/release-calendar.tsx:1631`
  - Problem: Upcoming games with only a year are parsed as 1 Jan of that year, so they sort among January releases, already look released at today's date, and show as 31 Dec in western time zones.
  - Fix: Add one shared parser used by steam-service.ts and detail-enricher.ts: convert to ISO only when the string has a day of month (/\b\d{1,2},?\s+\d{4}\b|\d{4}-\d{2}-\d{2}/). Otherwise, when coming_soon is true, set releaseDate to the existing 'Coming Soon' sentinel and keep the raw text in releaseDateText. Make release-calendar.tsx:1631 respect game.comingSoon.
  - Tests: '2026' with coming_soon -> 'Coming Soon', _releaseTs 0. '12 Mar, 2026' -> ISO. 'Q1 2026' -> sentinel. Calendar puts a comingSoon game in the Coming Soon bucket.
  - Risk: Sort position of these games changes; release date can feed Oracle upcoming/released handling.

- **[low · correctness · ranking] Adding from the details page stores Steam's display release date, so the game drops out of Release Year filtering** `ui-browse-details#18`
  - Where: `src/pages/game-details.tsx:850`, `src/hooks/useGameStore.ts:135`, `src/hooks/useDeferredFilterSort.ts:198`
  - Problem: Games added from their details page store dates like 'Oct 25, 2019' instead of ISO. They then never match any Release Year filter, never add their year to the options, and have no store or header image recorded. Oracle snapshots also read this release date.
  - Fix: Build the dialog game from the shared transform and override only library fields: `return { ...transformSteamGame(details), status: 'Want to Play', priority: 'Medium', publicReviews: '', recommendationSource: 'Personal Discovery', createdAt: new Date(), updatedAt: new Date(), isInLibrary: gameInLibrary };`. This gives ISO dates (keeping raw strings like 'Coming soon' that isReleaseDateConfirmed depends on), store 'steam' and headerImage. Do not hand-roll toISOString (timezone shift). Optionally add a one-time migration converting existing non-ISO cachedMeta.releaseDate values.
  - Tests: Details test: add a Steam game with release_date 'Oct 25, 2019' and assert cachedMeta.releaseDate starts with '2019-10-25', store === 'steam'. 'Coming soon' stays as-is. Library year filter 2019 includes it.
  - Risk: Oracle reads cachedMeta.releaseDate in reco-store snapshots; ISO dates (and especially the optional migration) can change Oracle features for affected games.

- **[low · correctness] Ark terminal panel shows 'REL::Invalid Date' for text release dates like 'Coming soon'** `ui-voyage#28`
  - Where: `src/components/showcase-view.tsx:1077`, `src/components/showcase-view.tsx:1078`, `src/components/showcase-view.tsx:1096`
  - Problem: Release dates stored as Steam display text ('Coming soon', 'Q4 2026') cannot be parsed, so the panel prints 'Invalid Date'. A game added before release keeps the stale 'Coming soon' on its journey row even after release.
  - Fix: Parse entry.releaseDate; if invalid (Number.isNaN(d.getTime())) try meta?.releaseDate; if neither parses, show the raw string uppercased and truncated to ~12 chars, or omit the REL line.
  - Tests: Unit test of the formatter: 'Coming soon' -> 'COMING SOON'; invalid entry date with valid meta date uses meta; ISO date formats as 'Oct 2023'.
  - Risk: None.

- **[low · correctness] News cards without a date show 'Jan 1, 1970' or 'Invalid Date'** `ui-browse-details#28`
  - Where: `src/pages/game-details.tsx:2373`, `src/pages/game-details.tsx:576`
  - Problem: Epic (and some Steam) news items with no or unparseable date show 1970 or 'Invalid Date' on the card.
  - Fix: In NewsCard render the date line only when `Number.isFinite(newsItem.date) && newsItem.date > 0`. At line 2373 use `const t = article.date ? Date.parse(article.date) : NaN; date: Number.isFinite(t) ? Math.floor(t / 1000) : 0`.
  - Tests: NewsCard test: date 0 and NaN render no date; a valid date renders formatted.
  - Risk: None.

### B21 Browse filter/sort pipeline and enrichment (12)
_useDeferredFilterSort, adult-content-filter and detail-enricher. Reuses the B06 collator helper._

- **[high · performance] Browse 'All'/Catalog adult-content check misses its cache on every game, every pass, and writes localStorage per miss** `hooks#1`
  - Where: `src/hooks/useDeferredFilterSort.ts:165`, `src/services/adult-content-filter.ts:138`, `src/services/adult-content-filter.ts:162`, `src/services/adult-content-filter.ts:182`
  - Problem: With adult content hidden (the default), every recompute classifies every game in a 5-6K pool, but the classifier cache keeps only the last 2000 entries in insertion order, so each pass evicts what the next pass needs. Every miss also re-stringifies about 2000 entries and writes localStorage, and every call (hits too) reads the version key from localStorage, blocking the main thread for seconds on filter changes.
  - Fix: In adult-content-filter.ts keep a module-level Map<string, boolean> as the source of truth, loaded lazily once (read the version key and stored JSON once). On a hit, do no localStorage access. On a miss, set the Map entry and mark dirty; schedule one debounced persist (requestIdleCallback or setTimeout ~2 s) that writes the most recent ~20-50K entries. Remove saveCache from the miss path. Keep the function signature and the classification logic byte-for-byte identical (reco-store.ts:1468 and the release calendar also call it).
  - Tests: Unit: classify 5,200 distinct games twice; assert the second pass does no phrase scan (spy) and localStorage.setItem is called at most once after the debounce. Assert identical true/false results versus the current implementation on a fixture set. Assert version-key getItem is called once per session.
  - Risk: Low. Results are unchanged; only caching and persistence change. Persisted size grows, so cap it.
  - Coordinate with ui-other#13: Both are adult-content-filter.ts cache behaviour (key miss plus write per miss). Fix the cache layer once.

- **[high · correctness] Library status change from a card reverts after 4 s; the deferred filter hook recomputes on stale data and then runs twice** `ui-browse-details#2`
  - Where: `src/hooks/useDeferredFilterSort.ts:503`, `src/hooks/useDeferredFilterSort.ts:491`, `src/hooks/useGameStore.ts:1555`
  - Problem: After the user picks a new status on a library card, the badge goes back to the old status after about 4 s and the card stays in its old section. The change is saved but not shown. The filter hook recomputes as soon as the store version bumps, but the library game list is only rebuilt 200 ms later, and that rebuild does not change the hook's fingerprint, so the fresh data is never picked up. The same early recompute also runs the whole filter and sort pipeline twice per library change for no benefit.
  - Fix: In useDeferredFilterSort, key library invalidation on the identity of currentGames, not on libraryVersion. Keep prevLibGamesRef and a libGamesRevRef counter. During render, when viewMode === 'library' and input.currentGames !== prevLibGamesRef.current, update the ref and bump the counter; if length <= 500, run computeAll and setOutput synchronously (what the libraryVersion branch does today) and set prevFingerprintRef.current to the fingerprint. Add the counter to the fingerprint for library view only (never for browse, where enrichment churn is intended). Move the fingerprint computation above the sync branches, and stamp prevFingerprintRef only inside the blocks where computeAll actually ran. Drop the libraryVersion-only branch, or keep it only for the custom-game path. Do not use useLibraryGames' updateCount as the version: it changes one render before setGames.
  - Tests: Hook test with fake timers: change an entry's status via libraryStore.updateEntry, advance 200 ms so useLibraryGames rebuilds, and assert sortedGames holds the new status and libraryGroups puts the card in the new section. Count computeFilterAndDynamic calls per mutation and assert one. Assert browse view does not recompute on enrichment-only reference changes.
  - Risk: One extra recompute per library rebuild, which is cheap at library sizes. Must not add the counter to the browse fingerprint.

- **[high · correctness] An empty filter or search result shows the whole unfiltered list instead of the empty state** `ui-browse-details#1`
  - Where: `src/pages/dashboard.tsx:394`, `src/pages/dashboard.tsx:446`, `src/hooks/useDeferredFilterSort.ts:496`
  - Problem: Searching the library for something with no match, or picking a filter that matches nothing, shows the whole library (filtered by status only) with the filter badge still active. The 'no results' screen never appears. Browse does the same: an empty result with no search falls back to the full category list. The dashboard treats an empty result as 'not computed yet'.
  - Fix: Add `computedFor: { viewMode, fingerprint }` to FilterSortOutput and set it in every setOutput path (initial computeAll, the data-length and libraryVersion sync paths, the viewMode inline path, and the rAF effect). In dashboard.tsx, pass sortedGames through unchanged, including [], when `hasPopulated && output.computedFor.viewMode === viewMode`. Use the mergedLibraryGames / steamGames fallback only when nothing has been computed yet or the output belongs to the other view. Do not require a strict fingerprint match, which would bring the fallback back for two frames on every keystroke.
  - Tests: Hook test: library view, query 'zzzz' returns sortedGames [] with computedFor.viewMode 'library'. Dashboard test: library search with no matches renders EmptyState 'no-results'; Store=Epic with no Epic games renders 'no-filter-results'; Browse filter that matches nothing renders the empty state, not the full list. Keep a test that a >300 game view switch still shows the fallback for the first frame.
  - Risk: A one-frame flash of the empty state if the ready check is too loose. Coordinate with the useDeferredFilterSort invalidation item, which edits the same setOutput paths.

- **[medium · performance] Adult-content classifier rewrites the whole localStorage cache on every miss, so calendar passes thrash it and evict Browse/Oracle verdicts** `ui-other#13`
  - Where: `src/components/release-calendar.tsx:1477-1483`, `src/services/adult-content-filter.ts:139`, `src/services/adult-content-filter.ts:162-176`, `src/services/adult-content-filter.ts:182-194`
  - Problem: With adult content hidden (the default), the calendar classifies every release, and each cache miss stringifies the whole 2,000-entry cache and writes localStorage twice, inside render. Every hit also reads localStorage. The 2,000 cap is smaller than the combined working set, so entries keep getting evicted and recomputed, slowing the calendar and Browse.
  - Fix: In adult-content-filter.ts: keep the in-memory cache authoritative; read the version key once at module load; on a miss set a dirty flag and schedule one flush via requestIdleCallback (setTimeout(0) fallback) that trims and stringifies once. Raise CACHE_MAX_ENTRIES (about 20000, ~400 KB) or stop persisting and use a session Map, since classification is cheap phrase matching; if persisting, re-insert on hit so trimming acts as LRU. Keep calling the classifier from the calendar (do not drop the filter); title-only input is fine.
  - Tests: Classifying 3,000 new titles causes at most one localStorage.setItem per idle flush. Hits do not call localStorage.getItem. Verdicts identical before and after (golden set of titles). Cache survives reload if persistence kept.
  - Risk: Low. Verdict logic unchanged; only caching and persistence timing change. A crash before the idle flush loses some cache entries, which are recomputed.

- **[medium · performance] Library sort by title uses localeCompare with an options object (about 90x slower than a shared Intl.Collator)** `hooks#4`
  - Where: `src/hooks/useDeferredFilterSort.ts:381`, `src/pages/dashboard.tsx:422`, `src/services/steam-service.ts:460`
  - Problem: Every comparison in the library 'All' status sort builds a new collator, so a 500-game library blocks render about 40 ms on every status click or rating edit and a 3000-game library about 220 ms per frame.
  - Fix: Add a shared module-level `export const titleCollator = new Intl.Collator(undefined, { sensitivity: 'base' })` (small util) and replace only the options-form calls with titleCollator.compare(a.title, b.title) at useDeferredFilterSort.ts:381 and dashboard.tsx:422, and titleCollator.compare(a.name, b.name) at steam-service.ts:460. Leave plain no-argument localeCompare calls alone (already fast, and switching would change tie order).
  - Tests: Unit: sort a fixture of mixed-case/accented titles with old and new comparators and assert identical order. Optional micro-benchmark asserting 3000 titles sort under a threshold.
  - Risk: None functionally; ordering is identical for the same locale and options.

- **[medium · correctness] Browse grid never shows player counts or enrichment that arrive after the first filter/sort pass** `hooks#5`
  - Where: `src/hooks/useDeferredFilterSort.ts:527`, `src/hooks/useDeferredFilterSort.ts:547`, `src/hooks/useGameStore.ts:836`, `src/hooks/useGameStore.ts:1028`
  - Problem: Player counts and catalog enrichment are merged into new game objects, but the list length and first/last ids stay the same, so the filter/sort fingerprint is unchanged and the grid keeps the old objects. Cards show no live counts and blank developer/genre until some unrelated change (filter, scroll growth, library edit) happens.
  - Fix: Expose enrichmentEpoch from useSteamGames and pass it from dashboard.tsx as `contentVersion` (do not add it to the fingerprint). In useDeferredFilterSort, when contentVersion changed but the fingerprint did not, and not in library view and not while searching: inside an effect, build Map id->game from currentGames and setOutput(prev => remap) where sortedGames/displayedGames become `byId.get(g.id) ?? g`; return prev unchanged if no element identity changed; leave dynamic option lists alone; bump versionRef so an older in-flight deferred compute cannot overwrite it. Also gate the epoch bump at useGameStore.ts:841 with a once-per-load ref (reset when loading becomes true) so each loadMore page does not trigger a remap. Fix the misleading comment at :510-512. Accepted limitation: no re-sort/re-filter on enriched fields.
  - Tests: Hook test: compute once, then pass a new currentGames with the same ids but playerCount set and a bumped contentVersion; assert sortedGames carries the counts in the same order. Assert no setOutput when objects are identical. Assert search mode is untouched.
  - Risk: Low-medium. Visible cards re-render once per epoch bump; ordering intentionally not refreshed.
  - Coordinate with hooks#7, hooks#20, ui-browse-details#1, ui-browse-details#2, ui-browse-details#17: All in the useDeferredFilterSort.ts run scheduling and empty-result handling (491-548). Sequence the done-flag and stale-input fixes first.

- **[medium · correctness] DetailEnricher.reset() during an in-flight batch leaves the old batch running, creating parallel batch chains and more Steam 429s** `renderer-stores#12`
  - Where: `src/services/detail-enricher.ts:204`, `src/services/detail-enricher.ts:304`, `src/services/detail-enricher.ts:340`
  - Problem: A category change or refresh while a details fetch is in flight lets a second batch start; when the old one returns it writes old-category results into the new session and can start its own cooldown chain. Each reset adds another concurrent chain, multiplying the request rate past the 6-per-3s throttle.
  - Fix: Add `private generation = 0`, bump it in reset() (and configure()). Capture `const gen = this.generation` before processing=true. After the await and at the top of the catch, `if (gen !== this.generation) return;` without touching inFlightIds, enrichedIds, attempts, onEnriched, timer or processing. In the cooldown path clearTimeout(this.timer) before assigning, and check the generation inside the callback before setting processing=false.
  - Tests: Fake getMultipleAppDetails with a deferred promise: start batch A, reset(), start batch B, resolve A: assert onEnriched not called for A's ids, only one timer active, and at most one fetch in flight. Same with A rejecting.
  - Risk: Low. Results from a superseded batch are discarded (they were for the previous category).

- **[low · correctness] useDeferredFilterSort marks a run done before its rAF work runs, so a cancelled run is never retried** `ui-browse-details#17`
  - Where: `src/hooks/useDeferredFilterSort.ts:548`, `src/hooks/useDeferredFilterSort.ts:535`, `src/hooks/useDeferredFilterSort.ts:540`
  - Problem: In development (StrictMode mounts effects twice) a Browse list or large library over 200 games can stay empty on first mount until some input changes. An interrupted view-switch transition can also leave the grid showing the previous view's list, because refs are written during render.
  - Fix: In the effect add `let done = false`, set `done = true` just before startTransition(setOutput), and change cleanup to `cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); if (!done && prevFingerprintRef.current === fingerprint) prevFingerprintRef.current = '';`. For the viewMode path, stop writing prevViewModeRef/prevFingerprintRef during render: track previous viewMode with useState (setState-during-render pattern) or move those writes into a useLayoutEffect keyed on viewMode.
  - Tests: Hook test under React.StrictMode with 1,000 games: after two rAFs sortedGames is populated. Test that the version guards still drop stale results.
  - Risk: Low; at worst one extra recompute. Ship together with the library-invalidation item, which edits the same hook.

- **[low · correctness] Library 'Sort by Release Date' does nothing when a status filter is active** `hooks#7`
  - Where: `src/hooks/useDeferredFilterSort.ts:397`, `src/hooks/useGameStore.ts:1446`
  - Problem: The release-date sort compares a hidden timestamp field that library game objects never have, so every comparison is 0 and both sort directions leave the list in insertion order.
  - Fix: In computeSort, before sorting, build tsMap once: for each g, pre = (g as any)._releaseTs; t = typeof pre === 'number' ? pre : releaseTsOf(g.releaseDate) (helper from the release-date item); tsMap.set(g.id, Number.isFinite(t) ? t : 0). The releaseDate case compares (tsMap.get(a.id) ?? 0) - (tsMap.get(b.id) ?? 0). Do not rely on setting _releaseTs in buildGameFromLocalEntry (custom games would still lack it).
  - Tests: Library view, status 'Completed', sort releaseDate asc/desc on a fixture with ISO, text ('Coming Soon') and missing dates; assert ordering and that the direction toggle reverses it.
  - Risk: Low.

- **[low · performance] Library search scores every game twice per committed query** `hooks#20`
  - Where: `src/hooks/useDeferredFilterSort.ts:140`, `src/hooks/useDeferredFilterSort.ts:243`
  - Problem: In library view with a search, the dynamic filter options pass re-scores all games to rebuild the same match set, doubling search cost on each commit and each library change, inside render for small libraries.
  - Fix: In the library branch, save the matched list right after line 151 (before the adult/status/store filters) as searchMatched (default currentGames when the query is empty). At :237-253 set baseGames = searchMatched instead of re-scoring. Do not reuse displayedGames.
  - Tests: Spy on scoreGame: one library search over N games calls it N times, not 2N; dynamic genres/platforms/years unchanged versus current output on a fixture.
  - Risk: Low.

- **[low · correctness] Enrichment map eviction (2,000) is out of sync with the enricher's done-set (5,000), so evicted cards stay bare** `ui-browse-details#19`
  - Where: `src/services/detail-enricher.ts:183`, `src/hooks/useGameStore.ts:1019`
  - Problem: After more than 2,000 catalog cards have been enriched, cards whose data was evicted lose developer, release date and platform icons when scrolled back into view, and are never enriched again until a category change or refresh.
  - Fix: Have enrichGames collect the keys it evicts and call a new detailEnricher.forget(ids), which deletes each id from enrichedIds and attempts (leave inFlightIds alone). Do not make observe() consult needsEnrichment(): that reopens the retry storm for permanently failed ids and adds a linear scan.
  - Tests: Unit test: enrich 2,001 ids, assert the evicted id is no longer in enrichedIds and observe() queues it again; a permanently failed id stays blocked.
  - Risk: Low. One extra throttled appdetails request per evicted card that scrolls back.
  - Coordinate with renderer-stores#12, renderer-stores#33, hooks#5: Detail-enricher done-set, reset and visibility changes interact with how useGameStore applies enrichment to the grid.

- **[low · performance] DetailEnricher keeps fetching details for cards that scrolled off long ago** `renderer-stores#33`
  - Where: `src/services/detail-enricher.ts:246`, `src/services/detail-enricher.ts:193`
  - Problem: Kept as a low wasted-work issue, not a leak (the queue is capped by loaded cards). After a fast scroll the enricher keeps requesting details for off-screen cards for minutes, adding Steam traffic and 429 risk.
  - Fix: Use a Set (or keep the array) and cap the queue at ~60 ids, dropping the oldest on push. In processBatch build `const live = new Set(this.elementToGameId.values())` once per batch and discard popped ids not in live, and re-check needsEnrichment(id) before fetching. Re-intersection re-queues cards that come back into view.
  - Tests: Push 200 ids: queue holds the latest 60. Unmounted card id is popped and skipped without a fetch.
  - Risk: Low; less background prefetch of off-screen cards.

### B22 useGameStore browse state and prefetch (13)
_useGameStore category state, prefetch-store and dashboard state restore._

- **[medium · correctness] Browse category switch race: a slow fetch from the previous category overwrites the newly selected category's grid** `hooks#2`
  - Where: `src/hooks/useGameStore.ts:626`, `src/hooks/useGameStore.ts:401`, `src/hooks/useGameStore.ts:304`, `src/hooks/useGameStore.ts:508`, `src/hooks/useGameStore.ts:566`
  - Problem: One useSteamGames instance serves every category, and the category effect sets isMountedRef back to true immediately, so it never blocks a stale fetch. Most Played, Catalog and the 'all' background refresh have no version check, and the generic path also accepts any stale result that is longer than the current list. Switching tabs quickly can leave Most Played, Catalog stubs or the 6K browse set showing under a different tab.
  - Fix: Take `const myVersion = ++fetchVersionRef.current` as the first line of fetchGames, before the catalog branch. Add `const isCurrent = () => isMountedRef.current && myVersion === fetchVersionRef.current && categoryRef.current === cat`. Guard with isCurrent(): the catalog branch after its await (before writing catalogAppListRef/catalogListReadyRef/setCatalogTotalCount and before fetchCatalogChunk), the most-played writes, and the bg-refresh closure after Promise.all and after dedupSortInWorker (still call setPrefetchedGames(fresh) so the cache refreshes). Change the shared tail to `!wouldDowngrade && (isLatest || (hasMore && categoryRef.current === cat))` so the Top Sellers 38->137 upgrade still works within the same category. Gate finally-block setLoading(false)/setIsSyncing on the version matching. Move the isMountedRef true/false into its own mount-only effect.
  - Tests: Hook tests with deferred promises: start Most Played, switch to New Releases, resolve New Releases first then Most Played; assert the grid shows New Releases. Same for catalog slow path and for the 'all' bg refresh resolving after a switch to Trending. Regression: Trending 38 result then 137 result within the same category upgrades to 137.
  - Risk: Medium. Touches the core fetch path; the Top Sellers upgrade and spinner states must be re-tested by hand.
  - Coordinate with hooks#3, hooks#11, hooks#12, hooks#13, ui-browse-details#9, ui-voyage#10: All touch useGameStore browse category state and the Dashboard remount/restore logic (dashboard.tsx:132-135).

- **[medium · correctness] Any Browse category switch zeroes catalogTotalCount, leaving Catalog (A-Z) disabled on 'Syncing' until the Dashboard remounts** `hooks#3`
  - Where: `src/hooks/useGameStore.ts:384`, `src/hooks/useGameStore.ts:679`, `src/hooks/useGameStore.ts:988`, `src/components/filter-sidebar.tsx:268`
  - Problem: Leaving the default category runs a reset that sets the catalog count to 0 and clears the catalog refs, and the only effect that sets the count again runs once per mount. After one tab change the Catalog option stays disabled with a spinner even though the list is already in memory.
  - Fix: Replace the reset at :379-384 with: if (_catalogMemCache?.length) { catalogAppListRef.current = _catalogMemCache; catalogListReadyRef.current = true; setCatalogTotalCount(_catalogMemCache.length); } else { setCatalogTotalCount(0); }. Keep catalogOffsetRef.current = 0. Extract the mount count-effect body (:679) into ensureCatalogCount() and call it on mount and after the manual refresh path (:988), which nulls _catalogMemCache and _catalogPreloaded.
  - Tests: Hook test: mount on trending, let the count effect resolve, switch to 'recent', assert catalogTotalCount is still > 0; then switch to 'catalog' and assert it uses the fast path (no loadCatalogAppList call). After refresh(), assert the count is reloaded.
  - Risk: Low. The fast catalog path already sorts in place via _catalogMemCacheSorted.

- **[medium · correctness] Splash stale-cache refresh overwrites the 7-day browse cache with an empty or partial result when offline or a source fails** `renderer-stores#8`
  - Where: `src/services/prefetch-store.ts:372`, `src/services/prefetch-store.ts:379`, `src/services/prefetch-store.ts:486`, `src/hooks/useGameStore.ts:461`, `src/workers/idb-cache.worker.ts`
  - Problem: When the browse cache is over an hour old, the splash refetches it and saves whatever comes back. If Epic times out or the network is down, the in-memory and saved browse set shrinks or becomes empty, so Epic games vanish from Browse and the next offline launch has no cache.
  - Fix: Add one commit helper in prefetch-store.ts used by _doPrefetch and setPrefetchedGames. Capture prev = prefetchedGames. If the new set is empty, keep memory and IDB unchanged and return prev ?? []. If prev.length >= MIN_HEALTHY_CACHE_SIZE and the new set is < 90% of prev, first re-add prev's entries for any source that came back empty (like the dashboard refresh's Epic fallback) and dedup again; if still < 90%, keep prev and skip the save (timestamp stays stale so the next launch retries). Do not apply the shrink guard when prev is below MIN_HEALTHY_CACHE_SIZE. Make the worker ignore a 'save' with games.length === 0.
  - Tests: Prefetch with prev of 5,000 and Epic source returning []: Epic entries kept and save posted with merged set. All sources []: no save posted, prefetchedGames unchanged. prev of 10 and new 500: replaced.
  - Risk: A real catalog shrink over 10% would be held back until the source recovers; acceptable.

- **[medium · correctness] Coming back from game details resets category, filters, sort and search but restores the old scroll offset** `ui-browse-details#9`
  - Where: `src/pages/dashboard.tsx:132`, `src/pages/dashboard.tsx:478`, `src/pages/dashboard.tsx:562`
  - Problem: Opening a game and pressing Back brings the user to Top Sellers with filters, sort and search cleared, but then scrolls that different list to the old position. A Catalog A-Z browse at letter S, a Browse search, or a Library status filter are all lost.
  - Fix: Save one snapshot under 'ark-dashboard-return-state' = { viewMode, filters, sortBy, sortDirection, committedQuery, catalogLetter } when navigating to /game (and on unmount). On mount, pass filters as initialFilters to useFilteredGames, use lazy useState initializers for sort and both query states, and call rawJumpToLetter(letter) once the catalog loads (not the smooth-scrolling wrapper). Store a fingerprint of that state next to each scroll offset and skip or clear pendingScrollRestoreRef when it does not match; also clear the pending restore on first user scroll or after a timeout.
  - Tests: Dashboard test: set Library status filter and sort, scroll, navigate to /game/x and back; assert filter, sort and scroll restored. Browse search 'zelda' round trip keeps the query. Mismatched fingerprint does not scroll.
  - Risk: The catalog letter restore needs the catalog list loaded first. The guided tour may assume Top Sellers on return.

- **[low · correctness] 6-hour catalog refresh swaps an unsorted list into active Catalog (A-Z) mode** `hooks#11`
  - Where: `src/hooks/useGameStore.ts:717`, `src/hooks/useGameStore.ts:745`
  - Problem: If the app sits on Catalog A-Z past the 6-hour refresh, the list is replaced by Steam's unsorted order while the scroll offset stays, so further scrolling appends unrelated titles and letter jumps land in the wrong place.
  - Fix: In checkAndRefresh, keep the forceRefresh load (mem cache + IDB), but if categoryRef.current === 'catalog' do not touch catalogAppListRef or catalogOffsetRef; only setCatalogTotalCount(appList.length). Leaving catalog clears the ref and the next entry re-sorts via the fast path (:326-330). Non-catalog categories keep the current swap.
  - Tests: Hook test with fake timers: enter catalog, load two pages, advance 6h with a stale cache returning an unsorted list; assert catalogAppListRef order and the next loadMore titles stay A-Z, and jumpToLetter('M') lands on an 'M' title.
  - Risk: Low; the catalog session uses the old list until the user leaves catalog.

- **[low · correctness] Browse background refresh result is thrown away on unmount but still marked done for an hour** `hooks#12`
  - Where: `src/hooks/useGameStore.ts:522`, `src/hooks/useGameStore.ts:527`, `src/hooks/useGameStore.ts:548`
  - Problem: Opening a game page while the background refresh is running discards the fresh data, yet the refresh is recorded as done, so the stale browse set stays for another hour, across restarts.
  - Fix: In the then-handler, remove the isMountedRef early returns at :522/:527. Run the 0.9x size check against Math.max(allGamesRef.current.length, getPrefetchedGames()?.length ?? 0), then always call setPrefetchedGames(fresh); wrap only setAllGames/setDisplayCount in if (isMountedRef.current). Track a local `stored` flag; in finally call markBackgroundRefreshDone() only if stored, else just reset _bgRefreshRunning.
  - Tests: Hook test: trigger bg refresh, unmount before dedup resolves, resolve; assert setPrefetchedGames called with fresh data and the timestamp written. If the size check rejects, assert the timestamp is not written.
  - Risk: Low.

- **[low · performance] Catalog count effect starts a second full 155k-item catalog load when the Dashboard remounts during the first** `hooks#13`
  - Where: `src/hooks/useGameStore.ts:681`, `src/hooks/useGameStore.ts:72`
  - Problem: loadCatalogAppList has no in-flight dedup, so going to a game page and back during the first load triggers a second IndexedDB deserialization or a second full Steam app-list download and cache write.
  - Fix: In loadCatalogAppList keep `_catalogLoadPromise` for the non-force memory-miss path (IDB read / API fetch, unsorted); concurrent callers await it, then apply `sorted` after the await (sort in place if needsSorted && !_catalogMemCacheSorted). forceRefresh uses its own `_catalogRefreshPromise`, never joins the non-force one, and on settle overwrites _catalogMemCache and sets _catalogMemCacheSorted = false. Clear each in finally. The reset path (~:988) nulls both and bumps a generation counter that loads check before assigning _catalogMemCache.
  - Tests: Unit: two concurrent loadCatalogAppList() calls cause one getCachedCatalog/getAppList call; a sorted caller joining an unsorted load gets sorted data; forceRefresh during a normal load does its own fetch; reset during a load prevents the stale result being cached.
  - Risk: Low-medium; must not hand a stale in-flight list to a forceRefresh caller.

- **[low · correctness] Library games without cachedMeta lose executablePath and steamAppId: no Play button, no player counts** `hooks#9`
  - Where: `src/hooks/useGameStore.ts:1477`, `src/hooks/useGameStore.ts:1488`, `src/hooks/useGameStore.ts:1512`
  - Problem: Only the cachedMeta branch of buildGameFromLocalEntry copies the exe path. Imported or legacy entries, or ones whose backfill failed, show no Play button even with an exe configured, and without steamAppId their player counts and Steam art fallback never load.
  - Fix: Add a helper entryDerivedFields(id, entry) returning executablePath: entry.executablePath; steamAppId: entry.steamAppId ?? (id.startsWith('steam-') ? parseInt(id.slice(6), 10) || undefined : undefined); epicNamespace/epicOfferId parsed only when id matches /^epic-([^:]+):(.+)$/. Spread it into the journey and 'Unknown Game' branches, and in the cachedMeta branch fall back to entry.steamAppId when meta.steamAppId is missing.
  - Tests: Unit tests on buildGameFromLocalEntry for each branch: entry with exe and no cachedMeta has executablePath; 'steam-123' yields steamAppId 123; 'epic-ns:offer' yields both epic fields; malformed epic id yields none.
  - Risk: Low.

- **[low · correctness] Library view never fetches player counts on mount and wipes them on every library change** `hooks#10`
  - Where: `src/hooks/useGameStore.ts:1551`, `src/hooks/useGameStore.ts:1587`, `src/hooks/useGameStore.ts:1670`
  - Problem: The 'new ids' tracker starts with every id, so nothing is fetched on mount, and each library edit rebuilds game objects without counts. In practice library cards never show live player counts.
  - Fix: Reuse the module-level sharedPlayerCounts/sharedPlayerCountFetchedAt maps (~line 168). When building validGames, merge sharedPlayerCounts.get(steamAppId) with playerCountSource 'steam'. In a separate effect keyed on the id set (and once on mount), collect steamAppIds missing or older than REFRESH_MS, skip when document.hidden, cap at ~100, fetch in batches of 20 via steamService.getMultiplePlayerCounts, always write results to the shared maps, and apply via setGames(prev => ...) guarded by a hook-level mountedRef (not the per-run isMounted). Depends on the steamAppId fix above for journey-branch entries.
  - Tests: Hook test: mount with 3 steam entries, assert one batched count fetch and counts on returned games; then a status edit keeps counts; a second mutation inside the fetch window does not drop results.
  - Risk: Low; adds a capped number of Steam calls on library view.

- **[low · performance] findGameById does two linear scans of the prefetched browse set per lookup** `renderer-stores#35`
  - Where: `src/services/prefetch-store.ts:402`, `src/services/prefetch-store.ts:415`, `src/services/prefetch-store.ts:418`, `src/services/similar-games.ts:453`
  - Problem: Kept as a low cleanup. A miss scans thousands of games twice; the Oracle hydrate's similar-titles step does a few thousand lookups, costing tens of ms per hydrate.
  - Fix: Build two Maps lazily inside findGameById, cached against the prefetchedGames array reference (rebuild when it changes, drop when null), writing a key only if absent so first-match semantics match find(). Keep the _navTransfer check first; return byId.get(id) ?? bySec.get(id) ?? null. Confirm nothing mutates prefetchedGames in place.
  - Tests: For a fixture with duplicate ids and secondaryIds, results equal the old find-based implementation for every id. Replacing the array invalidates the index.
  - Risk: Very low.

- **[low · correctness] Stale prefetch search index is used against a replaced game list of the same length** `ui-browse-details#29`
  - Where: `src/services/prefetch-store.ts:456`, `src/services/prefetch-store.ts:101`
  - Problem: For a short time after a background refresh, searches can return the wrong games, because the old index is matched by position against the new list when both have the same length.
  - Fix: Add `let indexGen = 0; let searchIndexSource: Game[] | null = null;`. In buildSearchIndex: `const gen = ++indexGen; searchIndex = null; _hmr.searchIndex = null;`; in processChunk return early if gen !== indexGen; on commit set searchIndex and searchIndexSource = games. In searchPrefetchedGames use the index only when `searchIndex && searchIndexSource === prefetchedGames`. clearBrowseCache bumps indexGen and clears searchIndexSource.
  - Tests: Unit test: build index for list A, replace with same-length list B and search before rebuild finishes; assert results come from B (fallback path). An older build finishing late does not commit.
  - Risk: Searches during the rebuild use the slower but correct fallback path.

- **[low · correctness] Voyage always reopens on the 3D Ark tab after returning from game details** `ui-voyage#10`
  - Where: `src/components/journey-view.tsx:397`, `src/components/dashboard.tsx:135`
  - Problem: The Voyage tab is plain component state, and opening a game unmounts the Dashboard. Pressing Back from a Log card lands on Ark, loses the Log/Scenes/Audit position, applies the Log's scroll offset to the wrong page and builds a WebGL scene the user did not ask for.
  - Fix: Lazy useState initializer reading sessionStorage 'ark-voyage-tab' in try/catch, validated against VIEW_PILLS ids, fallback 'ark'; write it in an effect on viewStyle (try/catch). Make the journey scroll-restore key tab-specific (getScrollStorageKey('journey') + ':' + viewStyle) so offsets land on the right tab.
  - Tests: Component test: set tab to 'log', remount, tab is 'log'; invalid stored value falls back to 'ark'.
  - Risk: Users see the last tab used in the session instead of Ark.

- **[medium · earlier review] Player-count sweep results dropped and next sweep blocked (v1.0.96 regression)**
  - Where: `src/hooks/useGameStore.ts:797`
  - Fix: Keep results of a superseded run (shared maps outlive it); let a blocked run re-queue.

### B23 Small hooks and Buzz fixes (7)
_Isolated hook-level fixes (overhead snapshot crash, online status, toast, buzz scroll and refresh)._

- **[high · correctness] useTrackerOverhead snapshot is a new array on every call, so the Telemetry tab crashes with 'Maximum update depth exceeded'** `renderer-stores#3`
  - Where: `src/services/tracker-overhead-store.ts:50`, `src/hooks/useTrackerOverhead.ts:29`
  - Problem: Once a running game has sent one telemetry sample, getAll() returns a fresh array each time. useSyncExternalStore sees a change on every check and re-renders until React throws, so OverheadPanel and FrictionPanel crash.
  - Fix: Add `private snapshot: readonly OverheadSample[] | null = EMPTY`. Set it to null in ingest() and clear(); getAll() rebuilds lazily only when null, freezes it, and returns the cached reference (EMPTY for size 0). Remove the `as OverheadSample[]` cast in useTrackerOverhead so callers get a readonly array.
  - Tests: Unit: getAll() returns the same reference across two calls with no ingest, and a new reference after ingest(). Render test: mount a component using useTrackerOverhead after one sample, assert no error and one render per sample.
  - Risk: Very low. Any consumer that mutated the returned array would now throw on the frozen array; none found.

- **[low · correctness] useOnlineStatus ignores online/offline events in dev (StrictMode) because mountedRef is never reset** `hooks#21`
  - Where: `src/hooks/useOnlineStatus.ts:100`, `src/hooks/useOnlineStatus.ts:37`, `src/hooks/useOnlineStatus.ts:47`
  - Problem: StrictMode's mount-cleanup-mount leaves the ref false, so in dev builds the offline banner and 'Back online' sync never fire.
  - Fix: Remove mountedRef; declare `let active = true` at the top of the effect, check `if (!active) return;` in handleOnline/handleOffline, set `active = false` in cleanup.
  - Tests: Render the hook inside React.StrictMode; dispatch window 'offline' then 'online'; assert isOnline toggles.
  - Risk: None.

- **[low · correctness] Connectivity probe uses only gstatic.com, so networks that block Google show 'offline' all session** `hooks#22`
  - Where: `src/hooks/useOnlineStatus.ts:74`, `electron/main.ts:1033`
  - Problem: On corporate filters or regions blocking gstatic.com, the probe always fails and the offline banner stays up while Steam and Epic work; flapping slow links repeat the 'Back online' toast.
  - Fix: In probeNetwork, when the gstatic HEAD fails, try one fallback no-cors HEAD to https://store.steampowered.com/favicon.ico with the same timeout; count a failure only if both fail. Add the host to ALLOWED_PROBE_HOSTS in electron/main.ts:1033. Require 2 consecutive successes before handleOnline() after an offline flip.
  - Tests: Mock fetch: gstatic rejects, Steam resolves -> stays online. Both reject twice -> offline. One success after offline -> still offline; two -> online.
  - Risk: Low.

- **[low · performance] Network probe keeps running every 30 s while the window is hidden in the tray** `hooks#23`
  - Where: `src/hooks/useOnlineStatus.ts:95`
  - Problem: Closing the window hides it to the tray with the Dashboard still mounted, so the connectivity ping keeps firing (about 1,400+ requests a day) to update a banner nobody sees.
  - Fix: Add `if (document.hidden) return;` at the top of probeNetwork. Add a visibilitychange listener that calls probeNetwork() when the document becomes visible, removed in the existing cleanup. Do not reset failCount on hide; no backoff needed.
  - Tests: With document.hidden = true, advancing 30 s makes no fetch; dispatching visibilitychange to visible triggers one probe.
  - Risk: None; window online/offline events still track physical disconnects while hidden.

- **[low · performance] Toast context value is rebuilt on every toast, re-rendering every useToast consumer** `hooks#28`
  - Where: `src/components/ui/toast.tsx:116`, `src/hooks/useAutoOnHold.ts:225`, `src/hooks/useSessionTracker.ts:363`, `src/hooks/session-tracker-context.tsx:21`
  - Problem: The toast context holds the toast list together with the action functions in a new object each render, so Dashboard, game details, the release calendar and SessionTrackerProvider re-render on every toast show and dismiss although none of them read the list.
  - Fix: In ToastProvider, put only `useMemo(() => ({ addToast, removeToast, success, error, info, warning }), [...])` in ToastContext (all are stable useCallbacks); ToastContainer keeps receiving toasts as a prop. Remove `toasts` from ToastContextType and update src/test/components/ui/toast.test.tsx (only reader) to assert via rendered toasts. Optionally memoise `{ liveGames, isPlayingNow }` in useSessionTracker.
  - Tests: Render a consumer counting renders; call addToast and let it auto-dismiss; assert the consumer does not re-render. Existing toast UI test still shows and removes toasts.
  - Risk: Low; check no other consumer reads `.toasts`.

- **[low · correctness] useDraggableScroll and the Broadcasts strip scroll effects bind only once, so the strip never gets drag or arrow state** `hooks#18`
  - Where: `src/hooks/useDraggableScroll.ts:37`, `src/components/buzz-view.tsx:797`, `src/components/buzz-view.tsx:805`, `src/components/buzz-view.tsx:885`
  - Problem: The Broadcasts strip mounts collapsed (events load later), so the drag hook and the scroll/resize effect run while the element does not exist and never run again. Drag panning never works and the 'next' arrow stays disabled; after collapse/re-expand the handlers stay on the detached old element.
  - Fix: Move the expanded body of BroadcastsStrip (arrows, scroll div, card map) into a child component BroadcastsScroller rendered as {expanded && <BroadcastsScroller .../>}, owning scrollRef, useDraggableScroll, checkScroll, the scroll/ResizeObserver effect and canScroll state. Also re-run checkScroll when sorted.length changes. No hook API change; oracle-view call sites untouched.
  - Tests: Component test: render with no events, then add events so it expands; assert pointerdown/move scrolls the strip and the next arrow is enabled when content overflows. Collapse and re-expand; assert handlers work on the new element.
  - Risk: Low.

- **[low · performance] Transmissions auto-refresh bypasses the news cache and runs while hidden, and each refresh does an expensive library-title scan** `ui-other#20`
  - Where: `src/components/buzz-view.tsx:1046`, `src/components/buzz-view.tsx:33`, `src/services/news-service.ts:308`, `src/services/news-service.ts:353-373`
  - Problem: Every 5 minutes the news view clears its cache and refetches all feeds, even when the window is minimised or in the tray, so the 10-minute cache never applies. Each refresh then lowercases every library title for every news item, which can cause a short stall with a large library.
  - Fix: buzz-view.tsx: in the interval return early when document.hidden; call loadNews(false) so the TTL applies; add a visibilitychange listener calling loadNews(false) when visible, removed on cleanup. Keep clearNewsCache()/loadNews(true) only in handleRefresh. news-service.ts: build needles = libraryTitles.filter(t => t.length > 2).map(t => t.toLowerCase()) once (reuse the dedupe lowercase); if empty set isFromYourFleet=false and skip; else needles.some(n => text.includes(n)). Keep substring semantics.
  - Tests: Fake timers + document.hidden true: no fetch on tick. Visible tick within TTL: no network. Manual refresh forces fetch. Fleet tagging results identical to before on a fixture.
  - Risk: Low. News may be up to 10 minutes stale on the timed path.

### B24 Dashboard UI (7)
_Changes in dashboard.tsx only, made after B21 and B22._

- **[high · correctness] Card Play action reads the raw browse object, which has no executablePath** `ui-browse-details#0`
  - Where: `src/pages/dashboard.tsx:807`, `src/pages/dashboard.tsx:760`
  - Problem: Pressing Play on a library game's card (right-click or the ... menu) shows 'No executable set for this game' even though an exe is set. The handler looks the game up in the raw browse list first, and that copy never has the library data merged in. In Browse view this happens to every library card. In Library view it happens whenever the game is also in the loaded browse category.
  - Fix: In handleCardPlay, read the path from the stores, the same way handleCardEdit does: `const exePath = libraryStore.getEntry(gameId)?.executablePath ?? (gameId.startsWith('custom-') ? customGameStore.getGame(gameId)?.executablePath : undefined) ?? resolveGame(gameId)?.executablePath;`. Optionally make resolveGame check currentGamesRef before allGamesRef, so status change and delete also act on the merged object the card shows.
  - Tests: Dashboard test: a library game with executablePath that also appears in the browse list. Trigger card Play in Browse and in Library view and assert window.gameLauncher.launch is called with the stored path and the 'No executable' toast is not shown. Also test a custom game.
  - Risk: Low. The store is already the source of truth for the details page and for handleCardEdit.

- **[medium · performance] Typing in the Library search box fires Steam and Epic store searches whose results are thrown away** `ui-browse-details#6`
  - Where: `src/pages/dashboard.tsx:202`, `src/pages/dashboard.tsx:204`
  - Problem: In Library view the search is done locally, but every typed term still sends Steam and Epic store searches (plus up to 20 app-detail lookups), twice. This adds network traffic and rate-limit pressure for results nothing displays.
  - Fix: `const isBrowse = viewMode === 'browse'; useGameSearch(isBrowse ? typingQuery : ''); useGameSearch(isBrowse ? committedQuery : ''); const isSearching = committedQuery.trim().length > 0;` and keep passing that isSearching to useDeferredFilterSort and the empty-state/toolbar checks so library 'no-results' still works.
  - Tests: Dashboard test with a mocked gameService.searchGames: in Library view, type a query and advance timers; assert searchGames is not called and the library filters locally. Switch to Browse with the query in the box and assert one search fires.
  - Risk: Low. Switching from Library to Browse with a query shows results about 300 ms after the switch.

- **[low · performance] Grouped library view mounts every library card with no virtualization** `ui-browse-details#13`
  - Where: `src/pages/dashboard.tsx:1623`, `src/pages/dashboard.tsx:837`
  - Problem: With the default 'All' status filter, the Library view renders every library card at once in its status sections. Large libraries (hundreds to thousands of games) cause a long freeze when opening Library and slow re-renders after each change.
  - Fix: Flatten libraryGroups into one row model: a header row per non-empty section, then ceil(n / libColumns) card rows for each expanded section, rebuilt when libraryGroups, collapsedSections or libColumns change. Render it with a single useWindowVirtualizer using measureElement. Do not nest a VirtualGameGrid per section. Remove the motion height:auto collapse animation in the virtualized path. Lower-risk interim: cap each expanded section at ~48 cards behind 'Show all N', or add content-visibility:auto with contain-intrinsic-size on card wrappers.
  - Tests: Dashboard test with 2,000 library entries: assert the number of mounted GameCards is bounded; collapse/expand a section updates rows; scroll restore and the library tour anchors (data-tour) still work.
  - Risk: Scroll restore and tour anchors rely on cards being in the DOM; retest both.

- **[low · correctness] Release Year filter is left out of the header filter badge and count** `ui-browse-details#22`
  - Where: `src/pages/dashboard.tsx:952`, `src/pages/dashboard.tsx:962`, `src/components/filter-sidebar.tsx:108`
  - Problem: With only a Release Year filter set, the header shows no filter badge or clear button, an empty result shows the wrong empty state, and the header count differs from the sidebar count.
  - Fix: Add `filters.releaseYear !== 'All'` to hasActiveFilters and activeFilterCount and add filters.releaseYear to both deps. Better: export a shared countActiveFilters(filters, viewMode) used by FilterTrigger, the sidebar and the dashboard, keeping viewMode gating; hasActiveFilters also keeps checking committedQuery.
  - Tests: Dashboard test: only Year=2019 set shows the badge with count 1 matching FilterTrigger; empty result shows 'no-filter-results'.
  - Risk: None.

- **[low · correctness] Empty Browse result shows 'No Games in Library' with a Browse Games button that does nothing** `ui-browse-details#23`
  - Where: `src/pages/dashboard.tsx:1574`, `src/components/empty-state.tsx:155`
  - Problem: When a Browse category returns no games without an error, the page shows library-empty copy and a button that does nothing.
  - Fix: Add a 'no-browse-results' EmptyStateType using IconEmptyState with copy like 'Nothing to show here' and a 'Retry' action wired to the browse refetch for the current category (or switching to the default category). If neither is available pass no onAction. Never pass () => {}.
  - Tests: Dashboard test: Browse with zero games and no error renders 'no-browse-results'; Retry calls the refetch.
  - Risk: None.

- **[low · correctness] Library view shows the Browse fetch error banner and hides the library empty state** `ui-browse-details#24`
  - Where: `src/pages/dashboard.tsx:313`, `src/pages/dashboard.tsx:1478`, `src/pages/dashboard.tsx:1545`
  - Problem: If a Browse category fetch failed, the Library view (which is fully local) still shows the red error and a Retry button that reloads the whole app. An empty library then shows only that error, not the empty-library prompt.
  - Fix: `const currentError = viewMode === 'browse' ? steamError : null;`. Optionally replace window.location.reload() in Retry with a refetch from useSteamGames.
  - Tests: Dashboard test: steamError set, Library view shows no error banner; empty library shows the empty state.
  - Risk: None.

- **[low · performance] Opening the filter or AI chat panel animates the main area's padding, re-laying out the grid every frame** `ui-browse-details#32`
  - Where: `src/pages/dashboard.tsx:1034`
  - Problem: Opening or closing the side panel animates the grid width for 300 ms, so every card resizes and the grid re-measures on each frame, causing visible jank, worst in the non-virtualized grouped library.
  - Fix: Remove `transition-all duration-300` from <main> (or use `transition-colors` if needed) so the padding snaps while the panel keeps its own slide animation. Optionally apply lg:pr-[424px] after the panel's open animation completes and remove it immediately on close.
  - Tests: Snapshot/class test that <main> no longer has transition-all; manual check that the panel still slides.
  - Risk: Visual only: the grid snaps to its new width.

### B25 Game details page (14)
_game-details.tsx, similar-games and the library-store update semantics for the add/progress dialogs._

- **[high · correctness] Every 'Add to Library' from the dialog wipes addedAt, so that save and later status changes throw RangeError** `ui-browse-details#3`
  - Where: `src/pages/dashboard.tsx:729`, `src/pages/game-details.tsx:935`, `src/services/library-store.ts:603`, `src/services/library-store.ts:635`
  - Problem: Adding a game through the dialog shows 'Failed to save. Please try again.' on the Dashboard (the game is in fact added) and fails silently on the details page. The follow-up update sends addedAt: undefined, which overwrites the stored date, and the store then crashes building a date from it. For the rest of the session, every status change, edit or session-driven update on that game throws the same error.
  - Fix: In library-store.updateEntry, after the spread: `updated.addedAt = input.addedAt !== undefined ? LibraryStore.toValidDate(input.addedAt, existing.addedAt) : existing.addedAt;`. Make line 635 tolerant: `LibraryStore.toValidDate(updated.addedAt, new Date()).toISOString()`. Do not strip all undefined keys, because clearing executablePath with the X button relies on spreading undefined; protect app-managed fields (addedAt, createdAt, statusChangedAt) individually. Apply the same guard in custom-game-store.updateGame. In the dashboard and game-details add paths, stop sending addedAt on the follow-up updateEntry unless it is defined.
  - Tests: library-store unit test: addToLibrary, then updateEntry(id, { status, addedAt: undefined }) keeps the original addedAt and does not throw; a second updateEntry also works. updateEntry(id, { executablePath: undefined }) still clears the path. Dashboard test: add via dialog shows the success toast. Same for customGameStore.updateGame.
  - Risk: Low. Entries already damaged this session get a fallback date on next update. Oracle reads addedAt from journey snapshots, but this only restores correct data; engine logic is unchanged.
  - Coordinate with ui-other#6: Both touch library-store.ts:603-613 update semantics (addedAt preservation and merge vs overwrite of live fields).

- **[medium · correctness] My Progress save overwrites live playtime and auto status with the values captured when the dialog opened** `ui-other#6`
  - Where: `src/components/my-progress-tab.tsx:324`, `src/services/library-store.ts:603-613`, `src/pages/game-details.tsx`, `src/components/edit-progress-dialog.tsx`, `src/components/custom-game-progress-dialog.tsx`
  - Problem: The My Progress editor reads the game once and sends every field back on Save. If a play session raised the hours or auto-moved the status to Playing while the dialog was open, a notes-only save writes the old hours and status back, losing tracked playtime and resetting the hours baseline. The hours slider also caps at 500.
  - Fix: In handleSave, build the update from dirty fields only by comparing each field to `data`; include hoursPlayed only if the user moved the slider (updateEntry resets hoursBaseline whenever hoursPlayed is present), status only if changed, addedAt only if getTime() differs. Also subscribe to libraryStore.subscribe, its hours channel and customGameStore.subscribe, and on change refresh `data` and any field the user has not edited (hours listener updates only the hours state and data.hoursPlayed). Slider max = Math.max(500, Math.ceil(hoursPlayed)).
  - Tests: Open tab with hoursPlayed 12, simulate updateHoursFromSessions to 13.5 and status auto-transition, edit notes, save; assert updateEntry payload has only notes and the store keeps 13.5 and 'Playing'. Editing hours sends hoursPlayed. Game with 600 h shows slider max >= 600.
  - Risk: Low-medium. Dirty-diffing must still send an explicit clear (for example removing an exe path) when the user clears a field.

- **[medium · correctness] Add / Edit Library Entry does nothing on dual-store pages opened by an epic- id** `ui-browse-details#4`
  - Where: `src/pages/game-details.tsx:834`, `src/pages/game-details.tsx:1092`, `src/pages/game-details.tsx:1133`, `src/pages/dashboard.tsx:874`
  - Problem: On a details page opened with an epic- id for a game that also exists on Steam, the Add to Library and Edit Library Entry buttons do nothing, with no message. The page shows Steam data but never sets its Epic game object and has no Steam app id, so building the dialog game returns null. Library entries keyed by epic- ids can therefore not be edited from their page.
  - Fix: In createGameFromDetails, after the custom-game block: if `isEpicGame && crossStoreGame?.store === 'epic' && details`, return `{ ...crossStoreGame, id: gameId, store: 'epic', steamAppId: details.steam_appid || crossStoreGame.steamAppId, price: crossStoreGame.price, isInLibrary: gameInLibrary }`, and add crossStoreGame and gameId to the deps. The id must be the URL id so the library key matches gameInLibrary and handleSaveLibraryEntry. Do not call setEpicGame in the dual-store branch (it flips the page into Epic-primary pricing). Because this creates epic- keyed entries that carry a steamAppId, also unify the 'Playing Now' check (split-vote finding, unreachable today): add a helper `isGameLive(game, liveGames) = liveGames.has(game.id) || (game.steamAppId != null && liveGames.has('steam-' + game.steamAppId))` and use it at dashboard.tsx lines 402, 409, 844 and 874.
  - Tests: Details page test: route /game/epic-ns:offer where findGameById returns a Steam-primary merged game with secondaryId; click Add, assert the dialog opens and the saved entry is keyed epic-ns:offer. With an existing epic- entry, Edit opens prefilled. Dashboard test: an epic- entry with steamAppId that is live shows the Playing Now badge and sits in the Playing Now section.
  - Risk: Make sure adding under the epic- id does not duplicate an existing steam- entry for the same game; check libraryStore.isInLibrary for the steam- id first and edit that entry if present.

- **[medium · correctness] Custom games' details page hides Play and shows 'Add to Library' because the in-library check ignores custom games** `ui-browse-details#8`
  - Where: `src/pages/game-details.tsx:3285`, `src/pages/game-details.tsx:761`, `src/pages/game-details.tsx:2121`, `src/pages/game-details.tsx:2178`, `src/pages/game-details.tsx:2314`
  - Problem: A custom game with an exe set can never be launched from its page, the main button reads 'Add to Library' for a game that is already in the library, and Remove is never offered. The page only checks the regular library store, which never holds custom games.
  - Fix: In the parent: `const inLibraryForUi = gameInLibrary || (isCustomGame && !!(gameId && customGameStore.getGame(gameId)));` and pass it as gameInLibrary to both GameDetailsContent call sites; leave the parent's own gameInLibrary (wasInLibraryOnLoad, isNewAdd) unchanged. Replace the removeFromLibrary prop with an onRemove handler: custom ids call removeCustomGame(gameId) and navigate back, others call removeFromLibrary. Also compute launchExecutablePath in GameDetailsPage and pass it as a string prop instead of reading the stores inside the memoized child (split-vote finding: today it only stays fresh because the toast context value is unstable).
  - Tests: Details test for a custom-N id with executablePath: Play button visible and launches the path; main button shows edit state; Remove (after confirm) calls customGameStore.removeGame and navigates. Test that a deleted custom id does not show Play. Test that setting an exe via Edit shows Play without remount.
  - Risk: Remove for custom games must not call libraryStore.removeFromLibrary, which is a no-op for custom ids.

- **[medium · correctness] Details-page 'Remove from Library' deletes the entry immediately, with no confirmation** `ui-browse-details#7`
  - Where: `src/pages/game-details.tsx:3312`
  - Problem: One click on 'Remove from Library', which sits right under 'Edit Library Entry', permanently deletes the entry with its hours, rating, notes, exe path and priority. Every other remove path in the app asks first.
  - Fix: Add a `removeConfirmOpen` state and render `<ConfirmDialog variant="danger">` with the Dashboard's wording; call removeFromLibrary(gameId) only from onConfirm and then toastSuccess as the Dashboard does. Apply the same confirm to the custom-game remove added by the custom-games item.
  - Tests: Details test: click Remove, assert the dialog shows and the entry still exists; cancel keeps it; confirm removes it and shows the toast.
  - Risk: None functionally; one extra click.

- **[medium · performance] Details page sends ~30-100 Steam appdetails requests for about 128 similar-game neighbours, then shows 8** `ui-browse-details#10`
  - Where: `src/services/similar-games.ts:547`, `src/services/similar-games.ts:240`, `src/pages/game-details.tsx:1427`
  - Problem: Each uncached details page queues dozens of rate-limited Steam requests and Epic lookups for neighbours it will mostly discard. The queue keeps running after the user leaves, delays other Steam calls, and makes 429 rate limits (and the false 'Game not found' redirect) more likely.
  - Fix: In enrichNeighborRows / getSimilarGamesForDetails: (1) apply SIMILAR_TITLES_DISTANCE_CEILING (0.45) to the folded neighbours; (2) resolve titles locally first (resolveNeighborMeta, then one batched window.steam.getCachedGameNames for placeholder titles); (3) run dedupeSimilarNeighbors on those local cards and send only the top ~2k (16) to getMultipleAppDetails and Epic getGameDetails; (4) re-dedupe after enrichment and enrich the next slice only if fewer than k remain; (5) cache the result per sourceGameId in a small session LRU (about 50). The cap on ids sent matters most; a renderer AbortSignal would not drain the main-process queue.
  - Tests: Unit test with 128 mocked ANN rows: assert getMultipleAppDetails receives at most 16 ids and 8 cards come back; same-title twins with 'App N' placeholders are still deduped; a second call for the same source uses the cache.
  - Risk: The strip may differ slightly from today (distance ceiling, earlier dedupe). This function is only used by the details page, not by Oracle.

- **[low · correctness] Short descriptions with images are cut at 10rem with no Read More button** `ui-browse-details#14`
  - Where: `src/pages/game-details.tsx:2608`, `src/pages/game-details.tsx:2605`, `src/pages/game-details.tsx:408`
  - Problem: A description under 500 characters that contains images (or a few short paragraphs) renders much taller than the collapsed box, gets cut off, and offers no way to expand it. The toggle is decided by raw string length, not rendered height.
  - Fix: Put a ref on the description div and keep `isOverflowing` state. In a useLayoutEffect plus a ResizeObserver, and a capture-phase 'load' listener on the container (lazy images are 0px until loaded), set `isOverflowing = el.scrollHeight > el.clientHeight + 1`, measuring only while collapsed. Show the fade and button when `isOverflowing || showFullDescription`. Use the memoized description HTML from the sanitize item.
  - Tests: Component test mocking scrollHeight > clientHeight with a 300-char description: Read More shows and expands; a short text-only description does not show it.
  - Risk: Low. Extra layout reads once per description and on image load.

- **[low · performance] Details 'About' and requirements HTML are sanitized and regex-rewritten on every render** `ui-browse-details#15`
  - Where: `src/pages/game-details.tsx:2601`, `src/pages/game-details.tsx:2633`, `src/pages/game-details.tsx:2646`
  - Problem: Every 5 s media autoplay tick and every loading change re-runs several regex passes and a full DOMPurify parse on descriptions that can be tens of KB, costing a few to tens of ms of main-thread time each time.
  - Fix: At the top level of GameDetailsContent, next to the existing memos and above any early return: `const descSource = details.detailed_description || details.about_the_game || ''; const descriptionHtml = useMemo(() => descSource ? DOMPurify.sanitize(embedDescriptionImages(normalizeDescriptionMediaUrls(descSource))) : '', [descSource]);` and the same for minimum and recommended pc_requirements. Use them in dangerouslySetInnerHTML.
  - Tests: Spy on DOMPurify.sanitize: render, then advance currentMediaIndex several times; assert sanitize was called once per source.
  - Risk: None functionally.

- **[low · correctness] Epic-primary fallback shows Epic's price on a 'Steam' button and adds a second Steam button** `ui-browse-details#20`
  - Where: `src/pages/game-details.tsx:3140`, `src/pages/game-details.tsx:213`, `src/pages/game-details.tsx:227`
  - Problem: When a Steam+Epic game opened by its Epic id falls back to the Epic-only view (Steam rate limited or offline), the page shows a 'Steam' button with Epic's price and discount next to an identical Epic button, plus a separate Steam store button.
  - Fix: Change only the price block: `const steamUrl = !isEpicPrimary && details.steam_appid ? ... : null; const steamPrice = isEpicPrimary ? null : (...); const steamDiscount = isEpicPrimary ? 0 : ...;`. Let crossSteamUrl render the single 'Steam - View Store' button. Leave epicToSteamDetails unchanged so steam_appid keeps feeding gg.deals and reviews.
  - Tests: Details test for the Epic-primary fallback: one Steam button with no price, Epic button shows epicGame.price, no 'both' comparison.
  - Risk: Low; check crossSteamUrl layout next to the Epic button.

- **[low · correctness] Epic store and add-on links use the namespace as a product slug and open a 404** `ui-browse-details#21`
  - Where: `src/pages/game-details.tsx:3151`, `src/pages/game-details.tsx:3059`, `src/components/game-detail-panel.tsx:178`
  - Problem: For Epic items that have no product slug, the Epic button and add-on links open a broken Epic store page, because the code puts the catalog namespace where the slug should go.
  - Fix: Add a helper `epicStoreUrl(slug, title)`: return /p/<slug> when a real slug exists, else `https://store.epicgames.com/en-US/browse?q=${encodeURIComponent(title)}`; never use epicNamespace. Use it at lines 3059 and 3151 and game-detail-panel.tsx:178. Prefer epicGame?.epicSlug, then crossStoreGame.epicSlug, and merge liveEpicDetails.epicSlug into crossStoreGame in the setCrossStoreGame updates (around 1317-1324 and 1344-1348). For add-ons use addon.slug, then the parent slug, then search.
  - Tests: Unit test epicStoreUrl with slug, without slug, and with a hex namespace only. Details test: cross-store game with namespace but no slug links to the search URL.
  - Risk: Low; some links become a search page instead of a product page.

- **[low · correctness] Steam language badges show the audio footnote merged into the last language** `ui-browse-details#26`
  - Where: `src/pages/game-details.tsx:3437`
  - Problem: Language badges show asterisks, and the last badge reads 'German*languages with full audio support' for most popular Steam games.
  - Fix: Add a pure helper parseSteamLanguages(html): cut at the first /<br\s*\/?>/i, split on ',', for each piece set fullAudio = /\*/.test(piece), strip tags and '*', trim, drop empties, de-duplicate by name. Render names as badges, optionally with an audio icon for fullAudio.
  - Tests: Unit test with the real Steam format string 'English<strong>*</strong>, French<strong>*</strong>, German<strong>*</strong><br><strong>*</strong>languages with full audio support' and a plain 'English, French' string.
  - Risk: None.

- **[low · performance] Epic-only details pages request product content twice when the first response has no Windows requirements** `ui-browse-details#30`
  - Where: `src/pages/game-details.tsx:1562`, `src/pages/game-details.tsx:1164`, `src/pages/game-details.tsx:1213`, `electron/epic-api.ts:1131`
  - Problem: Epic pages with missing specs fetch the same product content again. When the first call failed (slug not in the CMS), the second is a full repeated HTTP request on every visit.
  - Fix: Add lastProductContentSlugRef, set it to the requested slug at both main-fetch call sites (1164, 1213) whatever the result, clear it on gameId change, and return early from the requirements effect when epicGame.epicSlug === ref.current. Keep the effect for the Steam-null fallback (1315). Optionally add a 10-30 min negative cache for 404s only in EpicAPI.getProductContent.
  - Tests: Details test: Epic-only page whose product content has no requirements calls getProductContent once. Steam-null fallback still calls it.
  - Risk: Low.

- **[low · performance] Media autoplay re-renders the whole details page every 5 s while the Details tab is not shown** `ui-browse-details#34`
  - Where: `src/pages/game-details.tsx:1661`, `src/pages/game-details.tsx:2066`
  - Problem: For library games the page opens on My Progress, where no media is visible, but autoplay keeps advancing every 5 s and re-renders the large page component and the progress tab.
  - Fix: Make the Tabs controlled (`const [activeTab, setActiveTab] = useState(defaultTab)` with value/onValueChange) and add `|| (showProgressTabs && activeTab !== 'details')` to the autoplay effect's early return, with activeTab in deps. Optionally also pause when document.hidden.
  - Tests: Details test with fake timers on a library game: on My Progress, advancing 15 s does not change currentMediaIndex; switching to Details resumes autoplay.
  - Risk: None; autoplay resumes on the Details tab.

- **[low · correctness] Similar-games auto-scroll never runs for library games and keeps driving a detached strip after a tab switch** `ui-other#22`
  - Where: `src/pages/game-details.tsx:1689-1715`, `src/pages/game-details.tsx:3530`, `src/pages/game-details.tsx:3543`, `src/pages/game-details.tsx:3554`, `src/pages/game-details.tsx:2237`
  - Problem: For games in the library the page opens on My Progress, so the similar-games strip is not mounted when data arrives and auto-scroll never starts. If the user was on Game Details and switches tabs, the timer keeps scrolling the old detached strip and holds it in memory, and the new strip after switching back does not scroll.
  - Fix: Add const [recsEl, setRecsEl] = useState<HTMLDivElement|null>(null) and a stable callback ref setRecsRef = useCallback(el => { similarGamesScrollRef.current = el; setRecsEl(el); }, []) so chevron buttons keep working. Effect deps [recsEl, similarGames.length, isRecommendationsPaused], local interval id, cleanup clearInterval. Remove similarGamesAutoScrollRef. Update the prop type at 2237.
  - Tests: Open a library game on My Progress, switch to Game Details: interval starts. Switch away: interval cleared. Chevrons still scroll.
  - Risk: Very low.

### B26 Cards and search suggestions (4)
_game-card.tsx and search-suggestions.tsx._

- **[medium · correctness] GameCard and search thumbnails keep their image-failure state when the URLs change, so enriched art never shows** `ui-browse-details#5`
  - Where: `src/components/game-card.tsx:294`, `src/components/game-card.tsx:174`, `src/components/search-suggestions.tsx:26`, `src/components/search-suggestions.tsx:94`
  - Problem: When a card's old CDN images fail and the enricher later supplies a working image URL, the card keeps showing the initials placeholder, or points at the wrong image in the new list. The fallback counters are only reset when the card remounts. The search dropdown thumbnails have the same flaw, resetting only on game id.
  - Fix: Reset during render using the derived-state pattern: `const urlKey = fallbackUrls.join('|'); const [prevKey, setPrevKey] = useState(urlKey); if (prevKey !== urlKey) { setPrevKey(urlKey); ... }`. If the URL currently on screen is still in the new list, set fallbackAttempt to its new index; otherwise set fallbackAttempt 0, imageError false, imageLoaded false. Apply the same in SearchResultImage (replace the [game.id] dependency with the joined URL key). Optionally drop loading="lazy" on the 32px search thumbnails so the 4 s timeout always matches a started request.
  - Tests: GameCard test: render with URLs that all error, assert placeholder; rerender with a new headerImage, assert an <img> with the new URL is shown. Rerender with a list that still contains the working URL and assert no reset. Same for SearchResultImage.
  - Risk: A card already showing a working fallback may reload once when a better URL arrives first in the list. Intended.

- **[low · correctness] Right-click card menu is not kept inside the window and Escape does not close it** `ui-browse-details#25`
  - Where: `src/components/game-card.tsx:689`, `src/components/game-card.tsx:213`, `src/components/game-card.tsx:227`
  - Problem: Right-clicking a card near the bottom or right edge puts part of the menu off-screen, usually hiding 'Remove from Library'. Scrolling closes the menu and Escape does nothing.
  - Fix: In a useLayoutEffect keyed on ctxMenu, read ctxMenuRef.current offsetWidth/offsetHeight (the zoom-in animation shrinks getBoundingClientRect) and set left = min(x, innerWidth - w - 8), top = y + h > innerHeight - 8 ? max(8, y - h) : y, via direct style writes or a separate state so it does not loop. Add a keydown listener for Escape in the existing close effect with matching cleanup.
  - Tests: Component test: right-click at (innerWidth-10, innerHeight-10) positions the menu fully inside; Escape closes it.
  - Risk: None.

- **[low · correctness] Clicking inside the search input closes the suggestions dropdown** `ui-browse-details#27`
  - Where: `src/components/search-suggestions.tsx:179`, `src/pages/dashboard.tsx:1227`
  - Problem: Clicking in the already-focused search box (to move the cursor or select text) hides the suggestions, and they only come back after the next keystroke.
  - Fix: Add an optional `anchorRef?: RefObject<HTMLElement>` prop to SearchSuggestions, pass a ref to the data-tour="search-input" wrapper from Dashboard, and skip onClose when anchorRef.current?.contains(target). Optionally wrap Dashboard's onClose in useCallback so listeners are not re-added every render.
  - Tests: Component test: mousedown on the input keeps the dropdown open; mousedown elsewhere closes it.
  - Risk: None.

- **[low · performance] Each GameCard render creates a new date formatter** `ui-browse-details#31`
  - Where: `src/components/game-card.tsx:116`, `src/pages/game-details.tsx:576`, `src/pages/game-details.tsx:3029`
  - Problem: Formatting each card's release date builds a new formatter (about 100 microseconds), adding roughly 50 ms per 500-card mount.
  - Fix: Module scope: `const DISPLAY_DATE_FMT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })`; return DISPLAY_DATE_FMT.format(date) inside the existing isNaN guard and try/catch. Optionally export from src/lib/utils for the game-details call sites if their options match.
  - Tests: Unit test formatDisplayDate output unchanged for a sample date and returns the fallback for an invalid date.
  - Risk: None; identical output.

### B27 Badges (9)
_Freeze ids first, then fix the useBadgeProgress criteria and the vault._

- **[medium · correctness] Year-worded badges (Cycle, Era Explorer) are scored on a decade count, so several can never unlock** `ui-voyage#0`
  - Where: `src/hooks/useBadgeProgress.ts:146`, `src/hooks/useBadgeProgress.ts:256`, `src/data/badges.ts:138`, `src/data/badges.ts:414`, `src/data/badges.ts:395`
  - Problem: The release-year stat counts decades, but Cycle Veteran/Master/Legend and Era Explorer 3-15 promise 'years'. A library spanning 2018-2024 shows Cycle Veteran at 1/2, and Era Explorer 7/10/15 (gold, platinum, diamond) need 60-140 year spreads, so they can never unlock. Retro Signal ('games spanning decades', min 1) unlocks as soon as any game has a release date.
  - Fix: Add releaseYearCount = releaseYears.size to the derived stats and a { type: 'releaseYearCount'; min } condition in badge-types.ts plus the evaluateCondition switch. Point Cycle Veteran/Master/Legend (badges.ts:138-140) and Era Explorer (badges.ts:414) at it and reword Era Explorer flavor text to 'N different release years'. Keep releaseYearSpan only for Decade Span / Triple Decade / Time Traveler. Do NOT set Retro Signal to min 2 (it would duplicate Decade Span); keep min 1 and reword it to 'Games with a known release era'. Edit conditions in place only: do not insert or remove b() calls, because badge ids are positional (see the badge-id freeze item).
  - Tests: Unit test computeDerivedStats/evaluate: games released 2018, 2020, 2022, 2024 give releaseYearCount 4 and unlock Cycle Veteran and Era Explorer 3; decade badges unchanged for 1985+2015 (span 4). Snapshot test that ALL_BADGES ids are unchanged by this edit.
  - Risk: Badge lock states change for existing users (several unlock at once, raising XP/commander level). No re-lock since Retro Signal keeps min 1.

- **[medium · correctness] Meta badges (Collector, Milestone, Signal, Hidden Signal) evaluated in one pass, stay locked although the count is reached** `ui-voyage#1`
  - Where: `src/hooks/useBadgeProgress.ts:362`, `src/hooks/useBadgeProgress.ts:375`
  - Problem: Meta badges that depend on the number of unlocked badges are checked once, in list order. A badge checked before later meta badges unlock never sees the higher count, so the vault header can say e.g. 15 decoded while 'Signal 15' shows locked at 15/15. A replay of the logic disagreed with a fixed-point evaluation in more than half of random cases, and it never self-corrects.
  - Fix: Collect meta-badge result indices once (totalBadgeCount, tierBadgeCount, allBranchesUnlocked, plus branchBadgeCount in isMeta). Loop: changed=false; for each locked meta result, evaluate against current unlockedCount/tierCounts/branchCounts, always write current/target, and on met increment the counters and set changed=true; repeat while changed. The final pass that unlocks nothing refreshes progress text. Evaluate tasteDnaAverage once outside the loop. Do not rely on threshold sorting alone (duplicate Hidden Signal thresholds and tier/branch coupling need iteration).
  - Tests: Unit test: 5 arbitrary non-meta unlocks plus 'The Void Gazes Back' must end with Signal 10 unlocked and unlockedCount equal to the fixed-point value; property test that every totalBadgeCount badge with min <= final unlockedCount is unlocked.
  - Risk: Existing users see several legendary/secret badges unlock at once on first load after upgrade, and XP/commander level rise. Intended.

- **[medium · correctness] Badge 'Obtained' dates are stamped on first render of the card, and each stamp rewrites the whole LevelDB namespace** `ui-voyage#2`
  - Where: `src/components/medals/badge-vault.tsx:97`, `src/services/badge-unlock-timestamps.ts:167`, `src/services/badge-unlock-timestamps.ts:177`, `src/services/badge-unlock-timestamps.ts:221`, `src/hooks/useBadgeProgress.ts`
  - Problem: The only writer of unlock dates runs inside BadgeCard's render, so a badge earned in March but first shown in October reads 'Obtained Today'; cards behind paging or filters get stamped when the user reaches them. Each new stamp sends a batch that re-puts every stored badge (up to ~1000 puts per stamp, ~16 batches per page). A write that lands before LevelDB hydration finishes overwrites the stored historical date for the next launch.
  - Fix: 1) Move stamping out of render into an app-level effect or store subscription (not medals-view only) that derives unlocked ids whenever journey/session/status/library stores change, awaits badgeUnlockTimestampsReady(), and writes all new ids via a new setBadgeUnlockedAtMany(entries) that skips ids already stamped. 2) Make persistence per-key: persistOne/persistMany sends puts only for new ids and adds them to _knownKeys (no debounce, so no lost-write window). 3) Make setters a no-op/queued until _isInitialized, and have initFromLevelDB merge with stored values winning. 4) BadgeCard calls only getBadgeUnlockedAt() and hides the 'Obtained' line while undefined.
  - Tests: Service tests: stamping 16 ids issues one batch with 16 puts; a set before hydration does not overwrite a stored value; getAll merge keeps stored timestamps. Component test: rendering BadgeCard does not write. Hook test: unlocked ids get stamped once from the app-level effect.
  - Risk: Existing wrong dates stay as they are (no backfill). Moving derivation to app level adds a badge computation on store changes; keep it memoized/idle-scheduled.

- **[low · correctness] Freeze positional badge ids before any badge-list edit** `ui-voyage#4`
  - Where: `src/data/badges.ts:36`, `src/services/badge-unlock-timestamps.ts`
  - Problem: Badge ids are assigned by declaration order and the secret list pads to exactly 1000. Inserting or removing any badge shifts every later id, so stored 'Obtained' dates attach to the wrong badges. Nothing triggers it today, but this release edits badges.ts and nothing guards the mapping.
  - Fix: Add a snapshot test recording (id, branch, name) for every ALL_BADGES entry so any id shift fails CI, and a comment in badges.ts that badges are edited in place or appended, never inserted. If mid-list additions are ever needed, give b() explicit ids equal to their current positional value (no LevelDB migration) and fix the secret count instead of padding to 1000.
  - Tests: Snapshot test of the id-to-(branch, name, occurrence) mapping.
  - Risk: None at runtime; test-only guard.
  - Coordinate with ui-voyage#0, ui-voyage#1, ui-voyage#2, ui-voyage#3, ui-voyage#5, hooks#25, hooks#26, hooks#27: Freeze positional badge ids (ui-voyage#4) before any badge-list or criteria edit. Then make the useBadgeProgress changes.

- **[low · correctness] Active-streak and backlog badges re-lock when the live condition stops being true** `ui-voyage#3`
  - Where: `src/hooks/useBadgeProgress.ts:199`, `src/data/badges.ts:248`, `src/services/session-store.ts:555`
  - Problem: Burning Bright, Undimmed Flame, Inferno Protocol and Living Supernova are judged on the current streak, and the zero-hours backlog badges on the current backlog. Two days without play, or playing a backlog game, re-locks them, drops XP and commander level, and can re-lock meta badges built on them.
  - Fix: Product decision first. Preferred: latch the volatile condition types (currentStreakDays, gamesWithZeroHours) using a read-only hasUnlockedAt(id) check against the hydrated timestamp map (after the stamping item above moves writes to app level), applied in the first pass before the meta loop, with hydration state in the memo deps. Do not evaluate them against longestStreakDays (duplicates Daily Patrol/Weekly Vigil etc.). If the product wants them live, exclude them from totalPoints, commanderLevel and meta counts and reword the copy.
  - Tests: Hook test: streak 7 unlocks Burning Bright and stamps it; streak 0 afterwards keeps it unlocked and unlockedCount stable; before hydration no flicker assertions.
  - Risk: Depends on the timestamp-stamping fix; clearBadgeUnlockTimestamps would un-latch. Semantics change for 'Active' badges.

- **[low · correctness] Vault search reveals locked secret badges by their hidden name, description and lore** `ui-voyage#5`
  - Where: `src/components/medals/badge-vault.tsx:284`, `src/components/medals/badge-vault.tsx:96`
  - Problem: Locked secret cards show only 'Classified', but the search filter still matches their hidden name, description, lore and genre. Typing a guess keeps the matching Classified card visible, so users can discover secret objectives by trial and error.
  - Fix: In the filter compute hidden = b.badge.secret && !b.unlocked; for hidden badges match only 'classified' (and the 'secret' branch label). Ideally share a getVisibleSearchText(badge, unlocked) helper between card and filter.
  - Tests: Component test: a locked secret badge does not match a word from its description; it matches 'classified'; once unlocked it matches its name.
  - Risk: None.

- **[low · correctness] Session streaks break across a DST fall-back day** `hooks#25`
  - Where: `src/hooks/useBadgeProgress.ts:133`
  - Problem: Consecutive days are compared as at most 24 hours apart, but the fall-back day is 25 hours, so streaks reset and streak badges undercount.
  - Fix: Replace line 133's condition with `Math.round(diff / DAY_MS) === 1` (matching voyage-derive.ts:889 and session-store.ts:592); optionally import DAY_MS from src/lib/voyage-derive.ts.
  - Tests: With TZ set to a DST zone (e.g. America/New_York), sessions on Nov 1, 2, 3 2025 give longestStreakDays 3.
  - Risk: None.

- **[low · correctness] 'Rapid Deployment: Add 3 games in a day' unlocks for anyone with 3 journey entries** `hooks#26`
  - Where: `src/hooks/useBadgeProgress.ts:262`, `src/hooks/useBadgeProgress.ts:264`
  - Problem: The condition checks the all-time entry count, so the silver badge and its points go to anyone with 3 games, however spread out. The month-based conditions are also all-time totals and would mis-award if used.
  - Fix: In computeDerivedStats add maxEntriesAddedInOneDay by bucketing journeyEntries on the local date of addedAt (not firstPlayedAt), plus per-year counts for year:'current'. Evaluate gamesPerYear against that. Decide whether bulk store imports should count (if not, exclude entries created by sync). Remove hoursInMonth/completionsInMonth from badge-types.ts until implemented.
  - Tests: Three entries on different days -> not unlocked; three on the same local day -> unlocked.
  - Risk: Low; users who already have the badge may lose it on recompute (stateless evaluator); check vault timestamps behavior.

- **[low · correctness] 'Perfectly Average' badge says 20+ ratings but unlocks at 10** `hooks#27`
  - Where: `src/hooks/useBadgeProgress.ts:245`
  - Problem: All average-rating badges use a hard-coded minimum of 10 ratings, so the platinum badge unlocks below its advertised 20.
  - Fix: Add `minRatings?: number` to the averageRating condition in badge-types.ts:59, set minRatings: 20 on 'Perfectly Average' in badges.ts:495, and use `stats.ratingCount >= (cond.minRatings ?? 10)`. Lower-risk alternative: change the description to '(10+)'.
  - Tests: 15 ratings averaging 3.0 -> locked; 20 -> unlocked; other averageRating badges still unlock at 10.
  - Risk: Low; may revoke the badge from users with 10-19 ratings.

### B28 Ark and Captain's Log (7)
_showcase-view and journey-view._

- **[low · correctness] Ark arrow-key handler steals Left/Right from text fields (AI chat, dialogs)** `ui-voyage#6`
  - Where: `src/components/showcase-view.tsx:852`, `src/components/showcase-view.tsx:854`, `src/components/showcase-view.tsx:864`
  - Problem: While the Ark tab is mounted, a window keydown listener cancels every Left/Right press and spins the 3D wheel. Typing in the AI chat panel or any text field over the Ark cannot move the caret.
  - Fix: At the top of onKey: return if e.defaultPrevented or e.altKey/ctrlKey/metaKey/shiftKey; const t = e.target as HTMLElement | null; if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return. Keep the listener on window (the container is not focusable). Same guard as year-wrapped.tsx:269.
  - Tests: Component test: ArrowRight dispatched from a focused input does not change the active card and is not defaultPrevented; dispatched from body it advances.
  - Risk: None.

- **[low · correctness] Ark selection jumps to another game, or crashes, when journey entries change while viewing** `ui-voyage#7`
  - Where: `src/components/showcase-view.tsx:843`, `src/components/showcase-view.tsx:242`, `src/components/showcase-view.tsx:252`, `src/components/showcase-view.tsx:259`, `src/components/journey-view.tsx:505`
  - Problem: The selected card is stored as a plain index. Any journey change (Playing Now on launch, auto-hold) re-sorts the cards, so the same index shows a different game or the selection snaps back to the most-played card. If the card count shrinks, Scene reads past the end of the array and throws, and the error boundary replaces the Voyage view.
  - Fix: Store activeGameId (lazy-init to the most-played card) and derive idx = flatCards.findIndex(c => c.entry.gameId === activeGameId), falling back to defaultIndex when -1; remove the [defaultIndex,total] reset effect. Keys/wheel/handleSelect set the id of flatCards[(idx+dir+total)%total]. Clamp in Scene: safeIdx = total ? Math.min(activeIndex, total-1) : 0 at lines 242/252/259. Make buildGenreGroups deterministic: break genre-count ties by genre name and hours ties by gameId.
  - Tests: Unit test buildGenreGroups order is stable when only a status changes. Component test: shrinking entries with activeIndex at the end does not throw; changing another game's status keeps the selected gameId.
  - Risk: Small UI change; initial default stays most-played.

- **[low · memory-leak] Shared module-level Ark geometries/materials keep every past WebGL renderer alive** `ui-voyage#8`
  - Where: `src/components/showcase-view.tsx:68`, `src/components/showcase-view.tsx:79`, `src/components/showcase-view.tsx:619`, `src/components/showcase-view.tsx:649`
  - Problem: Five shared geometries/materials are never disposed. three.js adds a per-renderer dispose listener to them, so each visit to the Ark tab leaves the previous renderer, its context and canvas reachable. Memory grows with every Ark mount in a long session.
  - Fix: Inside Scene (rendered within <Canvas>) add useEffect(() => () => { CASE_GEOMETRY.dispose(); COVER_GEOMETRY.dispose(); SPINE_GEOMETRY.dispose(); CASE_MATERIAL.dispose(); CASE_MATERIAL_ACTIVE.dispose(); }, []). Comment the dispose={null} props pointing to it.
  - Tests: Optional dev check/test: after mount/unmount/mount, CASE_GEOMETRY._listeners?.dispose?.length <= 1.
  - Risk: Low; three re-uploads the objects on next render.

- **[low · performance] Hidden Ark canvas keeps rendering at 60 fps under the full-screen Wrapped overlay** `ui-voyage#9`
  - Where: `src/components/year-wrapped.tsx:442`, `src/components/showcase-view.tsx:1045`, `src/components/dashboard.tsx:1774`
  - Problem: Wrapped covers the screen, but the Ark scene below keeps drawing, animating and raycasting every frame because it only pauses when the window is hidden. This competes with Wrapped's animations and PNG export.
  - Fix: Pass Dashboard's showWrapped down: <JourneyView suspended={showWrapped}> -> <ShowcaseView paused>, frameloop={visible && !paused ? 'always' : 'never'}. Clamp delta in the damping useFrame (Math.min(delta, 0.05)) to avoid a jump on resume. Optionally pass the same flag to the Galaxy host's pause path.
  - Tests: Component test: ShowcaseView with paused=true renders Canvas with frameloop 'never'.
  - Risk: Minimal.
  - Coordinate with ui-voyage#21, ui-voyage#22: All touch the dashboard.tsx:1774-1784 Wrapped overlay wiring.

- **[low · correctness] Captain's Log cards show stale status, hours, rating and Removed state after store changes** `ui-voyage#11`
  - Where: `src/components/journey-view.tsx:159`, `src/services/journey-store.ts:572`, `src/services/journey-store.ts:586`, `src/services/journey-store.ts:640`, `src/services/journey-store.ts:659`
  - Problem: Journey store updates change entry objects in place, so the memoized Log cards see the same object and skip re-rendering. Month counts update but cards keep the old badge and hours, and a removed game keeps 'In Library' and stays clickable until the view remounts.
  - Fix: Copy-on-write in markRemoved, the general-change branch of syncProgress, syncTitleIfPlaceholder and syncJourneyTitle: this.entries.set(gameId, { ...existing, ...changes }) before invalidateSortedCache/notify. Leave the hours-only branch in place (it keeps _sortedCache on purpose) or also swap the cached array slot. Grep for callers that hold getEntry() results across a mutation. Pass inLibrary as a prop computed in the parent instead of reading libraryStore during card render.
  - Tests: journey-store test: getEntry identity changes after markRemoved/syncProgress status change, unchanged after hours-only update. Component test: Log card updates status badge after syncProgress.
  - Risk: Object identity changes for all getAllEntries consumers (intended; Ark/Medals memos also refresh).

- **[low · performance] Voyage fetches Steam player counts for every journey entry on open, even when the Log is not shown** `ui-voyage#12`
  - Where: `src/components/journey-view.tsx:410`, `src/components/journey-view.tsx:425`
  - Problem: On every Voyage open, and whenever a game is added, Ark walks all journey entries (removed ones included) and fetches player counts, though only the Log tab shows them. On a cold cache this queues thousands of Steam requests that compete with other player-count calls.
  - Fix: Gate the effect on viewStyle === 'log'; derive steamIds from arkAndLogEntries (memoized string key) instead of all entries; keep sequential batches of 20-50 and merge each batch into setPlayerCounts as it arrives (do not send all ids at once: it can overflow playerCountLimiter's 500 queue). Keep the cancelled guard and keep existing counts when leaving the Log.
  - Tests: Component test: with viewStyle 'ark', getMultiplePlayerCounts is not called; switching to 'log' calls it only with active steam ids.
  - Risk: Counts appear when the Log opens instead of in advance.

- **[low · performance] Captain's Log mounts every card at once and its progress line goes stale on resize** `ui-voyage#13`
  - Where: `src/components/journey-view.tsx:704`, `src/components/journey-view.tsx:190`, `src/components/ui/timeline.tsx:19`, `src/components/ui/timeline.tsx:72`
  - Problem: The Log renders every month and every card (framer-motion each) on open, so large played histories make the first open slow. The timeline line length is measured only when data changes, so resizing the window across the lg breakpoint leaves the line too short or too long.
  - Fix: Render the newest ~24 months (or add content-visibility: auto with contain-intrinsic-size on each year/month section) with a 'Show older' button. Replace per-card motion.div whileHover with a CSS hover:scale transition. In ui/timeline.tsx, replace the [ref,data] getBoundingClientRect effect with a ResizeObserver on ref.current (setHeight(contentRect.height), disconnect on cleanup). Keep the height animation (scaleY would stretch the gradient ends). No playerCounts refactor needed.
  - Tests: Component test: Log with 50 months renders only the newest window until 'Show older'; Timeline updates height when the observed element resizes (mock ResizeObserver).
  - Risk: Check sticky year headers and the scroll-linked line with paged content.

### B29 Scenes and Audit (7)
_journey-scenes-view, journey-audit-view and voyage-derive._

- **[medium · performance] Audit queue renders every finding with no paging and re-renders all of them on each library change** `ui-voyage#14`
  - Where: `src/components/journey-audit-view.tsx:1512`, `src/components/journey-audit-view.tsx:1166`, `src/components/journey-audit-view.tsx:1217`, `src/components/journey-view.tsx:496`
  - Problem: After a Steam import almost every game has no executable path, so the Audit tab mounts one animated card per game (about 2,000 for a big library), a multi-second stall. Every library update, including the metadata backfill several times a second, rebuilds all findings and re-renders every card.
  - Fix: Render queue.slice(0, visibleCount) with PAGE_SIZE 50 and a 'Show N more' button; reset visibleCount when enabled rules change, not on recompute. Give FindingCard a custom memo comparator over finding.key/title/question/detail/resolution/partnerId, the rollup fields it reads (status, rating), and the callbacks. Optional: coalesce the libraryStore snapshot to one setState per animation frame (no longer).
  - Tests: Component test: 200 findings render 50 cards plus 'Show more'; scores/issuesByRule unchanged vs full list; updating an unrelated library entry does not re-render existing cards (render counter).
  - Risk: Scores use the full open list so they do not change. Resolved finding must disappear immediately (no long debounce).

- **[medium · correctness] Scenes spine click on a far episode does nothing, jumps later, and mounts hundreds of animated rows** `ui-voyage#15`
  - Where: `src/components/journey-scenes-view.tsx:919`, `src/components/journey-scenes-view.tsx:923`, `src/components/journey-scenes-view.tsx:928`, `src/components/journey-scenes-view.tsx:852`, `src/components/journey-scenes-view.tsx:1071`
  - Problem: The spine passes the episode's index among episodes only, but the stream also contains gap and milestone rows, so the reveal window often stops short of the target: the click does nothing and the page later jumps to the old target on 'Show more'. When it does reach far targets, it mounts every row above at once, each starting an entrance animation, causing a long stall.
  - Fix: In handleSpineClick: const pos = rows.findIndex(r => r.key === id); if pos < 0 clear pendingScrollRef and return; else set pendingScrollRef and setVisibleCount(n => Math.max(n, pos + 1 + PAGE_SIZE)) (add rows to deps). Run the pending check in a layout effect keyed on visibleRows and clear pendingScrollRef when the id is no longer in rows (curation change) or after a failed attempt. Track animateFrom = previous visibleCount in a ref and pass initial={false}/no-animation for rows mounted by a jump. Use scroll behavior 'auto' for long jumps. Full virtualization of the stream is optional follow-up.
  - Tests: Component test: 300 scenes + 90 gaps/milestones, click scene #250 mounts and scrolls to it; target removed by curation clears pending so 'Show more' does not scroll; jump-mounted rows render without initial animation.
  - Risk: Low; IntersectionObserver spine sync still keyed on mounted ids.

- **[medium · correctness] Scenes 'Nothing tracked for X' gaps ignore longer overlapping episodes on other games** `ui-voyage#16`
  - Where: `src/lib/voyage-derive.ts:318`, `src/lib/voyage-derive.ts:321`, `src/components/journey-scenes-view.tsx:828`
  - Problem: Gaps are measured only against the previous episode by start time. If one game was played steadily for months while short episodes of other games started inside it, Scenes reports a multi-month break (even 'Your longest break') during which the user was playing.
  - Fix: Copy and sort scenes by startMs ascending; walk with maxEnd and maxEndScene; when scene.startMs - maxEnd >= minGapMs emit a gap { startMs: maxEnd, endMs: scene.startMs, id: `gap:${maxEndScene.id}->${scene.id}` }; then maxEnd = max(maxEnd, scene.endMs). Track the longest gap in the same walk; return newest-first.
  - Tests: voyage-derive test: long scene A (Jan-Jun) with B (Feb 10) and C (May 1) on other games yields no gap; plain non-overlapping case unchanged; equal start times.
  - Risk: Fewer/shorter gaps shown; longest-break marker may move; gap ids change (React keys only).

- **[low · correctness] Scenes 'Peak slot' combines busiest weekday and busiest hour separately, can name an empty slot** `ui-voyage#17`
  - Where: `src/lib/voyage-derive.ts:982`, `src/components/journey-scenes-view.tsx:541`
  - Problem: The peak weekday and peak hour are picked independently, so the tile can say 'Sat evening' while the heatmap next to it shows zero play in that cell.
  - Fix: Keep peakWeekday/peakHour, add peakSlot: { weekday, daypart } | null as the first argmax cell of grid (reuse the existing max loop); build the label from rhythm.peakSlot with DAYPART_LABELS.
  - Tests: voyage-derive test: 20 Saturday-morning sessions vs 15 Wednesday 21:00 sessions gives peakSlot Sat/morning (busiest cell), and existing peakHour assertions still pass.
  - Risk: Display only.

- **[low · correctness] Scenes milestones count Ark's own sync and auto-hold status rows** `ui-voyage#18`
  - Where: `src/lib/voyage-derive.ts:376`, `src/lib/voyage-derive.ts:410`
  - Problem: Completing a game owned on both Steam and Epic writes a second, automatic Completed row for the twin, so it counts as two completions and two titles and milestones like '5th completion' fire early.
  - Fix: Add if (isBookkeepingStatusChange(e)) continue; at the top of the deriveMilestones history loop (helper already imported), matching churn, Wrapped and badges. Drop the 'undo reverts Completed' part (no such writer).
  - Tests: voyage-derive test: Completed row plus a source 'sync' Completed row for a twin yields one completion milestone; source-less legacy rows still count.
  - Risk: Milestone ordinals shift later for affected users.

- **[low · correctness] Audit open-items trend subtracts decisions for games no longer in the library** `ui-voyage#19`
  - Where: `src/lib/voyage-derive.ts:1166`, `src/lib/voyage-derive.ts:1194`
  - Problem: Added items count only library games, but decisions count every status-history row, including removed games. Users who pruned their library see the open-items chart pinned at 0 even with undecided records.
  - Fix: const libIds = new Set(rollups.filter(r => r.inLibrary).map(r => r.gameId)); skip history rows whose gameId is not in libIds when building decidedAt. Optionally ignore decided timestamps earlier than that rollup's addedAtMs. Do NOT add the isBookkeepingStatusChange filter (sync rows legitimately decide sibling records).
  - Tests: voyage-derive test: 30 removed completed games plus 5 undecided library games gives open = 5, not 0.
  - Risk: Audit debt chart values rise for users with removed games.

- **[low · performance] Infinite framer-motion loops (Audit ring glow, Oracle hero Ken Burns, empty-state rings) keep the main thread busy** `ui-voyage#24`
  - Where: `src/components/journey-audit-view.tsx:622`, `src/components/oracle-view.tsx:1495`, `src/components/empty-state.tsx:229`, `src/components/empty-state.tsx:244`
  - Problem: Several decorative animations repeat forever on framer-motion's JavaScript loop (SVG opacity with blur, and image scale), which framer v10 cannot hand to the compositor. The renderer never idles while Audit or Oracle is open, costing CPU and battery, and reduced-motion settings are ignored.
  - Fix: Oracle hero: plain <img> with .oracle-kenburns { animation: kb 20s linear infinite alternate; will-change: transform } and @keyframes kb scale(1)->scale(1.05). Audit glow: either a finite repeat (3) then hold at 0.45, or move the glow circles into their own <svg> inside an HTML wrapper whose opacity is animated via CSS keyframes (2.4s ease-in-out). Empty-state rings: CSS keyframes. Add @media (prefers-reduced-motion: reduce) { animation: none } fallbacks (static 0.45 glow). No document.hidden handling needed (backgroundThrottling is on).
  - Tests: Visual check; optional test that components render no framer animate prop with repeat: Infinity, and reduced-motion class disables animation.
  - Risk: Visual only; keep the same cadence.

### B30 Wrapped, tour and splash (7)
_year-wrapped, guided-tour and splash scene._

- **[medium · correctness] Wrapped 'Fly through your year' does nothing when opened over the Galaxy, then replays days later** `ui-voyage#21`
  - Where: `src/components/year-wrapped.tsx:415`, `src/components/dashboard.tsx:1778`, `src/components/embedding-space/controller.ts:306`
  - Problem: If the user is already in the Galaxy, the flythrough request is stored but the Galaxy only reads it when it loads, so nothing happens. The request never expires, so the next Galaxy visit, maybe days later, starts an unexpected cinematic tour.
  - Fix: Add consumePendingFlythrough(maxAgeMs = 10 min) in flythrough.ts (read, remove, drop if generatedAt missing/older than TTL). stashFlythrough dispatches window CustomEvent 'ark:flythrough-pending'. EmbeddingSpaceController.mount listens (registered in this.cleanups) and, if nodes are loaded, consumes and this.later(launchFlythroughKeyframes, 600); if loading, leaves it for load(). load() uses the same helper. Do not force a remount and do not use the 'storage' event.
  - Tests: Unit test consumePendingFlythrough: expired payload removed and null; fresh payload returned once. Controller test: event while mounted launches the flythrough.
  - Risk: Low; generous TTL avoids dropping real handoffs on slow loads.

- **[low · correctness] Wrapped 'Finish line' ring and its sentence use different denominators** `ui-voyage#20`
  - Where: `src/components/year-wrapped/slides.tsx:521`, `src/components/year-wrapped/stats.ts:315`, `src/components/year-wrapped/stats.ts:170`
  - Problem: The ring divides completions by every game touched that year (wishlist adds included), while the sentence uses games played. A user who wishlisted 30, played 4 and finished 2 sees '6% finished' next to '2 of the 4 games'. The Completionist title uses the inflated denominator.
  - Fix: In stats.ts build engagedIds = new Set([...gamesPlayedIds, ...completedSet]); completionRate = round(gamesCompleted / engagedIds.size * 100) (0 when empty); expose completionBase = engagedIds.size; SlideCompletion uses stats.completionBase in the subtitle.
  - Tests: year-wrapped-stats test: 30 unplayed wishlist adds, 4 played, 2 completed gives 50% and completionBase 4; completed-by-status-only game counted once.
  - Risk: Shown percentages and the Completionist title change (easier to earn).

- **[low · correctness] Wrapped desktop notification click does nothing after the user left the Dashboard** `ui-voyage#22`
  - Where: `src/components/year-wrapped/banner.tsx:99`, `src/components/year-wrapped/banner.tsx:64`, `src/components/dashboard.tsx:1784`
  - Problem: The notification click calls the snackbar instance that sent it. After visiting a game page that Dashboard is gone, so the window focuses but Wrapped never opens, and the notification is not sent again that season.
  - Fix: Module-level handoff in banner.tsx or wrapped-season.ts: requestWrappedOpen() sets pendingWrappedOpen = true, sets location.hash = '#/' if not on '/', and dispatches 'ark-wrapped-open'. Notification onclick calls it. WrappedSnackbar consumes the pending flag on mount and listens for the event while mounted; both clear the flag and call onLaunch (optionally markWrappedSeen).
  - Tests: Unit test: requestWrappedOpen with no snackbar mounted, then mounting a snackbar calls onLaunch once; with one mounted, the event calls it immediately.
  - Risk: Low.

- **[low · correctness] Double-clicking 'Save as images' runs two exports that overwrite each other** `ui-voyage#23`
  - Where: `src/components/year-wrapped.tsx:355`, `src/components/year-wrapped.tsx:356`, `src/components/year-wrapped/slides.tsx:745`
  - Problem: On first use the button stays enabled while export libraries load, so a quick double click starts two exports. PNGs can contain the wrong slide, two zips download, and the UI re-enables mid-export.
  - Fix: Add exportingRef: if (exportingRef.current) return; exportingRef.current = true before the dynamic imports; move the await Promise.all(imports) inside try so finally clears the ref and chunk-load errors reach the toast. Call setExportProgress({ current: 0, total: slides.length }) immediately to disable the button.
  - Tests: Component test: two synchronous handleSaveImages calls with delayed imports produce one export run.
  - Risk: None.

- **[low · correctness] Guided tour 5-minute safety timer marks an unfinished tour as completed** `ui-voyage#25`
  - Where: `src/components/guided-tour.tsx:1058`, `src/components/guided-tour.tsx:1062`, `src/components/guided-tour.tsx:1105`
  - Problem: Five minutes after a tour starts, it is force-closed and saved as completed even if the user is still reading, so the first-run welcome tour never auto-starts again.
  - Fix: Move clear/setTimeout into resetSafetyTimer(); call it when effectiveSteps is set and at the top of handleCallback for STEP_AFTER/TOOLTIP events (inactivity watchdog). On fire call endTour({ persistCompletion: false }). Read endTour through a ref inside the timer.
  - Tests: Fake-timer test: advancing steps every 4 minutes never fires the timer; 5 minutes idle closes the tour without writing ark-tour-completed-<id>.
  - Risk: A timed-out tour auto-starts again next launch (intended).

- **[low · correctness] Voyage guided tour waits the full 12 s when the journey is empty or loading** `ui-voyage#26`
  - Where: `src/components/journey-view.tsx:749`, `src/components/journey-view.tsx:714`, `src/components/guided-tour.tsx:611`, `src/components/guided-tour.tsx:965`
  - Problem: The last tour step points at the Voyage header, which does not exist in the empty and loading states. A new user who starts the tour gets 12 seconds of nothing, then a tour missing that step.
  - Fix: In the empty state, put data-tour="journey-header" on a visible element (the 'Your Voyage Awaits' heading wrapper). In the loading skeleton, add data-tour="journey-header" to the header wrapper at line 714. Leave waitForTourDomReady semantics unchanged.
  - Tests: Component test: empty and loading JourneyView both contain [data-tour=journey-header]; waitForTourDomReady('journey') resolves promptly.
  - Risk: None.

- **[low · memory-leak] Splash Draco decoder workers and decoded model stay in memory all session** `ui-voyage#27`
  - Where: `src/components/splash-3d-scene.tsx:132`, `src/components/splash-3d-scene.tsx:178`, `public/scene.glb`
  - Problem: The splash planet model is Draco-compressed, which starts two decoder workers with their own WASM heaps and caches the decoded mesh. None of it is released after the splash closes, about 10-20 MB held for the session, and the decoder is fetched from gstatic.com, which fails offline.
  - Fix: Preferred: re-export public/scene.glb without Draco (gltf-transform copy, or meshopt/quantize) so no workers or remote decoder are needed. Then add useEffect(() => () => useGLTF.clear(url), []) in Splash3DScene. If Draco must stay: bundle the decoder locally (public/draco/, setDecoderPath(assetUrl('draco/')), add to electron-builder files), call useGLTF with useDraco=false plus an extendLoader using an owned DRACOLoader with setWorkerLimit(1) (same args in preload), and dispose it on unmount. Do not hand-dispose geometries.
  - Tests: Manual: splash renders offline; heap snapshot after splash shows no Draco workers. Unit: splash unmount calls useGLTF.clear.
  - Risk: GLB grows a few hundred KB; re-decode on a renderer reload (~100 ms).

### B31 Release calendar (5)
_release-calendar.tsx only. The adult-filter cache fix lands in B21._

- **[medium · correctness] Release calendar Week view opens on the week of the 1st of the month, not the current week** `ui-other#9`
  - Where: `src/components/release-calendar.tsx:1818-1823`, `src/components/release-calendar.tsx:1815`, `src/components/release-calendar.tsx:1808`, `src/components/release-calendar.tsx:1772`, `src/components/release-calendar.tsx:1785-1790`, `src/components/release-calendar.tsx:1997`
  - Problem: Week view and the Today button show the week containing the 1st of the month (on Oct 30 it shows Sep 27 to Oct 3). The Today button is hidden because the app thinks it is on the current week, and Prev is disabled, so users must click Next several times to reach this week.
  - Fix: Anchor: if currentYear/currentMonth is today's month use startOfWeek(today), else startOfWeek(1st of currentMonth); weekStart = anchor + weekOffset*7 using local setDate arithmetic (DST-safe). isCurrentPeriod for week = today is within [weekStart, weekStart+6]. Allow negative weekOffset: canGoPrev = (weekStart - 7 days) >= startOfWeek(getCalendarWindowStart(now)); goPrev clamps to that floor instead of 0. goToday stays (today's month, offset 0 resolves to today's week).
  - Tests: With fake date 2026-10-30, Week view weekStart is Oct 25. Prev goes to Oct 18 and is disabled at the window floor. Navigating to Dec in Month view then switching to Week shows the week of Dec 1. Today button visible when not on today's week.
  - Risk: Low. Isolated date math; DST boundaries need a test.

- **[medium · performance] Release calendar re-renders every card on any library change: new Date per card defeats GameCard memo, unstable add callback, and libraryIds dependency even with My Radar off** `ui-other#11`
  - Where: `src/components/release-calendar.tsx:495-496`, `src/components/release-calendar.tsx:744`, `src/components/release-calendar.tsx:838-868`, `src/components/release-calendar.tsx:1470-1474`, `src/components/release-calendar.tsx:1569`, `src/components/game-card.tsx:741-744`
  - Problem: Every calendar card gets a fresh Date object, and the card memo compares that by reference, so it never skips. The add callback and the filtered list also change on every library notification, even when My Radar is off. So one Add to Library click or a status change re-renders and re-measures up to about 360 animated cards in Year view, causing a visible hitch.
  - Fix: 1) Module-level const EPOCH = new Date(0) used for createdAt/updatedAt in releaseToGame (no WeakMap needed). 2) Make GroupedFeed's handleAddToLibrary stable: read releaseMap from a ref and depend only on [onAddToLibrary]. 3) filteredReleases depends on radarActive ? libraryIds : null instead of libraryIds. 4) In the libraryStore subscriber use setLibraryIds(prev => { const next = buildLibraryIdSet(); return next.size === prev.size && [...next].every(id => prev.has(id)) ? prev : next; }) so status-only and cachedMeta notifies cause no render. Optional: give motion.div layoutDependency per group or disable layout animation for Year view.
  - Tests: Render-count test: adding one game re-renders only that card. Status change on a library game while calendar mounted causes no GroupedFeed render. Toggling My Radar still filters correctly.
  - Risk: Low. The ref for releaseMap must be updated before clicks can happen (assign during render).

- **[medium · performance] '+N more' in a calendar group mounts every release of that period at once** `ui-other#12`
  - Where: `src/components/release-calendar.tsx:781`, `src/components/release-calendar.tsx:836-868`
  - Problem: Expanding a calendar group mounts all of its releases in one go, often several hundred animated cards, each measured by the layout animation. The app stalls for a noticeable time, and later re-renders re-measure all of them.
  - Fix: Replace the expanded Set with Map<groupKey, visibleCount>; '+N more' adds 60 per click (or via an IntersectionObserver sentinel); 'Show less' resets to INITIAL_CARD_COUNT (30). Render only the first INITIAL_CARD_COUNT cards as motion.div with layout; extra cards use plain div (or layout={false} initial={false}). Optional: wrap each extra batch in a content-visibility:auto container with intrinsic size. Avoid a nested virtualizer (conflicts with month-focus and scroll restore).
  - Tests: Clicking '+N more' on a 300-release group mounts 90 cards, next click 150. Show less returns to 30. Focus/scroll-restore still lands on the right month.
  - Risk: Low. Changes UX of expansion (stepwise); keep the remaining count label accurate.

- **[low · correctness] 'My Radar' tooltip promises taste matching but the filter only shows games already in the library** `ui-other#23`
  - Where: `src/components/release-calendar.tsx:573`, `src/components/release-calendar.tsx:1565-1566`
  - Problem: The tooltip says My Radar shows games matching your taste, but it only shows releases already in your library. With none, the calendar goes empty with a generic message.
  - Fix: Copy-only: 'Show only releases already in your library (tracked or Want to Play).' Add a Radar-specific empty state when radarActive and no results: 'None of your library games release in this period.' Do not build taste matching in this release.
  - Tests: Snapshot of tooltip text; Radar on with empty library shows the Radar empty message.
  - Risk: None.

- **[low · earlier review] Empty catalog upcoming list cached for 30 min on a fresh install**
  - Where: `src/components/release-calendar.tsx:364`
  - Fix: Do not cache an empty list; clear the cache when the catalog sync completes.

### B32 Embedding service and game graph (9)
_embedding-service and game-graph-store plus the graph-metrics worker. Memory and perf work that feeds Oracle but does not change ranking._

- **[medium · memory-leak] Re-chunk job builds a PhaseItem with text and hash for every catalog game up front and holds it for the hours-long phase** `renderer-stores#13`
  - Where: `src/services/embedding-service.ts:3152`, `src/services/embedding-service.ts:3176`, `src/services/rechunk-job-deps.ts`
  - Problem: The Steam and Epic re-chunk phases load about 155K entries with their text, build the full embedding text and hash for each before starting, and keep that array (about 100 MB) for the whole multi-hour job, including items already done before the resume cursor.
  - Fix: In the iterator callbacks push only ids, dropping ids <= wm.cursorAfter (count them as already). Sort once with the same comparator gamesAfterCursor uses. Walk in pages of ~200: Steam via catalogStore.getEntries(appIds) through a new steamFetch dep in rechunk-job-deps.ts; Epic needs a new getEntries (storeGetMany over its namespace) or, as a stopgap, keep only needed fields and compute wholeHash lazily. Build each PhaseItem and wholeHash just before processing; entries missing at load time advance the cursor as skipped. Progress from steamTotal/epicTotal plus already.
  - Tests: Rechunk job with a mocked 1,000-entry iterator and a cursor at entry 400: processes exactly entries 401+ in the same order as before, wholeHash values unchanged, progress totals correct. Entry deleted mid-job is skipped and cursor advances.
  - Risk: Medium: cursor ordering must stay identical or a resumed job may skip or repeat games; the order test guards it.

- **[medium · performance] Weekly TTL refresh rewrites every unchanged ~4 KB catalog vector just to bump its timestamp** `renderer-stores#14`
  - Where: `src/services/embedding-service.ts:3541`, `src/services/embedding-service.ts:1444`, `src/services/embedding-service.ts:308`
  - Problem: Any catalog pass after a daily sync re-reads and rewrites every catalog vector older than 7 days, about 155K rows and over 1 GB of IPC and disk writes, even though rows only expire after 90 days.
  - Fix: Add a catalog-specific constant, e.g. CATALOG_TTL_REFRESH_AGE_MS = CATALOG_TTL / 2, and push to refreshTimestampIds only when `ts > 0 && ts < Date.now() - CATALOG_TTL_REFRESH_AGE_MS`. Leave TTL_REFRESH_THRESHOLD_MS for library callers. Optionally cap slices per pass and yield between slices. Longer term move TTL stamps to a small meta namespace.
  - Tests: Catalog pass with rows aged 10, 50 and 85 days: only the 50 and 85-day rows are refreshed. Rows near 90 days still get refreshed before expiry across simulated daily passes.
  - Risk: Low: rows stay valid; a user who opens the app less than once per 45 days could see more expiries, same as today's worst case.

- **[medium · performance] Galaxy background precompute dequantises and projects every vector on the renderer main thread, streaming the namespace twice** `renderer-stores#16`
  - Where: `src/services/embedding-service.ts:4759`, `src/services/embedding-service.ts:4780`, `src/services/embedding-service.ts:4825`, `src/components/dashboard.tsx:226`
  - Problem: About 20 s after the dashboard opens, the galaxy build reads all ~160K pooled vectors twice over IPC, fully decodes each one just to check validity, then runs a 100x1024 projection per vector inline, giving about 160 back-to-back blocking tasks of 100-200 ms.
  - Fix: Stage it: (1) pass 1 uses hasDecodablePooledVector in collectIdsLevel and collectIds (no allocation); rows that later fail to decode are dropped in pass 2. (2) Pass 2 projects directly from int8 q into a reused scratch buffer (scale cancels under L2 normalisation), keeping readPooledVector only for legacy float rows. (3) Yield a macrotask between pages and every ~200 rows; then move the projection into a worker (R generated once, pages posted as transferable Int8Array). Optional single pass with a growable buffer, keeping the current library-vs-catalog precedence.
  - Tests: Projected output for a fixture with a fixed R matches the old path within float tolerance; ids order unchanged; invalid rows excluded. Long-task check: no task > 50 ms in the interim yielding version.
  - Risk: Visual only; small float rounding differences in galaxy coordinates.

- **[medium · memory-leak · ranking] Live embedding cache only grows: catalog vectors added by each Oracle compute are never evicted** `renderer-stores#17`
  - Where: `src/services/embedding-service.ts:2443`, `src/services/embedding-service.ts:1730`, `src/services/embedding-service.ts:2589`, `src/services/reco-store.ts:743`, `src/services/reco-store.ts:1760`
  - Problem: Kept after review. Each compute from the Oracle view adds candidate catalog vectors (about 8 KB each as number[]) to a module-level cache and nothing removes them. Pools overlap heavily, so it is not hundreds of MB per compute, but drift and removed games add a few MB per changed recompute, reaching tens to low hundreds of MB over a long active session.
  - Fix: Keep one Map plus a module-level catalogTierIds Set. Add ids to it when enrichWithCatalogEmbeddings or the generateMissing catalog injection inserts them; remove an id from the set whenever a library vector is written for it (sets at ~2657, 2695, 3140 and loadCachedEmbeddings). At the start of enrichWithCatalogEmbeddings(candidateIds), before fetching, delete from embeddingCacheRef and the set every catalog-tier id not in candidateIds and not pinned by recoHistoryStore.getThumbsDownIds()/getDismissals(). This is safe because reco-store copies vectors onto c.embedding right after the enricher returns. Do not switch to Float32Array in this change.
  - Tests: Two computes with disjoint pools: cache size after the second is library + pool 2 + pinned ids. Thumbs-down id outside the pool keeps its vector. Oracle golden output for a fixed fixture unchanged across two computes.
  - Risk: Negative-signal and buildCandidatePool reuse of cached vectors depend on what stays in the cache; pinning covers dismissals and thumbs-down, but any other reader of out-of-pool vectors would see a miss and refetch. Needs golden review.

- **[medium · memory-leak] Game graph keeps a second object-based copy of every edge, built synchronously on the main thread on restore and rebuild** `renderer-stores#11`
  - Where: `src/services/game-graph-store.ts:611`, `src/services/game-graph-store.ts:623`, `src/services/game-graph-store.ts:853`
  - Problem: After every graph restore or rebuild, _buildAdjacencyFromEdges turns the packed edge array into about 2 million small {id, weight} objects, held for the whole session (tens to about 100 MB) and built in one blocking task of several hundred ms. Only a few getNeighbors calls ever read it.
  - Fix: Delete _adjacency and both _buildAdjacencyFromEdges calls. Add `_csr: {offsets: Int32Array; nbr: Int32Array; w: Float32Array} | null`, reset to null wherever _edges is assigned (next to the _brokerSet/_maxPageRank resets). Build it lazily on the first getNeighbors from this._edges (not edgesRaw): degree count, prefix sum, fill both directions, sort each row by weight descending (stable, ties by neighbour index to match current order). getNeighbors looks up _idIndex, slices the row, returns the first k as {id: _nodeIds[j], weight}. Leave _edges order unchanged (edgeBetweenness is index-aligned).
  - Tests: For a fixture graph, getNeighbors(id, k) returns the same ids, weights and order as the old Map implementation for every node. After a rebuild the CSR is rebuilt. Heap snapshot / object count check optional.
  - Risk: Tie order in neighbour lists could differ if the old sort was not stable; the equality test guards it. Explainer and similar-games outputs only.
  - Coordinate with renderer-stores#19, renderer-stores#20, renderer-stores#27: All in game-graph-store build and persist (611-856). Change the edge representation before the persistence transaction.

- **[medium · performance] Sampled Brandes betweenness looks up every predecessor edge in a Map keyed by large doubles** `oracle#7`
  - Where: `src/workers/graph-metrics.worker.ts:302`, `src/workers/graph-metrics.worker.ts:328`, `src/workers/graph-metrics.worker.ts:489-500`
  - Problem: With about 1M edges and 300 samples, the innermost loop does a Map lookup on keys above the small-integer range for every predecessor relation, costing tens of seconds of worker CPU. This eats into the 5 minute graph-metrics timeout and delays the graph signal Oracle depends on; building the 1M-entry Map also takes tens of MB.
  - Fix: In buildCSR add csrEdgeIdx = new Uint32Array(totalSlots) with csrEdgeIdx[slotA] = csrEdgeIdx[slotB] = i per triple. Allocate predEdge as Uint32Array(edgeCount*2) next to predNode and write predEdge[slot] = csrEdgeIdx[k] when appending a predecessor (around line 302). In back-propagation use edgeBC[predEdge[slot]] += contrib. Delete the edgeIndexByPair construction (489-500) and its parameter. If duplicate triples are possible from any caller, keep first-seen index per pair in buildCSR.
  - Tests: Determinism test: edge betweenness output identical to the current implementation on a seeded random graph (fixed sample seed); benchmark on a ~150K-node K=10 graph.
  - Risk: Low. Edges are deduplicated upstream, so results are identical.

- **[low · performance] Graph build Phase A dedups edges through a Map keyed by template strings** `renderer-stores#27`
  - Where: `src/services/game-graph-store.ts:751`, `src/services/game-graph-store.ts:728`
  - Problem: Each graph rebuild creates about 1.5 million short strings as edge keys and parses them back, tens of MB of short-lived memory and GC on the main thread.
  - Fix: Use `const key = lo * nodeCount + hi` in a Map<number, number>; in the pack loop recover from = Math.floor(key / nodeCount), to = key - from * nodeCount. Optionally re-check heapPressureHigh() mid-phase.
  - Tests: Packed edges for a fixture are identical (same set, same weights, same order as Map insertion) before and after.
  - Risk: Very low; insertion order is preserved so edge order is unchanged.

- **[low · correctness] Graph persistence writes four keys in separate transactions and ignores errors, so restore can pair new node ids with old scores** `renderer-stores#19`
  - Where: `src/services/game-graph-store.ts:856`, `src/services/game-graph-store.ts:245`, `src/services/game-graph-store.ts:555`
  - Problem: If the app quits between graph writes, or a large write fails, the next launch restores the new node list with the previous build's scores and edges, so every game gets another game's PageRank and community until the ANN signature changes.
  - Fix: Write NODE_IDS, EDGES, SCORES then META in one readwrite transaction; resolve on oncomplete, reject on onerror and onabort. Phase C catches and logs, keeping the in-memory graph. In tryRestore (including the acceptStale path) treat as a miss: nodeIds.length !== meta.nodeCount, any of pageRank/community/degree lengths !== nodeIds.length, edges.length !== meta.edgeCount*3.
  - Tests: Fake IDB where SCORES put aborts: promise rejects, in-memory graph kept. tryRestore with mismatched lengths returns false.
  - Risk: Low; only damaged caches are rebuilt.

- **[low · correctness] ANN query failures during a graph build produce an edgeless or partial graph that is saved as ready** `renderer-stores#20`
  - Where: `src/services/game-graph-store.ts:738`, `src/services/game-graph-store.ts:698`, `src/services/ann-index.ts:320`, `electron/ipc/ann-handlers.ts:86`
  - Problem: ANN errors return an empty result that looks like 'no neighbours', so a build during an ANN hiccup or index swap is saved under the current signature with flat PageRank, degrading graph signals until the signature changes.
  - Fix: Without changing the IPC contract: in _doBuild count a batch as failed when entries.length > 0 and Object.keys(result).length === 0. After Phase A, re-check annIndex.isReady, !embeddingService.isAnnRebuilding and that the ANN signature still equals annSignature. If any check fails, more than ~5% of batches failed, or edgeSet.size === 0 with nodeIds.length > 1, call _failBuild('ANN query failed', {cooldown: true}) and return before the metrics worker and persistence.
  - Tests: Mock queryBatch to return {} for 10% of batches: build fails with cooldown and nothing persisted; previously loaded graph still serves. 1% failing: build completes.
  - Risk: Low.

### B33 Oracle pipeline performance (12)
_reco-store, reco-worker and system-status perf and cancellation, without score changes. Run before the ranking changes so the outputs can be compared._

- **[medium · performance] queryForCandidates streams the whole 155K-row Steam catalog into the renderer on every Oracle compute** `renderer-stores#15`
  - Where: `src/services/catalog-store.ts:935`, `src/services/catalog-store.ts:245`, `electron/ipc/store-handlers.ts`, `src/services/reco-store.ts:1608`
  - Problem: Each Oracle compute and refresh pulls about 75-100 MB of catalog rows over about 155 IPC hops into the renderer and filters them on the main thread, keeping at most about 25K.
  - Fix: Follow the catalog:queryUpcoming pattern. Move the admit, matched/popularOnly split, popular quota and sort-slice into a shared src/lib/candidate-selector.ts used by both processes. Add a 'catalog:queryCandidates' handler (preload binding and vite-env type) that validates and clamps args (maxResults <= 25k, maxPopularQuota <= 1000, bounded string arrays, excludeIds as string[]), reads chunks of 2000 with setImmediate yields, and is rate-limited under the getChunk bucket. Renderer uses it when window.store.queryCandidates exists, falling back to the shared selector over the existing scan. Optional: return only fields loadCatalogCandidates reads; memoize by catalog lastSync plus filter-input hash.
  - Tests: Golden test: for a fixture catalog and inputs, the main handler and the renderer fallback return identical ordered id lists, equal to the current implementation. Argument validation tests for the handler.
  - Risk: Result must stay byte-identical or Oracle pools change; the shared selector and equality test guard this. Up to 25K rows still cross IPC once.

- **[medium · performance] Every Oracle compute re-reads and deserializes the whole browse cache from IndexedDB on the main thread** `oracle#5`
  - Where: `src/services/reco-store.ts:1264`, `src/services/reco-store.ts:2283-2305`
  - Problem: Each compute (first open, every library change, thumbs-up, undo) opens the browse cache directly and deserializes 3K-6K full game objects on the UI thread, causing a jank spike of tens to hundreds of ms. The same games are already in memory in prefetch-store, so this also keeps a second full copy alive in lastBrowseRows.
  - Fix: In buildCandidatePool use `rawGames = getPrefetchedGames()` when it is non-null and non-empty (pass by reference, rows are read-only), falling back to loadBrowseCacheGames() only on a cold start before prefetch hydrates. Point this.lastBrowseRows at the same reference, or clear it after applyPoolHygiene. Do not route the fallback through the idb-cache worker (postMessage still deserializes on the main thread). If the fallback runs, close the db when the 8 s timeout fires. Do not add longDescription to the worker's STRIP_KEYS, since the adult filter reads it.
  - Tests: Tests for both paths: prefetched list present -> no indexedDB.open call and same candidate pool as the IDB path for the same data; prefetch null -> IDB fallback still used with the 7-day TTL.
  - Risk: Low-medium. Confirm the prefetched list has the same rows and fields as the raw cache row (it is deduped); if it differs the candidate pool could shift slightly.

- **[medium · performance] Graph-signal pre-pass scans the whole library for every candidate** `oracle#6`
  - Where: `src/services/reco-scoring.ts:607`, `src/workers/reco.worker.ts:369-373`, `src/workers/reco.worker.ts:416`
  - Problem: computeGraphSignal loops over every library game and its similar-title set for each of about 3000 candidates, roughly 100M hash probes, adding 1-2 s to every compute with no progress shown. A comment claims an early exit after 3 matches that does not exist.
  - Fix: In buildGraphUserContext, from games with weight > 0 only, build similarIdx (similarKey -> ugIndex[]), titleIdx (titleKey -> ugIndex[]) and each game's position in the weight-sorted userGames. Per candidate, fill a Map<ugIndex, strength> keeping the max: similarIdx.get(candidateKey) -> 1.0; for each candidate similar key k, titleIdx.get(k) -> 0.8 and similarIdx.get(k) -> 0.4; merge neighbour strengths with max. Emit contributions in ascending userGames order before the stable sort, so ties and similarTo stay identical. Fix the misleading comment at reco.worker.ts:369-373.
  - Tests: Equivalence test: old vs new computeGraphSignal over randomized fixtures produce identical scores and similarTo arrays; existing reco-graph.test.ts passes unchanged; perf test with 3K x 3K is well under the old time.
  - Risk: Medium: tie ordering must be preserved exactly or similarTo/explanations change. Covered by the equivalence test.

- **[low · memory-leak] RecoStore.lastBrowseRows keeps a full duplicate copy of the browse rows alive between computes** `renderer-stores#26`
  - Where: `src/services/reco-store.ts:1269`, `src/services/reco-store.ts:1432`, `src/services/reco-store.ts:1436`, `src/services/reco-store.ts:683`
  - Problem: Each compute stores the whole browse cache read from IndexedDB (3K-6K games with descriptions and media) on the singleton for the hygiene check, and never lets it go, holding several to tens of MB for the session. A compute that overran its deadline can also leave the previous compute's rows for the hygiene check.
  - Fix: Remove the field. In compute create a holder `{ rows: [] }` passed to buildCandidatePool, which sets it; call hygienePool(poolSink.slice(), userGames, holder.rows). Better: buildCandidatePool builds a small Map<id, {summary, longDescription}> only for rows hasAdultHintTags flags when adult content is off, and drops rawGames after the loop and cold-start seed selection.
  - Tests: Hygiene still filters an adult-flagged candidate using its description. After compute, no reference to browse rows on recoStore (field removed). Deadline overrun does not leak rows into the next compute.
  - Risk: Low. Hygiene input is identical in the normal path.

- **[low · performance] Library snapshots and MMR sketches sent to the worker are bloated (full 1024-d embeddings, boxed arrays)** `oracle#9`
  - Where: `src/services/reco-store.ts:953`, `src/services/reco-store.ts:1106`, `src/services/reco-store.ts:1141`, `src/services/reco-store.ts:1152`, `src/services/reco-store.ts:1185`, `src/services/reco-store.ts:883`, `src/services/reco-store.ts:2628`, `src/workers/reco.worker.ts:1205`, `src/workers/reco.worker.ts:688-699`, `src/types/reco.ts:365`
  - Problem: userGames are posted to the worker with full 1024-number embeddings, so a 2-3K game library means millions of numbers cloned on the main thread at dispatch (tens to 100+ ms) and duplicated in the worker, which only needs them for the Backlog Advisor. Candidate MMR sketches are also converted to plain number arrays for all ~3K candidates though only the top 500 are read; this part costs only a few ms.
  - Fix: Before building the worker input, compute the backlog semantic similarity on the main thread (tasteCentroid and vectors are already there) and pass backlogSemanticScores: Record<gameId, number>; have reco.worker.ts:1205 read it first and fall back to computeSemanticSimilarity. Then send `userGames: clusterScoringEnabled ? userGames.map(({ embedding: _e, ...rest }) => rest) : userGames` (shallow copies, main-thread snapshots untouched). For sketches, store the Float32Array directly (`mmrVectors[c.gameId] = sketch`) and widen the type to Record<string, ArrayLike<number>> in src/types/reco.ts:365 and reco-store.ts:848; check mmrRerank accepts ArrayLike.
  - Tests: Worker test: backlog-advisor ordering and reasons identical with precomputed scores vs current in-worker computation; MMR output identical with Float32Array sketches; update oracle-rerank-r7.test.ts:218 types if needed.
  - Risk: Low. Values are computed from the same data; risk is only a missed field used by the worker.

- **[low · performance] Library-neighbour pass is not cancellable and recomputes candidate norms for every source** `oracle#10`
  - Where: `src/services/reco-store.ts:827-829`, `src/services/reco-store.ts:1020`, `src/services/reco-scoring.ts:1414-1426`
  - Problem: computePoolNeighborsAsync calls computePoolNeighbors once per source, rebuilding the pool and recomputing every candidate's vector norm 32 times, about double the needed work. It also supports a stop callback that is never passed, so after a refresh or timeout the superseded loop keeps running and holding the old embedded pool (about 3K x 1024 numbers) until it finishes, typically under a second or a few.
  - Fix: In reco-scoring.ts extract buildPool(candidates, dim) and neighborsForSource(src, pool, dim, opts, out); have both computePoolNeighbors and computePoolNeighborsAsync build the pool once (dim from sources[0], empty result if no sources, same order) and loop sources; check shouldStop before building the pool. In reco-store add a shouldStop parameter to computeLibraryNeighbors, forward it as opts.shouldStop, and call `runWithDeadline((s) => this.computeLibraryNeighbors(userGames, candidates, scoringNow, () => s.aborted || isStale()), ...)` at line 828.
  - Tests: Existing sync-vs-async equality test in perf-1-0-96.test.ts must still pass bit for bit; new test that an aborted signal stops the loop at the next source boundary.
  - Risk: Low. Arithmetic and iteration order unchanged.

- **[low · performance] Pool hygiene and pre-filter run as one long synchronous task; title key normalised twice** `oracle#11`
  - Where: `src/services/reco-store.ts:683`, `src/services/reco-store.ts:705`, `src/services/reco-prefilter.ts:111`, `src/services/reco-prefilter.ts:132`
  - Problem: Hygiene and pre-filter over ~25K candidates run back to back with no yield, freezing the UI for several hundred ms during 'Pre-filtering candidates...'. dedupeCandidatesByTitle runs the expensive title normalisation twice per candidate.
  - Fix: (1) In dedupeCandidatesByTitle compute normalizeTitleKey once per candidate into a Map/array and reuse it in the final filter; push losers into one array per key instead of re-spreading. (2) In applyPoolHygiene test genres and themes directly instead of spreading them into a new array. (3) In reco-store add `await new Promise(r => setTimeout(r, 0)); if (isStale()) return;` between hygienePool and preFilterPool. Keep preFilterCandidates synchronous and its same-array-when-small contract.
  - Tests: Dedupe output identical for a fixture with duplicate titles; compute still returns early when stale after the yield.
  - Risk: Low.

- **[low · memory-leak] Background Oracle rerank is not cancelled by refresh()/reset()** `oracle#13`
  - Where: `src/services/reco-store.ts:2430`, `electron/rerank-engine.ts`
  - Problem: The background Qwen3 rerank has no parent abort signal, so after a refresh or reset it keeps sending one Ollama request per document until its own deadline (up to 60 s), competing with the new compute's embedding and ML calls.
  - Fix: Add `private rerankAbort: AbortController | null` to RecoStore. In rerankShelvesInBackground abort any previous controller and create a new one; pass its signal to runOracleRerankPass and on as the parent argument of runWithDeadline. Check signal.aborted after `await prepareOracleRerank()`. Abort and null it in abortInFlightCompute() (covers refresh() and reset()). Do not abort in invalidateCacheOnly(). Pass an abort reason so a superseded run is not recorded as 'skipped_timeout' in recordRerankRun.
  - Tests: Store test: start a rerank with a slow mocked rerank IPC, call refresh() -> cancelRerankRequest is called and no 'skipped_timeout' is recorded; invalidateCacheOnly() does not cancel.
  - Risk: Low.

- **[low · performance · ranking] Thumbs-up reruns the entire pre-worker Oracle pipeline** `oracle#19`
  - Where: `src/components/oracle-view.tsx:940`, `src/components/oracle-view.tsx:2014`
  - Problem: Each thumbs-up triggers a full recompute (catalog stream, retrieval, hygiene, metadata, ML, graph, neighbours) although only the worker's feedback inputs change, so rating several games repeats seconds of main-thread work each time.
  - Fix: Thumbs-up only (keep undo-dismiss and thumbs-down on full refresh). Keep the last dispatched RecoWorkerInput with its computeGeneration, library signature and timestamp. Add recomputeThumbsUpOnly(): fall back to refresh() if no cached input, signature differs, age > RESULT_CACHE_TTL or a compute is in flight; else re-read thumbsUpIds, rebuild feedbackCandidates via resolveFeedbackCandidates, refresh now/currentHour, killWorker() and runWorker(patchedInput, ++computeGeneration) with existing cacheEpoch handling. Release the cached input when the result TTL passes to bound memory.
  - Tests: Store test: thumbs-up with an unchanged library re-dispatches the worker without calling buildCandidatePool; with a changed signature it calls refresh(); final results match a full refresh on the same data.
  - Risk: Medium: two code paths for the same result; stale pool if the catalog changed in between. Keep the TTL and signature guards.

- **[low · correctness] Status panel elapsed timers never reset (Recommendation Engine, reranker setup)** `oracle#21`
  - Where: `src/services/system-status.ts:575`, `src/services/system-status.ts:562-570`, `src/services/system-status.ts:274`, `src/services/system-status.ts:357`
  - Problem: The Recommendation Engine timer starts once per session, so a 5 s recompute shows e.g. '47m 12s', and it keeps growing while idle. The reranker setup timer has the same issue for later model pulls.
  - Fix: Reco: keep _recoPipelineStartTime/_recoPipelineEndTime and the previous status; on transition into 'computing' set start = now, end = 0; on 'done'/'error' set end = now. In getSnapshot: computing -> now - start; done -> computeTimeMs if > 0 else end - start; error -> end - start; idle -> 0. Rerank: in reportRerankProgress and reportRerankDone use `if (_rerankSetupStartTime === 0 || _rerankSetupStatus.stage === 'done' || _rerankSetupStatus.stage === 'error') _rerankSetupStartTime = performance.now();`. Ollama setup runs once per session; apply the same guard only for symmetry.
  - Tests: system-status test with mocked performance.now: second compute reports its own elapsed; idle reports 0; a second rerank pull after 'done' starts from its first event.
  - Risk: Very low; display only.

- **[medium · earlier review] Pool-neighbour step times out in a hidden window (v1.0.96 regression)**
  - Where: `src/services/reco-scoring.ts:1429`
  - Fix: Yield by elapsed time (~8 ms) instead of once per source.

- **[low · earlier review] Saved Oracle telemetry not restored on cache hit**
  - Where: `src/services/reco-store.ts:627`
  - Fix: Restore cached.telemetry in the cache-restore branch.

### B34 Oracle ranking and explanation changes (13)
_Changes to ranking and shelf contents go last, after B10 (auto-hold), B20 (dates) and B33, so differences in recommendations can be measured on their own._

- **[medium · correctness · ranking] Partial ML scoring run leaves raw, un-normalised probabilities on candidates** `oracle#0`
  - Where: `src/services/reco-store.ts:2226`, `src/services/reco-store.ts:2245`, `src/services/reco-store.ts:2251`, `src/services/reco-store.ts:2260-2265`, `src/services/reco-store.ts:777`, `src/workers/reco.worker.ts:424-430`, `src/workers/reco.worker.ts:563`
  - Problem: ML scores are written onto the shared candidate list batch by batch, but the percentile step only runs after the last batch. If the 30 s ML deadline (or the shared pre-worker budget) fires between the two batches, or a later batch fails, the first batch keeps raw probabilities and the rest have none. The worker then treats these raw values as percentiles, fills the gaps with their median, and the ML layer is compressed and on mixed scales for that run.
  - Fix: In applyMLScores, collect batch results into a local array/Map of {idx, score, synthetic} and do not touch candidates inside the loop. Keep the existing `if (signal?.aborted) return;` checks (they now just drop the local data). After the loop, check signal?.aborted once more; if not aborted, percentile-rank the real and synthetic subsets separately (existing shrink for synth), write mlScore and mlSynthetic onto candidates in one synchronous pass, then set _mlScoringAvailable = true. On abort, never write partial results (the pipeline has already moved on). On the catch path (a batch rejected before the deadline) either write nothing or normalise the collected subset only if the signal is not aborted.
  - Tests: Unit test applyMLScores with a mocked scoreGames: (1) abort after batch 1 -> no candidate has mlScore/mlSynthetic set; (2) batch 2 rejects -> no raw scores left on candidates; (3) normal completion -> all mlScore values in 0..1 percentile range, identical to current output.
  - Risk: Low. Normal-completion output is unchanged; only the timeout/error path now yields 'no ML signal' instead of a corrupt one.

- **[medium · correctness · ranking] Engagement scores are computed from stale cache entries and an outdated engagement classifier** `oracle#1`
  - Where: `src/services/reco-prefilter.ts:234`, `src/services/reco-store.ts:705`, `src/services/reco-store.ts:821-822`, `src/services/reco-store.ts:1008`, `src/services/reco-store.ts:1206`, `src/workers/reco.worker.ts:216`, `src/workers/reco.worker.ts:233`, `src/workers/reco.worker.ts:241-245`
  - Problem: Engagement scores are cached per game id in a module-level map. On the main thread the pre-filter runs before that cache is cleared, so it reuses last run's scores: a game the user just rated 1 star can still count as a positive and keep its studio 'loyal'. The snapshots also carry a label from the store's old classifier, which calls any 3-sessions-in-3-days run 'binge-drop' (x0.6) even for completed games. The main-thread taste clusters and neighbour sources use that label, and in the worker the taste profile is built and cached before the label is corrected, so the corrected label never takes effect for the profile, graph weights or 'Because you loved' seeds.
  - Fix: 1) In reco-store compute(), call _engagementCache.clear() once at the start of the non-cached path, before preFilterPool (line 705), and use one scoringNow for the whole run (pass it to the pre-filter as well); the clear at line 821 can then be dropped. 2) In buildUserGameSnapshots, build each snapshot first, then set snapshot.engagementPattern = classifyEngagementCurve(snapshot), and delete the private RecoStore.classifyEngagement. 3) In reco.worker.ts runPipeline, move the reclassification loop (243-245) to before _engagementCache.clear() / buildTasteProfile and before the early return at line 236, and drop the stale comment. 4) Bump ORACLE_ENGINE_VERSION (currently 14) so cached shelves built with old weights are recomputed.
  - Tests: (a) Two consecutive computes where a 40h game is re-rated to 1 star between them: the second pre-filter treats it as weight 0 and its studio is no longer loyal. (b) A Completed game with 3+ sessions in 2 days gets the same engagement score from detectTasteClusters on the main thread and from the worker's taste profile. (c) The worker's early-return path (no filtered candidates) builds its profile with the shared label. Re-run Oracle golden tests and review diffs.
  - Risk: Medium for ranking: weights for binge-completed games rise and recently re-rated games drop, so shelf contents and cluster labels will shift. Needs a golden review and the engine version bump.

- **[medium · correctness · ranking] Removed games still appear in Unfinished Business, Finish-and-Try and Backlog Advisor shelves** `oracle#2`
  - Where: `src/workers/reco.worker.ts:1106`, `src/workers/reco.worker.ts:1129-1130`, `src/workers/reco.worker.ts:1183-1187`, `src/services/reco-store.ts:1074-1143`
  - Problem: Removing a game only marks the journey entry with removedAt, and the snapshot falls back to the journey status. The worker's library shelves never check removedAt, so a removed 'Want to Play' game shows up in Backlog Advisor and a removed 'Playing' game in Unfinished Business, with an 'Add to Library' offer.
  - Fix: Add `&& !g.removedAt` to the onHoldGames filter (line 1106, which also feeds the 'Finish X, then try' seed), the unfinished filter (1130) and the backlogCandidates filter (1184-1187). Do not drop removed games in buildUserGameSnapshots, because the negative profile and candidate exclusion still need them.
  - Tests: Worker test with fixture 'steam-90' (removedAt set, status On Hold, src/test/oracle/fixtures.ts:152): it is not in unfinished-business, not the finish-and-try seed, and a removed Want to Play game is not in backlog-advisor.
  - Risk: Low. Only removes games the user deliberately removed from library shelves.

- **[medium · correctness · ranking] Oracle does not react to the 'Allow adult content' toggle** `oracle#3`
  - Where: `src/services/reco-store.ts:2769-2773`, `src/hooks/useAllowAdultContent.ts:16`, `src/hooks/useAllowAdultContent.ts:29`
  - Problem: Adult titles are filtered only when Oracle computes. Turning adult content off after a compute leaves adult games on the shelves for the rest of the session, because nothing subscribes Oracle to that setting and re-opening Oracle sees status 'done'.
  - Fix: Export the existing module-local subscribe function from useAllowAdultContent.ts (e.g. `export const subscribeAllowAdultContent = subscribe;`). In reco-store.ts next to the libraryStore/customGameStore subscriptions (line 2771-2772), add `subscribeAllowAdultContent(scheduleOracleInvalidateOnLibraryChange);`. The signature already contains the A: line, so the debounced diff triggers recoStore.refresh() only when the setting actually changed and only after a first compute. Optional: while the refresh runs (stale-while-revalidate), have OracleView filter displayed items with the same tag/description check when the setting is off.
  - Tests: Store test: after a compute with adult ON, flip to OFF -> refresh() is called once after the debounce; flip ON then OFF within the window -> no refresh; flip before any compute -> no refresh.
  - Risk: Low. Reuses the existing debounce and signature path; no circular import (reco-store already imports this module).

- **[medium · correctness · ranking] Library-backed Oracle shelves treat owned games as candidates (dismiss mutes whole franchise; heart creates phantom entries)** `oracle#4`
  - Where: `src/components/oracle-view.tsx:1993`, `src/components/oracle-view.tsx:2014`, `src/components/oracle-view.tsx:1234`, `src/workers/reco.worker.ts:1124`, `src/workers/reco.worker.ts:1164`
  - Problem: Unfinished Business and Backlog Advisor list the user's own games, but their cards behave like recommendations. Clicking X or thumbs-down on, say, Hades records a dismissal with title and developer, which hides Hades II and every Supergiant game from other shelves and excludes them from future candidate pools for days. The cards are also always rendered as not in library; on a custom game the add action writes a second 'Want to Play' library entry under the custom id, which then overrides the real game's status and hours in later snapshots.
  - Fix: In OracleView: for library-backed rows (shelf.type 'unfinished-business' or 'backlog-advisor', or libraryStore.isInLibrary(gameId) / custom game id): (1) in handleDismiss call recoHistoryStore.dismiss(gameId, {}) with no title/developer so only that card is hidden (or skip franchise/developer expansion for library ids in the expandHardNegativeIds caller); (2) hide thumbs-down in WhyPanelBody; (3) in OracleCard.handleAddToLibrary return early for ids starting with 'custom-', ids the custom game store owns, ids already in the library, and for those two shelf types pass onAddToLibrary={undefined}; (4) do not simply pass isInLibrary=true, because the GameCard menu would then show NOOP Edit/Remove items; instead have GameCard omit the Add item when onAddToLibrary is absent. Optional defence: libraryStore.addToLibrary rejects custom-* ids. Hide the match badge only when score is 0 and matchPct is undefined (Unfinished Business).
  - Tests: Component tests: dismissing a library game on Unfinished Business stores no title/developer and does not hide a same-franchise card on another shelf; thumbs-down is not rendered for library games; add-to-library on a custom-N card does not call libraryStore.addToLibrary.
  - Risk: Low-medium. Existing stored library dismissals keep their franchise mutes until they expire; UI change in GameCard menu must not affect other screens.

- **[low · correctness · ranking] Backlog Advisor items mislabelled as franchise matches and given inflated semantic and empty genre reasons** `oracle#14`
  - Where: `src/workers/reco.worker.ts:1205`, `src/workers/reco.worker.ts:1216`, `src/workers/reco.worker.ts:1241`, `src/workers/reco.worker.ts:1245`, `src/services/reco-explainer.ts:120`
  - Problem: A backlog game that only shares a loyal developer is explained as 'continues a franchise you already follow'. The 'Strong semantic match' reason uses a raw cosine with a 0.3 threshold, so it appears on nearly every game, and the genre chips are empty while the text says 'Matches N of your top genres' because raw genres are compared to canonical names.
  - Fix: In the backlog block: set franchiseBoost: 0 and studioLoyaltyBoost: devMatch * 0.15 (do not credit a publisher-only match to the developer-named headline); gate the semantic reason on SEMANTIC_EXPLAIN_MIN (0.5) instead of 0.3; build sharedGenres as in line 551 (map via toCanonicalGenre, keep those in the profile set, dedupe) and derive genreOverlapCount from that same list.
  - Tests: Worker test: a backlog game with only a developer match has franchiseBoost 0 and no franchise headline; a game with cosine 0.35 gets no 'strong semantic' reason; sharedGenres length equals the count in the reason text.
  - Risk: Low; explanation text and layer scores in results change, so bump ORACLE_ENGINE_VERSION together with the engagement fix.

- **[low · correctness · ranking] Publisher-loyalty matches are explained as coming from a trusted developer** `oracle#15`
  - Where: `src/workers/reco.worker.ts:152`, `src/services/reco-scoring.ts:820`, `src/services/reco-explainer.ts:124`, `src/services/reco-explainer.ts:274`
  - Problem: A game matched only through a loyal publisher (e.g. Devolver) is described as 'from Croteam, a studio you trust', naming a developer the user may never have played.
  - Fix: Export matchedLoyalStudio(candidate, loyalDevelopers, loyalPublishers): {role, name} | null from reco-scoring.ts using the same splitCreditedNames and developer-first order, and make computeStudioLoyaltyBoost a thin wrapper over it. In generateExplanation call it and use publisher wording ('published by X, a label you trust') when role is 'publisher'. In reco-explainer, where no profile is in scope, use boost >= 0.35 as developer match, otherwise word it with game.publisher. No new result field needed.
  - Tests: Explanation test: publisher-only match names the publisher; developer match keeps current wording; computeStudioLoyaltyBoost values unchanged.
  - Risk: Low. Text only; scores unchanged.

- **[low · correctness · ranking] Engagement-curve bonus is driven by rejected games** `oracle#16`
  - Where: `src/workers/reco.worker.ts:376`, `src/workers/reco.worker.ts:535`
  - Problem: A game rated 1 star or removed but played over months still gives a 'long-tail' curve bonus of up to 0.4 to every candidate sharing its genres; all other positive layers skip rejected games.
  - Fix: Next to the ugGenreNorms precompute (~line 376) build `const curveGames = userGames.filter(ug => CURVE_MULTIPLIERS[ug.engagementPattern || 'unknown'] > 1.1 && computeEngagementWeight(ug) > 0)` with their genre norms, and loop over curveGames at line 535. Optionally also skip computeNegativeWeight(ug) > 0.
  - Tests: Worker test: a 1-star long-tail game gives no curve bonus to a same-genre candidate; a positive long-tail game still does.
  - Risk: Low; ranking shifts for libraries with rejected long-played games.

- **[low · correctness · ranking] Auto-held games under 2 h are treated as rejections** `oracle#17`
  - Where: `src/services/engagement-weight.ts:69`, `src/workers/reco.worker.ts:386`
  - Problem: When the idle sweep automatically puts a 0-2 h game On Hold, its positive weight drops to 0 and its genres are marked rejected (excluded from Stretch Picks, taste profile, BM25 and ML seeds), although the negative-weight path deliberately treats an automatic hold as not a user signal.
  - Fix: Change line 69 to `if (game.status === 'On Hold' && !game.autoHeld && game.hoursPlayed < 2 && game.rating < 3) return 0;`. Preferably extract an isBounceOff(game) helper shared with computeNegativeWeight, and update the doc comment. Optionally make rejectedGenresNorm key on computeNegativeWeight > 0 only.
  - Tests: Next to status-source.test.ts:32: autoHeld On Hold 0 h game scores UNPLAYED_ENGAGEMENT_WEIGHT; 1 h autoHeld scores > 0; manual On Hold < 2 h still 0.
  - Risk: Low; ranking shifts for users with auto-held games.

- **[low · correctness · ranking] Clusters with the same top genre create duplicate 'For your X side' shelves** `oracle#18`
  - Where: `src/workers/reco.worker.ts:899`, `src/services/reco-scoring.ts:1167`
  - Problem: In genre-heavy libraries several taste clusters share a top genre, so the user sees two identical 'For your Action side' shelves; they share a shelf key, so bandit ranking and interaction tracking merge them.
  - Fix: In buildShelvesFromScored keep a Set of normalised labels already used for for-your-mood shelves. On a collision, try the cluster's next-strongest genre or theme from cluster.profile that is unused (use it for both the title and the matchesMoodShelf filter); if none, skip the cluster. Do not skip clusters just because the label equals profile.topGenre, and do not add cluster.id to the shelf key (ids are unstable).
  - Tests: Worker test with two clusters both topGenre 'Action': shelf titles and oracleShelfKey values are unique.
  - Risk: Low; shelf titles/contents change for affected users.

- **[low · correctness] Cached result is stamped with the library signature at save time, not compute start** `oracle#20`
  - Where: `src/services/reco-store.ts:431`, `src/services/reco-store.ts:2765`
  - Problem: The cache signature is recomputed when results are saved, up to 60 s after the compute started, so changes made in between (hours changes, a quit inside the debounce) are baked into shelves that predate them, and a restart can restore outdated shelves.
  - Fix: In compute(), next to markOracleLibraryBaseline(), store the signature on the instance (this.computeLibrarySignature; have markOracleLibraryBaseline return it). In saveResultsToCache write librarySignature: this.computeLibrarySignature ?? buildOracleLibrarySignature(). Do not read the module-level oracleLibrarySnapBaseline at save time (the debouncer overwrites it). The cache-restore path keeps cache.librarySignature. The adult toggle part is covered by the adult-toggle item.
  - Tests: Store test: change library between compute start and save -> saved signature equals start signature, so the next launch misses the cache.
  - Risk: Low; only adds correct cache misses.

- **[low · correctness] Score breakdown lists 'Negative Signal' as a positive contributor** `oracle#22`
  - Where: `src/services/reco-explainer.ts:160-180`
  - Problem: The negative-signal layer is stored as a positive number and subtracted later, but normalizeLayerScores counts it as a positive layer, so the Why drawer shows e.g. 'Negative Signal 9%' as if it raised the match and shrinks the real contributors' percentages.
  - Fix: Define PENALTY_LAYERS = new Set(['negativeSignal']) (also exclude the multiplicative trajectoryMultiplier if present) and skip them when computing positiveSum and the positive list. If the penalty should stay visible, return it separately and render it in oracle-view as a red '-X% penalty'.
  - Tests: reco-r5 normalizeLayerScores test: with negativeSignal > 0 it is not in the positive list and the percentages total about 100.
  - Risk: Very low; display only.

- **[medium · earlier review] Deals For You marks never-discounted full-price games as "all-time low"**
  - Where: `src/workers/reco.worker.ts:958`
  - Fix: Require an actual discount before setting atHistoricalLow.

### B35 AI router: bundled LiteLLM for chat, embeddings and reranking (user decision + finalized Settings design)
_Done after B13 (key storage) and B12 (chat engine). Ships in 1.0.97 (single release). The finalized design (B37, "AI providers" board `RCore.dc.html` in C:\Users\100003~1\AppData\Local\Temp\claude\C--Claude-Session\c57202bc-f44c-4eeb-b379-2eca11362dd4\scratchpad\settings-design) makes LiteLLM the router for all three roles; this batch builds the engine behind it, B37 builds the screen._

- **Runtime:** a pinned, embeddable CPython for Windows x64 (python-build-standalone) plus LiteLLM installed at build time from a lock file with `--require-hashes` (exact versions, hashes reviewed; check LiteLLM's PyPI security advisories before pinning). Shipped under `extraResources/litellm-runtime/`, excluded from asar. Build script `scripts/build-litellm-runtime.mjs`, cached in `.litellm-cache/` (gitignored).
- **Sidecar:** `electron/litellm-sidecar.ts` starts `python -I resources/litellm-runtime/ark_litellm.py`: LiteLLM's OpenAI-compatible server on `127.0.0.1`, random free port (never 11434, never the B36 ports), per-launch random master key, config generated by Ark from the user's connectors and routes (temp file readable only by the user, deleted on exit; keys passed via environment, never in the file, argv or logs). Health check, restart with backoff (max 3), killed on quit/crash (job object), regenerated and restarted when routes change.
- **Connectors** (main-side store, `electron/ai-router/connectors.ts`): Built-in (llama.cpp, B36, default for all three roles), Ollama (user URL), Gemini, Azure OpenAI (endpoint, deployment, API version), Anthropic, OpenAI, and "OpenAI-compatible server" (name, base URL, optional key, which roles it serves). Keys encrypted with safeStorage in main (has/set/clear/test, no getter); existing Gemini/Azure/Anthropic keys migrated once from today's storage.
- **Routes:** one per role (chat, embeddings, reranker), each `{connectorId, model}` plus the design's "When a route fails" policy, timeout and retries. Chat goes through LiteLLM as `ChatOpenAI` (`@langchain/openai`) with the master key; embeddings via `/v1/embeddings`; reranking via LiteLLM's rerank endpoint. A role only offers connectors that can serve it.
- **Resilience for the Oracle:** if the sidecar is down, embeddings and reranking fall back directly to the built-in llama.cpp servers (same model, same vectors), so the Oracle never depends on Python being healthy; chat shows the router error. Logged and shown as a router fault (design `StatesCore`).
- **Embedding model change:** switching the embeddings route to a different model triggers the design's "Embedding model changed, rebuild" flow; Ark keeps the old vectors until the rebuild finishes (`EMBEDDING_MODEL_VERSION` keyed per model id).
- **Connection tests:** per connector and "Test all": result, latency, model tested; scheduled re-check (default 30 min) only for armed connectors; "Test when a key is saved"; a connector stays unrouted until a test passes (design states).
- **verify-release.mjs:** runtime present, lock file hash matches, no key material packaged.
- **Tests:** sidecar manager with a fake child process (start, health, restart cap, kill on quit, config regeneration, env-only keys, no keys in logs or config file); connector store and migration; route resolution and fail policy; Oracle fallback when the sidecar is down; IPC validators. Manual: real Anthropic key chat with a tool call; embeddings and rerank through the router with built-in llama.cpp; quit while streaming.
- **Risk:** highest in this release: a new process on the Oracle's path (mitigated by the direct fallback), installer size, Python supply chain, corporate AV possibly flagging an unsigned `python.exe`. A failing packaged smoke test blocks the release until fixed.

### B36 Built-in local AI: llama.cpp runtime + runtime model downloads (new feature, user decision)
_Done after B11 (Ollama runtime fixes), B15/B32 (ANN, embedding service) and B35 (sidecar pattern). Ships in 1.0.97._

Facts checked 2026-10-30: Ollama for Windows is 1.5 GB (ollama-windows-amd64.zip), too big to ship or to re-download with every update. llama.cpp's Windows Vulkan build (llama-bNNNNN-bin-win-vulkan-x64.zip) is ~36 MB and includes the CPU backends, so it runs on NVIDIA, AMD and Intel GPUs or on CPU alone. Hugging Face is reachable from this network.

- **Runtime in the installer:** pinned llama.cpp release (exact build tag, sha256 recorded in `electron/local-ai/runtime-manifest.json`), Vulkan x64 zip unpacked by `scripts/build-llama-runtime.mjs` into `extraResources/llama-runtime/` (cached in `.llama-cache/`, gitignored). Only `llama-server.exe` and its DLLs. Installer grows by ~36 MB. The MIT licence file ships alongside.
- **Models downloaded on the splash screen** into `%LOCALAPPDATA%\Ark\models` (not roaming; survives updates; `userData` setting for a custom folder):
  - Auto (Oracle): snowflake-arctic-embed2 (~1.2 GB), bge-reranker-v2-m3 (~1.2 GB), Qwen3-Reranker-0.6B Q8_0 (~0.6 GB).
  - Optional (local chat): gemma3:12b (~8 GB), only after the user picks local chat, with a size prompt.
  - Source: the exact GGUF files Ollama users already have, fetched by digest from the Ollama model registry (manifest → blob), so embeddings stay in the same vector space as the vectors cached today (no re-embed). Hugging Face GGUF repos are the fallback source. Every file pinned by sha256 in the manifest and verified before use; `.part` + resume through `electron/resumable-download.ts`; progress, pause/resume, disk-space check before starting, clear errors (offline, blocked, disk full) with "Retry" and "Continue without local AI".
  - Splash never blocks the app: Oracle runs without embeddings until the models are ready (today's degraded path), then fills in.
- **Process manager** `electron/local-ai/llama-runtime.ts`: one `llama-server` per role, started lazily: embed (`--embedding --pooling cls`), rerank (`--reranking`), chat (`--jinja` for tool calls; only when used). Each binds `127.0.0.1` on a free port picked from a private range (default base 47410, never 11434), with a per-launch random `--api-key`; ports are never written where another app reads them. GPU layers via `-ngl` with automatic CPU fallback on Vulkan/out-of-memory errors (reuses the existing OOM step-down logic). Health check, restart with backoff (max 3), idle unload (chat after 10 min, embed/rerank after 30 min), all killed on quit and on crash (Windows job object so no orphans). No tray, no autostart, no PATH or registry changes, no service install.
- **Backend abstraction** `electron/local-ai/backend.ts`: `embed(texts)`, `rerank(query, docs)`, `chatModel()` with two implementations — built-in llama.cpp (default) and external Ollama (advanced setting "Use my own Ollama at URL…", off by default). `ollama-setup.ts`, `ollama-handlers.ts`, `rerank-engine.ts`, `embedding-service` and `ai-chat.ts` call the backend instead of `http://localhost:11434`; hard-coded 11434 defaults removed. Chat via `ChatOpenAI` (`@langchain/openai`) pointed at the chat server's OpenAI-compatible endpoint.
- **Vector parity gate:** a test embeds a fixed set of game texts with the built-in runtime and compares with Ollama's output recorded once in a fixture; cosine ≥ 0.999 for every row keeps `EMBEDDING_MODEL_VERSION`; if it fails, bump it (one re-embed on first launch, said in the release notes) and the Oracle golden test is reviewed.
- **Settings → AI Models:** "Built-in local AI" status (runtime version, GPU/CPU, each model: ready / downloading x% / missing, disk used), buttons: Download chat model, Remove models, Change folder, Re-check. The Ollama section becomes "Advanced: use my own Ollama". Copy: Ollama no longer needs installing. Guided tour and splash text updated.
- **Migration:** users who already use Ollama keep working: on first 1.0.97 launch Ark switches to the built-in runtime and downloads models (it never reads or changes the user's Ollama models folder); their cached embeddings stay valid if the parity gate passed.
- **verify-release.mjs:** runtime folder present, file hashes match the manifest, no model files packaged.
- **Tests:** manifest/hash checks, download + resume + checksum failure (local http server), port picking that skips busy ports and never 11434, process manager with a fake child (lazy start, health, restart cap, idle unload, kill on quit), backend switching, IPC validators, settings UI states, splash progress. Manual on a copied profile: fresh install with no Ollama, offline first launch, GPU and CPU-only machines, user's Ollama running on 11434 at the same time (both work, neither sees the other).
- **Risk:** high (new process type, large first-run downloads, GPU driver differences, embedding parity). Corporate AV may flag unsigned `llama-server.exe` (code signing is out of scope by decision). Gate: the packaged smoke test above must pass before the release ships.

### B37 Settings redesign: "Tracker Settings Page" design (user-finalized, Claude Design)
_Done last, after B35/B36 (it is the screen for both). Source: Claude Design canvas "Tracker Settings Page" (https://claude.ai/artifact/QAXfRDxKA2SA3x8GjADhuc); local copy of every board in C:\Users\100003~1\AppData\Local\Temp\claude\C--Claude-Session\c57202bc-f44c-4eeb-b379-2eca11362dd4\scratchpad\settings-design. Implement the **Redesign row** (the "as built (v1.0.96)" row is the before-state, reference only) plus every state on the **States** boards._

- **Navigation:** General (`RBridge.dc.html`), AI providers (`RCore.dc.html`), Game understanding (`RCortex.dc.html`), Guide (`RCodex.dc.html`, tours and features merged), About (`RAbout.dc.html`); the sidebar shows the active chat route ("AI route: Anthropic") and the version. Replaces today's General, AI Models, Guide, Features, About tabs in `src/components/settings-screen.tsx` (split into one component per page under `src/components/settings/`).
- **General:** search across all settings (Ctrl K) with results by section and the no-match state, Roomy/Dense density toggle, grouped rows with chips, hotkey rows (Ctrl+Shift+O, Shift+Win+D), warning rows, Export/Import with the toast and "Show file", import confirmation (from B16), gg.deals key states (saved and working, rejected, unreachable, tested too recently, first load), the analytics toggle (decision above).
- **AI providers:** the router screen: per-role tabs (chat, embeddings, reranker), connector list with armed/fault/off counts, the route view, Add connector (any LiteLLM provider or OpenAI-compatible server), connector detail (enable, address/key/endpoint/deployment/API version, models: fetch from server, add id, default), connection test (test with, timeout, retries, re-check interval, test input, test on save), Advanced (base URL override, LiteLLM id with copy), "When a route fails" policy, embedding-change rebuild banner, and every StatesCore state (first run with nothing armed, with copy updated for the built-in runtime instead of "Get Ollama"; key saved but rejected; scheduled re-check fault; routed connector turned off with Undo; remove-key confirmation). Built-in llama.cpp (B36) appears as the default connector with its model downloads.
- **Game understanding:** status tiles (similarity index, detailed reading, data format, graphics memory), embedding model with Change, batch size (Auto/16/64/192/512), detailed reading, match on any part, compact vectors, reranker model with Change, rerank similar games, rerank Oracle shelves, AI influence slider, maintenance (rebuild similarity index, refresh detailed reading, rebuild everything with progress, cancel, resume), advanced matching sweep, plus the StatesSystem states (rebuild in progress, interrupted with resume, graphics memory tight / too high, runtime not running). Every control is wired to the existing setting it represents; a control with no backing setting today gets one (no dead controls).
- **Guide:** tours with completed count and Done/Start states, features list and "How the AI works" (copy updated: built-in local AI instead of Ollama, router wording).
- **About:** version and update states (checking, available, check failed with GitHub link) using the 1.0.84+ updater, "In this build" from the changelog modal data (not hard-coded), team, built-with versions read at build time, terms.
- **Look:** match the design's tokens exactly (black ground, JetBrains Mono, white-alpha text levels, fuchsia accent `#e879f9` / `rgba(217,70,239,...)`, radii, spacing); reuse existing UI primitives where they match; keyboard and screen-reader accessible (real buttons/inputs/labels, focus rings, Esc), responsive at narrow widths, `prefers-reduced-motion`.
- **Guided tour:** Settings tour steps retargeted to the new pages.
- **Tests:** component tests per page (render, search filters, density toggle, each state from the States boards, key flows with mocked IPC), the settings search index covers every row, tour targets exist; existing settings-screen tests updated. Manual: screenshots of each page against its board on a copied profile.
- **Risk:** medium: a large UI rewrite touching many settings; mitigated by one component per page and tests for every state.

## Release gate: measure before shipping (user requirement)
Nothing ships until the measured numbers say so. Unit tests alone are not enough.

- **Harness** `scripts/perf/measure.mjs` (Playwright `_electron`, already a dev dependency) on a generated, copied test profile (2,000 library games, 5,000 status-history rows, 10,000 sessions, Voyage data, gg.deals off, no real keys). `ARK_PERF=1` turns on main-process probes: `monitorEventLoopDelay` (p50/p99/max), per-channel IPC call counts and payload bytes, `app.getAppMetrics()` for every process (main, renderer, GPU, workers, llama-server, Python sidecar).
- **Renderer probes over CDP:** `Performance.getMetrics` (JSHeapUsedSize, Nodes, JSEventListeners, LayoutCount, RecalcStyleCount), long tasks (PerformanceObserver), frame times while scrolling Browse, forced GC (`HeapProfiler.collectGarbage`) before every heap reading.
- **Scenario:** cold start to first interactive; 60 s idle; then 10 cycles of Browse (scroll 3 screens, filter, search, empty result), open/close game details ×5, Library status change from a card, Voyage tabs (Ark 3D, Log, Scenes, Audit, Medals), Oracle compute, Upcoming, every Settings page; 5 min idle with the window hidden.
- **Leak rules:** after cycle 2 (warm-up), JS heap, DOM nodes, event listeners, IPC listeners and process count must be flat: growth from cycle 2 to cycle 10 under 5% for heap, zero net growth for listeners and child processes; GPU memory returns to baseline after leaving Ark 3D. Heap snapshot diff on any failure, with the retainer path in the report.
- **Performance budgets vs v1.0.96** (same harness, same machine, a build of tag v1.0.96 as baseline): no metric more than 10% worse; main event-loop max under 100 ms during Steam app-list refresh (was ~19 s); no renderer long task over 200 ms during Browse scroll or Oracle compute; cold start no slower; IPC calls per Browse screen not higher; idle CPU with the window hidden near zero; memory with llama-server/Python sidecar idle-unloaded reported separately.
- **Loop:** run, report, fix every leak and every budget miss at its root cause (with a regression test where one can be written), re-run; repeat until all rules pass. Then the full gates again (`tsc` both projects, full `vitest --isolate`, `build:app`, NSIS build, packaged smoke test, `verify-release.mjs`).
- **Report** `docs/perf/1.0.97-measurements.md`: before/after table per metric, leak results per cycle, what was fixed. Numbers go in the release notes only where they were measured.

## Next increment: v1.0.98 (user request, 2026-11-03), queued right after 1.0.97 ships
1.0.97 stays one release exactly as planned (B01-B37, measured, then published). Only then 1.0.98 starts, and it ships the same way (single release, measured before publishing, auto-continue):

1. **Second audit, capped** (the first one never finished: round 3 hit the agent cap, ~140 findings unverified, the completeness critic never ran). Scope: the 1.0.97 code itself (new Settings pages, llama.cpp runtime, LiteLLM router, downloads, the ~250 fixes), the subsystems the critic would have checked, and the round-3 leftovers. Hard caps on agents and rounds this time; double verification; findings merged into batches like before.
2. **Fixes:** every confirmed finding from that audit, plus anything the 1.0.97 measurement run flagged but could not fix inside 1.0.97.
3. **Performance and memory:** re-run the measurement harness against 1.0.97 as the new baseline; fix every budget miss and leak; add any missing probes (llama-server and Python sidecar memory, download throughput, Settings page render cost).
4. **Design repolish of the Settings and model router pages:** a polish pass on the pages shipped in B37 (General, AI providers / router, Game understanding, Guide, About): spacing, alignment and consistency against the design tokens, focus and keyboard order, empty/loading/error states, narrow widths, copy, reduced motion, contrast, screenshot comparison with the Claude Design boards, and any gaps the real build exposed. If the user finalizes a new Claude Design iteration, that replaces the boards as the target.
5. **Release gate:** identical to 1.0.97 (full tests, measure vs 1.0.97 baseline, packaged smoke test, verify-release), then bump to 1.0.98, changelog, installer, tag, push, publish, verify.

## Then v1.0.99 (user request, 2026-11-03), queued right after 1.0.98 ships
A hardening release for the modules added in 1.0.97 and 1.0.98: more fixes and more performance work, nothing else. Same single-release, measured-before-publish, auto-continue rules.

- **Scope (new modules only):** built-in llama.cpp runtime and its process manager, runtime model downloads and the splash screen, the LiteLLM sidecar and AI router (connectors, routes, fail policy, tests, key storage), the redesigned Settings pages and the settings search, the 1.0.97 fix batches (B01-B35) as they were changed in 1.0.98, and everything 1.0.98 added.
- **Audit:** a third capped audit (hard limits on agents and rounds, double verification) pointed only at that code, with extra lenses: process lifecycle (orphans, restarts, shutdown), download resume and corruption, port and firewall edge cases, GPU/CPU fallbacks and out-of-memory, offline and low-disk behaviour, key handling, migration from older profiles, and upgrade paths from 1.0.96 and 1.0.97.
- **Performance and memory:** re-measure against 1.0.98 as baseline with the harness; budgets for first-run download, splash time, llama-server and sidecar memory and idle unload, embedding and rerank throughput through the router versus direct, Settings page render cost; fix every leak and budget miss at its root cause.
- **Gate and release:** identical to 1.0.97/1.0.98 (full tests, packaged smoke test including a fresh machine with no Ollama and one with Ollama running on 11434, verify-release), then bump to 1.0.99, changelog, installer, tag, push, publish, verify.

## Appendix A — cross-area duplicates removed
- main-apis#33 → kept main-core#0: Same root cause: package.json build files include the developer .env (Azure/Steam/GA secrets) loaded in electron/main.ts.
- hooks#0 → kept renderer-stores#3: Same bug: tracker-overhead-store.ts:50 snapshot returns a new array every call, so useSyncExternalStore in useTrackerOverhead loops.
- main-apis#25 → kept main-core#6: Same launcher heuristic in exe-info-handlers.ts (~172-185) matching publisher signer names.
- main-apis#13 → kept main-core#16: Same egdata:getTopSellers handler at egdata-handlers.ts:79 with no cache or in-flight dedupe.
- ui-browse-details#33 → kept hooks#4: Both are dashboard.tsx:422-466 and useDeferredFilterSort.ts:381 comparators that build collators or localeCompare options per compare. One shared Intl.Collator fixes both.
- ui-other#7 → kept ui-browse-details#3: Same bug: the game-details add dialog (game-details.tsx:935) drops addedAt, so library-store.ts:603 throws RangeError.
- main-apis#20 → kept ui-other#2: Same unchecked apply of LLM library actions in ai-chat-panel.tsx:714 / useAIChat.ts:90-106. ui-other#2 also covers arbitrary status strings.
- hooks#17 → kept ui-other#3: Same plaintext Azure/Anthropic keys in renderer localStorage (useAIChat, useChatAvailability, settings-screen).
- oracle#12 → kept ui-other#13: Same adult-content-filter.ts:138-194 behaviour: the whole localStorage cache is rewritten on every miss.
- hooks#19 → kept ui-browse-details#6: Same two useGameSearch instances at dashboard.tsx:202/204 firing Steam/Epic searches.
- main-core#9 → kept main-apis#30: Same synchronous native ANN index load in ann-index.ts:272-307 during boot.
- main-apis#24 → kept main-core#14: main-core#14 already covers steam:getUpcomingReleases caching a degraded or failed result for 1 h (steam-handlers.ts:391-422), plus the event scraper.
- oracle#8 → kept renderer-stores#15: Same catalog-store.ts:935 queryForCandidates streaming the full catalog over IPC on every Oracle compute.

## Appendix B — findings dropped during synthesis
- [main-core] renderer-process-limit=1 puts the in-game overlay HUD in the same renderer process as the heavy main UI (split-vote) — Performance claim dropped: the main window is usually minimized or throttled during play and the only effect is a small delay to a 1 s timer label; removing the limit gives up the deliberate resource budget. The real part (a shared crash kills the HUD with no recovery) is covered by the item 'In-game overlay HUD has no crash recovery'.
- [renderer-stores] Steam catalog rows and Epic catalog offers are never deleted, so delisted games build up (split-vote) — Dropped. Both verifiers agree growth comes only from delisting churn (well under 1% a year) and nothing builds up per session, so this is slow data staleness rather than a leak. The proposed deletion is risky: Steam's app list can be stale or empty, and Epic crawls are often short, so one bad crawl could delete good rows and their embeddings. Track it as a separate feature (lastSeen stamp per row, demote or skip rows unseen for several complete crawls) instead of a release fix.
- [renderer-stores] Library hydration from LevelDB never invalidates _sortedCache (confirmed) — Merged into 'Library sorted cache goes stale after import and after boot hydration'. Same root cause and fix as the import cache bug.
- [renderer-stores] Library import does not sanitize dates or migrate legacy statuses (confirmed) — Merged into 'Library sorted cache goes stale after import and after boot hydration'. The fix reuses ingestEntries in importData, which also gives the cache invalidation.
- [renderer-stores] Cross-store status sweep is consumed by the first getAllEntries() before hydration (confirmed) — Merged with the sweep cost finding (split-vote, kept) and the normalizeTitle cost finding into one sweep item. Fixing the early run exposes the O(buckets x library) cost, so they must ship together.
- [renderer-stores] normalizeTitle rebuilds 19 RegExps per call inside O(n) loops (confirmed) — Merged into the cross-store sweep item. Both verifiers say the per-click cost is a few ms and the real hot spot is the sweep; the romanMap hoist is an optional part of that item.
- [renderer-stores] Graph restore and rebuild build a ~2M-object adjacency Map synchronously (confirmed) — Merged with 'Game graph keeps a second, object-based copy of every edge'. Same code, same lazy CSR fix.
- [renderer-stores] Epic catalog IDB migration stream never settles on batch-write failure (confirmed) — Merged with the Steam catalog migration stream hang. Same pattern, fixed by one shared helper.
- [renderer-stores] Clear Library does not mark journey rows removed (confirmed) — Merged with 'Re-adding a removed game never clears removedAt' into one journey removedAt item, which also covers a single boot repair.
- [renderer-stores] Dedup re-merges an already-merged Steam+Epic entry with a later Epic edition (confirmed) — Merged with 'Dedup drops distinct same-store games'. The grouping rewrite in deduplicateGames fixes both.
- [renderer-stores] Shelf bandit failed getAll keeps the frozen localStorage arms (confirmed) — Merged with the reco-history frozen-snapshot finding. Same pattern, same fix in both stores.
- [hooks] games memo returns a new array on every epoch bump; player-count effect bumps the epoch on every displayCount change (split-vote, #31) — Real but negligible: the filter/sort fingerprint gate stops the expensive pass from repeating, leaving about 1 ms per page. The one-line once-per-load gate is folded into the 'Browse grid never shows player counts' item, where it matters because the new remap would otherwise run on each page.
- [hooks] useLibrary re-renders every consumer on every library mutation (split-vote, #33) — Dropped on reading the code: GameDetailsContent is memo'd so DOMPurify does not re-run, the closed AIChatPanel renders almost nothing, and React 18 batches Dashboard's subscriptions into one render. What remains is cheap parent reconciliation, mostly during a one-time backfill. Hygiene only.
- [hooks] useLibraryGames rebuilds every library Game and runs journey sync twice on each Dashboard mount (split-vote, #34) — Dropped: the fingerprint gate prevents a second filter/sort or search-index pass, the journey loops are no-op Map lookups, and the cost is a few ms once per navigation. The proposed skip would also delay cover/progress catch-up until the next library notify.
- [hooks] useSteamGames reuses one isMountedRef across category changes (#2) — Merged into 'Browse category switch race' with #11 (same root cause and fix).
- [hooks] Browse hides games whose releaseDate is not ISO (#18) — Merged with #27 into the 'Non-ISO Steam release dates' item (same root cause: raw text dates; shared helper fix).
- [hooks] Every toast re-renders the whole Dashboard through SessionTrackerProvider (split-vote, #29) — Kept, merged with #30 into the toast-context item. Both verifiers confirmed the mechanism. The claimed SessionTracker path saves nothing by itself because Dashboard calls useToast directly, so the fix is to split the toast actions from the list.
- [oracle] UMAP loop sleeps 20 ms every 2 epochs and posts a progress message each time (src/workers/pca.worker.ts:372) — Split vote; dropped. The UMAP path is dead code: runProjectionWorker(..., 'umap') is only called from computeProjection (src/services/galaxy-cache.ts:508-521), and nothing in src/ or electron/ calls computeProjection. The galaxy build uses in-process PCA. Optional cleanup: delete or document the unused UMAP path.
- [ui-browse-details] Search thumbnails cycle through all fallbacks on a 4s timer for lazy off-screen images (split-vote) — Main premise not reproducible: results are capped at 30 rows (~1680px) and Chromium 130's lazy-load margin covers the whole scroller, so requests are in flight when the timer runs. The remaining valid part (reset on URL-list change, optionally drop loading=lazy) is merged into the GameCard/search thumbnail fallback-reset item.
- [ui-browse-details] Grid cards and library sections disagree on 'Playing Now' for Epic-keyed games with a steamAppId (split-vote) — Unreachable today (dedup makes Steam primary, Epic transforms and buildGameFromLocalEntry never put a steamAppId on an epic- id). Kept as a guard inside the epic- dual-store Add/Edit item, whose fix creates such entries.
- [ui-browse-details] Two useGameSearch instances repeat the same scan and API search (split-vote) — Cost is small: the in-memory scan is over ~6k prefetched games with a prebuilt index (not 155k), and both Steam (search-${query}-${limit}) and Epic (epic:search:...) searches are cached in the main process. The Library-view waste is fixed by the 'Library search fires store searches' item.
- [ui-browse-details] Enrichment map retains full description HTML and screenshots for up to 2,000 games (split-vote) — Not a leak: bounded at 2,000, cleared on category change and refresh, strings shared not copied, realistic size well below the claim. The proposed fix would also break the adult-content filter that reads longDescription.
- [ui-browse-details] MovingBorderButton runs a per-frame JS loop for the whole session (split-vote) — Negligible cost: microsecond geometry queries on one small rect, a tiny blur region, and background throttling already on. Does not scale with grid size.
- [ui-browse-details] Hero image failure set never reset between games (split-vote) — Not reproducible: App.tsx wraps routes in <ErrorBoundary key={location}>, so GameDetailsPage remounts on every /game/:id change and the set starts empty.
- [ui-browse-details] Clearing the search while an API search is in flight lets the stale response overwrite results (split-vote) — No visible effect: the dropdown is hidden for an empty query and only draws rows when !loading, and the grid ignores results when not searching. Optional hygiene (bump requestIdRef in effect cleanup) can ride along with other search changes.
- [ui-browse-details] Leaving Browse resets the category, re-fetching and wiping enrichment (split-vote) — Intended behaviour: switchToBrowse also calls resetFilters, so Browse always reopens on Top Sellers anyway and total work is the same. Preserving browse state across navigation is covered by the 'Coming back from game details resets state' item.
- [ui-browse-details] Details Play button stale after setting an executable (split-vote) — Not reproducible today: ToastProvider passes a new context value every render, and the save path fires a toast, which re-renders the memoized child. The hardening (pass launchExecutablePath as a prop) is folded into the custom-games details item.
- [ui-voyage] Wrapped stays on 'Gathering your year...' forever if stats computation throws (split-vote) — Neither claimed trigger throws on reading current code: toTime returns NaN for bad startTime and is filtered, new Set(string) iterates characters, and readWrappedInputs already guards store reads. No realistic data path to the catch found; Close/Esc still work. Optional hardening only (Array.isArray guards for genre/platform in stats.ts).
- [ui-voyage] Wrapped confetti worker keeps the last overlay's OffscreenCanvas after close (split-vote) — Bounded, non-growing retention (one ~8 MB canvas, replaced on next open) for a seasonal overlay; the export claim is wrong. Not worth a release item; switching line 316 to useWorker: false is an optional one-line cleanup.
- [ui-voyage] Voyage Ark/Log sort re-parses ISO dates per comparison (split-vote) — Cost is a few ms for realistic journeys and runs only when entries change while Voyage is mounted; default tab Ark consumes the result. Not user-visible; optional decorate-sort cleanup.
- [ui-voyage] Badge unlock timestamps rewrite the whole namespace per stamp (split-vote) — Merged into the 'Badge Obtained dates stamped on render' item, whose fix includes per-key persistence.
- [ui-voyage] Voyage timeline animates CSS height on every scroll frame (split-vote, performance half) — Performance part not real: the animated element is a 2px out-of-flow child in a fixed-size overflow-hidden track, so relayout is local and cheap. The stale-length half is kept, merged into the Captain's Log item (ResizeObserver).
- [ui-voyage] Ark keydown handler swallows ArrowLeft/ArrowRight (finding #13) — Duplicate of finding #3; merged into the Ark arrow-key item.
- [ui-other] Splash 3D canvas forces at least 1.5x DPR with shadow mapping during boot (split-vote) — Dropped. The extra cost is GPU fill work in Electron's GPU process, not on the renderer thread doing boot init. The scene is tiny and only shown on the splash, and the 'Enter Ark' timing depends on IPC and data readiness, not frame rate. The 1.5 minimum is a deliberate supersampling choice. Optional polish (dpr={[1,1.5]}) can go in a cosmetic pass; do not switch to frameloop='demand', which would break the light-ramp animation.
- [ui-other] Release calendar Year view renders ~360 framer-motion layout-animated cards re-measured on every feed re-render (split-vote) — Kept, merged into the 'Release calendar re-renders every card on any library change' item. The same root cause (memo defeated by a new Date per card, unstable add callback, libraryIds dependency) and the same fix.
- [ui-other] Release calendar rebuilds libraryIds on every library notify and filteredReleases depends on it with My Radar off (split-vote) — Kept, merged into the 'Release calendar re-renders every card on any library change' item. The Set equality check and the radar-gated dependency are part of that fix.
- [ui-other] Every Transmissions card runs three requestAnimationFrame scramble loops (split-vote) — Dropped as a performance defect. The effect runs once per card (useInView once:true, cards keyed and memoized), stops when revealed, only writes and never reads layout, and the browser batches all rAF callbacks into one frame. The cost is a few seconds of bounded work. The missing prefers-reduced-motion check is an accessibility polish item, not a release-plan bug.
- [ui-other] Transmissions 1-second countdown tick re-renders BuzzView and StreamColumn every second (split-vote) — Dropped. Verified that TransmissionCards are memoized with stable props, so each tick is a shallow comparison that bails out (well under 1 ms). EventCards render only when the strip is expanded, and the 1 s rate is needed for the seconds countdown. Nothing is retained. Moving the tick into a Countdown leaf component and fixing the stale '60s' comment are optional tidy-ups.
- [ui-other] Snackbar stays dismissed through a download and its completion (split-vote) — Kept at low severity and merged into the 'Update UI never offers install after a download' item. The path is narrow (Later clicked after About's check, then Download in About), but it is real: onUpdateDownloaded does not reset dismissed (update-snackbar.tsx:169). It is a one-line fix in the same change as the About tab install state.
- [ui-other] AI chat runs a smooth scrollIntoView on every streamed chunk — Merged into the 'AI chat re-renders and re-parses every message' item. Same root cause (one setMessages per token) and the same rAF batching and stick-to-bottom fix.
- [ui-other] AI chat 'add' action writes an unvalidated LLM status string into the library — Merged into the 'AI chat applies LLM-issued library actions unchecked' item. It is the same shared action-handling helper in ai-chat-panel.tsx and useAIChat.ts.
- [ui-other] Ollama settings stuck on 'Saving...' forever when the URL is briefly invalid — Merged into the 'AI Models settings: pending debounced saves are lost...' item. It is the same debounced-save effect and error handling in settings-screen.tsx:569-605.
- [ui-other] News 'Your Fleet' tagging is O(items x library titles) — Merged into the 'Transmissions auto-refresh bypasses the news cache' item. The scan runs on each refresh, and both fixes ship together.
- [ui-other] About tab 'Check for Updates' during or after a download offers 'Download v<current version>' — Merged with the split-vote snackbar-dismissed finding into the 'Update UI never offers install after a download' item.

## Verification for the release
- All gates per batch, full suite at the end; golden top-20 diff reviewed for B34 only.
- `verify-release.mjs`: allow-list fixed (no AZURE_*), plus grep of `win-unpacked` for secret names.
- Manual smoke on a copied profile: Browse (filters, empty state, play from card), game details, Library import/export (confirmation), Settings keys, Telemetry tab, Voyage tabs, Upcoming, updater fallback, sleep/resume during a session.
