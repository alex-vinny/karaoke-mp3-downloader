# Karaoke MP3 Downloader — Plan

**Status:** Phase 4 done — v1.0.0 released, installer verified on Vinicius's
machine (first install with a local zip, update path against the real Release),
the extension downloaded a real karaoke song in his Chrome, no developer-mode
pop-up on Chrome 153. The test install stays on his machine for maintenance
(`%LOCALAPPDATA%\KaraokeMP3`, the extension in Chrome, the "Atualizar Baixador"
shortcut); the test songs folders and MP3 were deleted. **Next: Phase 5 (Dad's
laptop, Vinicius).** Open follow-ups: §5 follow-up scenarios (double click, emoji,
offline) are not automated yet.
**Updated:** 2026-09-26.

## 1. Goal

A Chrome extension with **a single button — "⬇ Download MP3" / "⬇ Baixar MP3"** —
inside the YouTube player, for Vinicius's dad: an amateur karaoke singer who uses
YouTube as his songbook and whose laptop has **no developer tools at all**.

A fork of [Triangle-Downloader](https://github.com/HelpFreedom/Triangle-Downloader)
(GPL-3), simplified, **English by default with automatic pt-BR** (`_locales`: Chrome
picks the browser's UI language) and distributed through GitHub with a one-line
PowerShell installer. Anyone can use it; his dad sees everything in Portuguese
without configuring anything.

## 2. Decisions

| Topic | Decision | Why |
|---|---|---|
| Base | Fork of `HelpFreedom/Triangle-Downloader` | GPL-3 requires keeping licence/credit; a fork allows `git fetch upstream` when YouTube breaks something |
| Repo name | `alex-vinny/karaoke-mp3-downloader` (forked as `baixar-mp3-karaoke`, renamed on 2026-09-25; GitHub redirects the old name) | English is the project's language. The local folder is still `baixar-mp3-karaoke` — it does not need to match |
| Language | Repo, main README, code, comments, file names and installer in **English**. Visible extension strings in `_locales/en` (default) and `_locales/pt_BR`. `README.pt-BR.md` carries the dedication in Portuguese. The installer speaks pt-BR when Windows is pt-BR | Chrome's page translation does **not** reach text injected by an extension (Dad's YouTube is already pt-BR; Chrome never offers to translate). `_locales` is the native mechanism: `chrome.i18n.getMessage` works in content scripts, background and offscreen |
| Minimal diff | Direct click = download; the upstream menu code stays in place but unreachable; strings via `t(key)`; **no rewrite of the hook** (only small additions) | Merging upstream stays viable when YouTube changes the player |
| Extension ID | Fixed `key` in the manifest → ID `ogenoilmpfaooogllahggcdcejoeeodd` on every machine. Private key in the vault (item `karaoke-mp3-downloader-extension-key`, folder "Git & DevOps"), never in the repo | Needed for the §6 allowlist, the option-3 `.crx`, and stable `chrome://extensions/?id=…` links in the README |
| Dad's browser | Google Chrome on **Windows 11** | Confirmed 2026-09-25. **uBlock Origin Lite** already installed; it must be in **"Complete"** filtering mode on youtube.com — in the default "Basic" mode ads enter the stream and the capture aborts |
| Ads | Button disabled while `#movie_player` has the `ad-showing` class; an ad starting mid-capture cancels the capture with a clear message (`adDetected`) | The upstream hook does not detect ads; without this the symptom is a corrupted MP3 or a generic error |
| Dev folder | `C:\sources\extensions\baixar-mp3-karaoke` (this one) | |
| Folder on Dad's laptop | `%LOCALAPPDATA%\KaraokeMP3\extension` | No admin, invisible to him, outside Downloads (cannot be deleted by accident) |
| Songs folder | `Downloads\<songsFolder>`: "Músicas para cantar" (pt-BR) / "Songs to sing" (en). The extension reads `chrome.i18n.getMessage('songsFolder')`; the installer decides via `Get-UICulture` | Named after its purpose, localised like everything else. Small risk: Windows in one language and Chrome in another → two names; Chrome creates the sub-folder on first download anyway, only the desktop shortcut would point elsewhere |
| Button | "⬇ Download MP3" / "⬇ Baixar MP3": a big red pill fixed in the top-right corner of the player, outside YouTube's control bar | One action, no menu. In the control bar it was nearly invisible (the bar auto-hides and YouTube's `.ytp-button` fixes a 48px width); Vinicius asked for something his dad cannot miss |
| Toolbar icon | **None** (upstream has no `action`/popup and we will not add one) | Less diff; the folder opens from the desktop shortcut and from the toast's "Open folder" |
| Distribution | GitHub Release (zip of `extension/`) + `install.ps1` at the repo root | Fixed URL `releases/latest/download/karaoke-mp3-downloader.zip` |
| Update notice | `GET https://api.github.com/repos/alex-vinny/karaoke-mp3-downloader/releases/latest` → `tag_name`, once a day in `background.js` via `chrome.alarms` | The Release is what the installer downloads; reading the manifest on `main` would announce a version that cannot be downloaded yet. The API answers with CORS `*`; 60 req/h per IP is plenty |
| Install | "Load unpacked" (developer mode) | `.crx` outside the store is blocked on Windows; the Chrome Web Store rejects YouTube downloaders; `--load-extension` was removed from branded Chrome in 137 (2025) |
| Tests | Playwright **locally** (Playwright's Chromium) + `node --test` for pure functions | YouTube blocks datacenter IPs (GitHub Actions); only the unit tests run in CI |
| Tools | git 2.54, Node 22, npm 10. **No `gh`** → GitHub REST API via `curl` with the PAT from the vault. PAT `github-pat` has `repo` + `workflow` (checked 2026-09-25; `workflow` is required to push `.github/workflows/`) | See §10 |

## 3. How Triangle works (summary)

Folder `extension/` (v1.4.6, last upstream commit 2026-08-26; 90 stars, 9 forks,
branch `main`). No build step: it is just a folder.

- `manifest.json`: MV3, `permissions: downloads, offscreen, storage`,
  `host_permissions: *://www.youtube.com/*`, CSP with `wasm-unsafe-eval`.
  **No** `key`, `action`, `_locales`, `minimum_chrome_version`.
- `content_hook.js` (MAIN world, `document_start`): patches
  `SourceBuffer.prototype.appendBuffer`, splits audio/video by MIME, locks quality
  with `setPlaybackQualityRange(q,q)` and "seeks to the edge of the buffered
  region" until the range is covered. Stops when it covers up to `capEnd - 0.4`
  or `mediaEnd - 1.5`, or after ~60 s without progress; **hard cap 30 min**;
  aborts if the video changes. **No ad handling.** Also hides AV1 support so
  YouTube serves VP9/Opus, and turns "Autoplay next" off.
- `content_ui.js` + `content_ui.css` (ISOLATED world, `document_idle`):
  `ensureButton()` inserts the ▽ into `.ytp-right-controls` (MutationObserver +
  `yt-navigate-finish`); menu (video 1080p/720p, audio MP3, subtitles,
  VP9/H.264); `download()` sends the order to the hook; file name =
  `safeName(title)` (100 chars, strips `[\/:*?"<>|]`) + suffixes; singleton
  toast. ~20 Russian strings scattered around.
- `background.js`: messages `ytdl-ensure` (creates the offscreen document, no
  duplicates) and `ytdl-save` → `chrome.downloads.download({ url, filename,
  saveAs: false })`. Has a **second** sanitiser, `plainFilename()` (80 chars).
- `offscreen.html/js`: single-thread ffmpeg.wasm from `vendor/ffmpeg/`; MP3 =
  `-vn -c:a libmp3lame -b:a 192k`; **no ID3 tags**; result → Blob →
  `URL.createObjectURL` → `ytdl-save`; the blob lives 60 s.
- Root: `README.md` (Russian), `README.en.md`, `LICENSE`, `docs/screenshot.png`,
  `.gitignore` (ignores `.claude/`, `.vscode/`… and **also `package.json` and
  `package-lock.json`**, which we need to version).

Limits: only on `youtube.com/watch`; MP3 is a single-thread re-encode (~1 min for a
4-min song); closing the tab mid-way aborts.

## 4. Phases

**Order: 1 → 0 → 2 → 3 → 3½ → 4 → tag `v1.0.0` → 5.** Phase 0 comes after the
clone and before any code change.

### Phase 1 — Fork and clone (agent, 10 min) — done 2026-09-25

- [x] Vault unlocked by Vinicius (`vault unlock`, in his terminal) and a rule in
      `.claude/settings.local.json` allowing `vault run github-pat=GH_TOKEN -- …`
      (Claude Code's auto mode blocks the vault without it).
- [x] Fork with a name: `POST /repos/HelpFreedom/Triangle-Downloader/forks` with
      `{"name": …}` → 202 (async) → `GET /repos/alex-vinny/<name>` until 200.
- [x] **Actions enabled** — a fork is born with workflows off; without this Phase
      3½ never runs: `PUT /repos/…/actions/permissions` with
      `{"enabled":true,"allowed_actions":"all"}` → 204; GET confirms.
      Issues are also off on a fork — leave them off.
- [x] In this folder: `git init` → remotes `origin` and `upstream` → `git fetch
      --ipv4 origin` → `git checkout -b main origin/main` (v1.4.6, `ff60ae8`).
- [x] Rename to `karaoke-mp3-downloader` + description (§9) with `PATCH
      /repos/alex-vinny/baixar-mp3-karaoke`. **JSON via file (`-d @req.json`)**:
      non-ASCII in argv reaches `curl` mangled under MSYS (400 "Problems parsing
      JSON"). Then `git remote set-url origin`.
- [x] `.gitignore`: start from upstream, **drop `package.json` and
      `package-lock.json`**, add `test-results/`, `playwright-report/`,
      `tests/.tmp/`, `tests/vendor/`, `*.zip`. `.claude/` is already ignored.
- [x] Token only via `vault run github-pat=GH_TOKEN -- bash <script>`; inside the
      script the header reaches `curl` through stdin (`-K -`), never argv. Push
      with the recipe from `C:\sources\claude-tools\AGENTS.md` (extraheader via
      `GIT_CONFIG_*`, empty `credential.helper=`, `--ipv4`).
- [x] Initial commit with `specs/`, `AGENTS.md`, `.gitignore` → push.

### Phase 0 — Baseline (agent + Vinicius, 30 min)

Prove that the **untouched** upstream works today, to tell "I broke it" from "it
was already broken".

- [x] **Playwright (agent), 2026-09-25:** `tests/baseline-upstream.spec.mjs`
      green on the first run (15 s): untouched upstream saves
      "Me at the zoo.mp3", 457 KB, 19.03 s, MPEG-1 Layer 3, no `title` tag.
      No "not a bot" wall on a fresh profile. **Findings:** (a) technique A does
      not keep the file name — Playwright forces `allowAndName`, so the file
      lands as `<guid>.mp3` in the folder we asked for; `Browser.download*`
      events never reach the page's CDP session; (b) technique B works:
      `context.serviceWorkers()[0].evaluate(() => chrome.downloads.search({}))`
      gives the real path, `state: complete`, bytes and MIME; (c) the name the
      extension asked for only shows in the toast ("Готово: <name>"). For Phase
      4: check name/sub-folder through the toast (or a `data-filename` on it)
      (`page.on('download')` never fires for an extension-initiated download —
      checked in Phase 2, so the toast's `data-filename` is the source); file and
      duration through technique B. The baseline spec goes away when Phase 4's
      `tests/karaoke-mp3.spec.mjs` lands (the button and menu change in Phase 2).
- [x] **Official Chrome (Vinicius, 5 min — ask first, §10):** load `extension/`
      unpacked, download one MP3, close and reopen Chrome. Answers: does the
      "Disable developer mode extensions" pop-up still exist in current Chrome
      (decides §6)? Does upstream work outside Playwright? Vinicius chose to do
      this later, in parallel with Phase 2. 2026-09-25: the modified extension (installed by install.ps1) was loaded in Vinicius's Chrome and downloaded a real karaoke song with correct tags — it works outside Playwright. First finding: inside the control bar the button was nearly invisible, hence the top-right pill. The pop-up question is still open (needs a Chrome restart). 2026-09-26: after install.ps1's update path swapped the folder with Chrome closed, Chrome 153.0.8010.53 reopened with the unpacked extension loaded and **no** "Disable developer mode extensions" pop-up (Vinicius's report). §6 is history.
- [x] Record what was seen in §6 and §7.

### Phase 2 — One button (agent, ~1 h)

Files: `content_ui.js`, `content_ui.css`, `manifest.json`, `background.js`,
`offscreen.js`, `content_hook.js` (small additions); new `filename.js`,
`version.js` and `_locales/`.

Message contract between the pieces (new or changed):
- UI → hook: `{ cmd: 'cancel' }` sets `store.cancel`; the capture loop throws
  `cancelled`. `info` reply also carries `author` (channel name).
- UI → offscreen `ytdl-begin` also carries `title` and `artist` (ID3 tags).
- offscreen `finalize` answers `{ ok, filename, id }` (`id` = download id).
- UI → background `{ t: 'ytdl-show', id }` → `chrome.downloads.show(id)`.
- background writes `updateAvailable: '<version>' | null` to `chrome.storage.local`;
  the UI shows `updateAvailable` once per page load when set.

- [x] **Read `content_ui.js` in full before touching it.** Functions to touch:
      `makeButton()`/`ensureButton()` (button), `onClick` (menu → direct
      download), the toast, `safeName()` (replaced by the shared module).
- [x] `_locales/en/messages.json` (default) and `_locales/pt_BR/messages.json`
      with the §9 table. Manifest: `default_locale: "en"`, `name:
      "__MSG_extName__"`, `description: "__MSG_extDescription__"`. Helper
      `t(key, subs)` = `chrome.i18n.getMessage(key, subs)` at the top of
      `content_ui.js`, `background.js` and `offscreen.js`. Positional
      placeholders `$1`, `$2` in the messages.
- [x] Button `t('button')`, big and legible, in place of the ▽, with
      `data-testid="karaoke-mp3-download"`. The upstream menu builder stays in
      the file (renamed `openMenu`, unreferenced).
- [x] Click = `startDownload()` with audio, MP3, whole track (0 → end). Button
      disabled during a capture (ignores double clicks) and while
      `#movie_player` has the `ad-showing` class.
- [x] Ad mid-capture: MutationObserver on the `class` attribute of
      `#movie_player`; if `ad-showing` appears, send `cancel` to the hook and
      show `t('adDetected')`.
- [x] Toast with `t('keepTabOpen')` while it runs. Errors show a short code +
      version (`t('error', [code, version])`) for phone diagnosis: E1 capture,
      E2 convert/save, E4 ad. The real message goes to the console.
- [x] **Single** sanitiser in `extension/filename.js` (pure function
      `safeFilename(title)`; `globalThis.safeFilename` for the content scripts,
      `importScripts` in the worker, `module.exports` for `node --test`): keep
      letters (any script, accents included), digits, spaces and `- _ ( ) , . ' & !`;
      drop emoji, symbols and invisible characters; collapse whitespace; no
      leading/trailing dots; ≤ 60 characters cut at a word boundary; never empty
      (`audio`); Windows reserved names get a suffix. Declared in the manifest
      before `content_ui.js`; also used by `background.js` instead of
      `plainFilename()`. (Car radios choke on "🎵 … ‖ …".)
- [x] `background.js`: `chrome.downloads.download({ url, filename:
      `${t('songsFolder')}/<name>.mp3`, saveAs: false })` — upstream already
      uses `chrome.downloads`; only the `filename` changes. The download id
      travels back to the UI for the `t('openFolder')` button →
      `chrome.downloads.show(id)` (Explorer with the MP3 selected).
- [x] `offscreen.js`: add `-metadata title=… -metadata artist=… -id3v2_version 3`
      (car radios show the right name).
- [x] `content_hook.js`: hard cap 30 min → 2 h (1-hour karaoke mixes); `cancel`
      command; `author` in `info`; Russian error strings → English.
- [x] Update notice in `background.js`: `chrome.alarms` once a day (permission (code done; live check after the first Release, Phase 4)
      `alarms`), `fetch` of
      `https://api.github.com/repos/alex-vinny/karaoke-mp3-downloader/releases/latest`,
      compare `tag_name` (without the `v`) with `chrome.runtime.getManifest().version`
      part by part, numerically (`version.js`); result in `chrome.storage.local`;
      the content script shows `t('updateAvailable')` when opening `/watch`.
      `host_permissions` for `https://api.github.com/*`. A 404 (no release yet)
      is silently ignored.
- [x] RSA key pair generated (`openssl genrsa 2048`, 2026-09-25): public key →
      manifest `key`; ID `ogenoilmpfaooogllahggcdcejoeeodd`.
- [x] Private key stored in the vault (`vault put` + `vault attach`, folder Done 2026-09-25.
      "Git & DevOps"); the scratchpad copy is deleted afterwards.
- [x] `manifest.json`: `version` 1.0.0, `key`, `alarms`, `default_locale`,
      `filename.js` before `content_ui.js`.
- [x] Dead code (video, subtitles, H.264, time range): leave unreachable from the
      UI, do not delete. Priority is **not breaking the capture**.
- [x] `tests/unit/*.test.mjs` with `node --test`: `filename.js`, `version.js` 11 tests green.
      and key parity between `en` and `pt_BR` (they also run in CI — no YouTube
      needed).
- [x] Smoke test of the modified extension in Playwright (the Phase 4 spec, `tests/karaoke-mp3.spec.mjs` green in pt-BR and en-US (13 s each), ID3 title + artist confirmed.
      first version) before committing Phase 2.

### Phase 3 — Languages and READMEs (agent, 30 min)

- [x] No visible string outside `_locales` and no Russian left: (upstream's transcript regexes in dead code are the only Cyrillic left)
      `grep -P '\p{Cyrillic}' extension/*.js` empty. Comments in English.
- [x] `README.md` (English, main, short): link to `README.pt-BR.md` at the top,
      dedication (§9), what it does, install (the `install.ps1` line + the 3
      clicks), update, "if it stops working" (what to tell Vinicius: the version
      and the code from the toast), credit to the original author + GPL-3 (keep
      `LICENSE`).
- [x] `README.pt-BR.md`: the same in Portuguese. Remove upstream's `README.en.md`
      (the Russian `README.md` is replaced).

### Phase 3½ — Distribution (agent, 40 min)

- [x] **Zip contract:** `karaoke-mp3-downloader.zip` has `manifest.json` at its Done in release.yml (zips the contents of `extension/`, checks `manifest.json` at the root) and in install.ps1 (refuses a zip without it).
      root (zip the *contents* of `extension/`, not the folder). `install.ps1`
      extracts straight into `extension/`.
- [x] `.github/workflows/release.yml`, on push of a `v*` tag: (1) fail if the Written; first live run on the `v1.0.0` tag (Phase 4).
      manifest `version` ≠ tag without `v`; (2) `node --test`; (3) zip; (4)
      Release with `softprops/action-gh-release` (`permissions: contents: write`,
      the Actions `GITHUB_TOKEN` — the PAT is not involved). Depends on Actions
      being enabled (Phase 1).
- [x] `install.ps1` at the root. Requirements: stock PowerShell 5.1, **no Written, UTF-8 BOM, parses clean; live test in Phase 4.
      admin**, independent of ExecutionPolicy (runs via `irm <url> | iex`, in
      memory), **UTF-8 with BOM** (5.1 misreads accents without it), idempotent
      (running again = update), never deletes the songs folder. Strings in
      English and pt-BR in one table; chosen by `(Get-UICulture).Name -like 'pt*'`.
  1. Folders: `$env:LOCALAPPDATA\KaraokeMP3\{extension,tmp}`. Real Downloads read
     from `HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders`
     (`{374DE290-123F-4565-9164-39C4925E467B}`, works with OneDrive) → create
     the songs folder (localised name, §9).
  2. **Chrome open?** (`Get-Process chrome`): on update, ask to close it
     **before** swapping the folder — with Chrome open the extension files are
     locked and the rename fails. Wait for the process to disappear.
  3. Download `releases/latest/download/karaoke-mp3-downloader.zip` (TLS 1.2),
     `Expand-Archive` into `tmp`, swap the `extension` folder in one go (rename),
     write `version.txt`.
  4. Desktop shortcuts (`WScript.Shell`), localised names (§9): songs folder →
     the folder; "Update Karaoke MP3" / "Atualizar Baixador" →
     `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm <url> | iex"`.
  5. First install: `Set-Clipboard` with the extension path, open
     `chrome://extensions` (`start chrome chrome://extensions`), show on screen:
     *Developer mode → Load unpacked → Ctrl+V → Enter*. **The only manual step,
     once** — it cannot be automated without §6 option 3.
  6. Update: at the end, "Open Chrome now? [Y/N]" (an unpacked extension is
     re-read from disk on start).
- [x] `-Zip <path>` parameter to test the installer with a local zip before a Implemented; a test zip is built with `Compress-Archive extension\* -DestinationPath karaoke-mp3-downloader.zip`.
      Release exists.

### Phase 4 — Automated tests and release (agent, see §5) — done 2026-09-26

- [x] Main scenario green on the modified extension, in both languages, with `tests/karaoke-mp3.spec.mjs`, pt-BR and en-US, 2026-09-25.
      screenshot/video in `test-results/`.
- [ ] Follow-up scenarios from §5 (double click, emoji, offline). Not automated yet; the double click is covered by the disabled-button check in the main spec, and the sanitiser by the unit tests.
- [x] `node --test` green. 11 unit tests.
- [x] Tag `v1.0.0` → Release published (check the workflow ran) → test
      `install.ps1` in a clean Windows profile on Vinicius's machine. Tag pushed 2026-09-25; the workflow run succeeded and the Release carries `karaoke-mp3-downloader.zip` (10.3 MB). Installer tested with a local zip (first-install path) on Vinicius's machine: folders, shortcuts, clipboard and chrome://extensions all right. Still to do: the update path against the real Release (Chrome closed), then clean the test install up. Update path done 2026-09-26 against the real Release: zip fetched from `releases/latest`, the close-Chrome prompt worked, folder swapped, `version.txt` 1.0.0, 18 files identical to the tag (modulo line endings).

### Phase 5 — Dad's laptop (Vinicius, 10 min)

Everything he needs is in [README.pt-BR.md](../README.pt-BR.md). What to expect
from the installer, seen on Vinicius's machine: it downloads the zip, creates the
folders and shortcuts, copies the extension path and opens `chrome://extensions`;
the only manual step is Developer mode → Load unpacked → Ctrl+V → Enter.

- [x] Windows 11 + Google Chrome + uBlock Origin Lite installed (2026-09-25).
- [ ] uBO Lite in **"Complete"** mode on youtube.com: with YouTube open, click
      the uBO Lite icon → move the slider to "Complete" → accept the permission
      to read/change data on youtube.com. Check with a video that usually has ads.
- [ ] Check that his Chrome is in Portuguese (`chrome://settings/languages`);
      otherwise the extension shows up in English.
- [ ] PowerShell as his user:
      `irm https://raw.githubusercontent.com/alex-vinny/karaoke-mp3-downloader/main/install.ps1 | iex`
- [ ] `chrome://extensions`: Developer mode → Load unpacked → Ctrl+V → Enter.
      (No toolbar icon: the extension has no popup.)
- [ ] Download one song with him watching; show "Open folder" and the shortcut;
      teach the pop-up's "Cancel" (§6), if it still exists.
- [ ] Leave Windows Quick Assist ready for remote support.
- [ ] Ask whether he also wants the video with lyrics (would be a version 2; does
      not change 1.0).

## 5. Playwright tests

**Why:** Vinicius has a broken arm; the agent tests on its own and keeps evidence
(screenshot/video) that he can read himself.

**Setup** (repo root, dev only — `extension/` stays build-free): `package.json`
with devDependencies `@playwright/test` and `music-metadata` (validates the MP3),
`npx playwright install chromium`, `playwright.config.mjs`,
`tests/karaoke-mp3.spec.mjs`, `tests/unit/*.test.mjs`; `npm test` runs
`node --test` and then Playwright.

**Loading the extension** (Playwright's official "Chrome extensions" doc):

```js
const context = await chromium.launchPersistentContext('tests/.tmp/profile', {
  channel: 'chromium',          // Playwright's Chromium, not branded Chrome → --load-extension still works
  headless: false,              // headed first; try the new headless later
  args: [
    `--disable-extensions-except=${ext}`,
    `--load-extension=${ext}`,
    '--disable-blink-features=AutomationControlled',
    '--lang=pt-BR',             // UI language → picks the _locales; a second project uses en-US
  ],
});
```

The `userDataDir` is fixed and git-ignored: reusing the profile between runs
reduces YouTube's "Sign in to confirm you're not a bot". If it still shows up,
open the profile by hand once and play a few videos.

If a test needs an ad blocker: download `uBOLite_*.chromium.mv3.zip` from the
`uBlockOrigin/uBOL-home` releases into `tests/vendor/` (git-ignored) and pass both
folders, comma-separated, in the two args.

**Main scenario:**

1. Open `https://www.youtube.com/watch?v=jNQXAC9IVRw` ("Me at the zoo", 19 s,
   YouTube's official channel — short, stable, no ads). Close the consent dialog
   if it appears.
2. Wait for the `[data-testid="karaoke-mp3-download"]` button with the text of
   the test project's language.
3. Click; wait for the "done" toast (3-min timeout).
4. Check the file: in the language's songs folder, sanitised name, valid MP3
   with duration 19 s ± 2 s and a `title` tag (`music-metadata`).
5. Screenshot + video in `test-results/`.

**Spike result (Phase 0):** the download is triggered by the extension, not the
page, and Playwright forces `Browser.setDownloadBehavior` = `allowAndName`.
- Technique A (`context.newCDPSession(page)` → `Browser.setDownloadBehavior({ behavior: 'allow', downloadPath })`): the **folder** holds, the **name** does not — the file lands as `<guid>.mp3`; no `Browser.download*` event reaches the page session.
- Technique B (`context.serviceWorkers()[0].evaluate(() => chrome.downloads.search({}))`): works — real path, `state`, `bytesReceived`, `mime`. This is the source for "the file exists and is complete".
- Name and sub-folder the extension asked for: the toast's `data-filename` attribute. `page.on('download')` never fires for an extension-initiated download (checked in Phase 2).

**Follow-up scenarios:** double click (button disabled); video with an
emoji-laden title (sanitising); offline (error message).

**Limits:** does not run on GitHub Actions (YouTube blocks datacenter IPs — CI
only runs `node --test` and publishes the Release). Does not cover the developer
mode pop-up: it only exists in branded Chrome, and "Load unpacked" opens a native
Windows dialog.

## 6. "Disable developer mode extensions" pop-up

**Resolved 2026-09-26:** Chrome 153.0.8010.53 on Vinicius's machine shows no such
pop-up after a restart with the unpacked extension loaded. Kept below for history,
in case an older Chrome on Dad's laptop still shows it (Phase 5 will tell).

If it still exists: it shows on every browser start, for every unpacked
extension. No flag, setting or command line turns it off (`--load-extension`
removed in Chrome 137; `ExtensionInstallForcelist` outside the store only works
on managed machines). Options, by effort:

1. **Default: accept it and teach "Cancel".** It only shows on a cold start. If he
   clicks "Disable", the extension is merely switched off (re-enable in
   `chrome://extensions`, 30 s remotely).
2. **Test (10 min, manual, in Vinicius's official Chrome):**
   `HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionInstallAllowlist\1 = <fixed ID>`.
   Reports say it silences the warning; no official confirmation. Needs admin
   (HKLM) and Chrome then shows "Managed by your organization".
3. **Definitive (~3 h):** Chrome Enterprise Core (free; needs a verified domain in
   a Google Admin account) + `.crx` signed with the vault key + `update.xml` on
   GitHub Pages → forced install, no developer mode, auto-updates, cannot be
   removed by accident. Only if the pop-up really annoys after 1–2 weeks.

## 7. Risks

- **The ad blocker is the weak link.** uBO Lite (MV3) is what runs on current
  Chrome; YouTube changes ad delivery often. Symptom: the capture aborts. With the
  `ad-showing` handling (Phase 2) Dad sees "an ad started" instead of a generic error.
- **YouTube player changes break the hook.** Remedy: `git fetch upstream` → merge
  → test (§5) → new tag → Dad clicks "Update Karaoke MP3".
- **YouTube walls automated Chromium** ("Sign in to confirm you're not a bot").
  Mitigation in §5 (reused profile, automation flag hidden).
- **Windows language ≠ Chrome language** → songs folder with two names (see §2).
  Phase 5 checks Dad's Chrome is in Portuguese.
- Closing the tab mid-way aborts.
- Chrome 137+: no command-line shortcut; always "Load unpacked".

## 8. Plan B

Portable `yt-dlp.exe` + `ffmpeg.exe` + a small PowerShell/WinForms window (also
install-free): paste link → MP3. More robust and needs no ad blocker; worse UX
(copying the URL). Use it if Phase 4 shows instability.

## 9. Approved copy

- **Repo About (English):** "One button to download MP3 from YouTube. Made for my dad, an amateur karaoke singer."
- **README.md (top, English):** "A fork of [Triangle-Downloader](https://github.com/HelpFreedom/Triangle-Downloader), simplified for my dad — an amateur karaoke singer who uses YouTube as his songbook. One button: **Download MP3**."
- **README.pt-BR.md (top):** "Fork do [Triangle-Downloader](https://github.com/HelpFreedom/Triangle-Downloader), simplificado para o meu pai — cantor amador de karaokê que usa o YouTube como repertório. Um botão só: **Baixar MP3**."
- **Extension messages (`_locales`):**

| key | en (default) | pt_BR |
|---|---|---|
| `extName` | Karaoke MP3 Downloader | Baixar MP3 (karaokê) |
| `extDescription` | One button in the YouTube player to save the song as MP3. Made for my dad, an amateur karaoke singer. | Um botão no player do YouTube para salvar a música em MP3. Feito para o meu pai, cantor amador de karaokê. |
| `button` | ⬇ Download MP3 | ⬇ Baixar MP3 |
| `downloading` | Downloading… $1% | Baixando… $1% |
| `converting` | Converting to MP3… | Convertendo para MP3… |
| `keepTabOpen` | Don't close this tab | Não feche esta aba |
| `done` | Done! Saved in "Songs to sing" | Pronto! Está em "Músicas para cantar" |
| `openFolder` | Open folder | Abrir pasta |
| `error` | Something went wrong ($1, v$2). Reload the page (F5) and try again. | Deu erro ($1, v$2). Recarregue a página (F5) e tente de novo. |
| `adDetected` | An ad started playing. Check that uBlock Origin Lite is set to "Complete" and try again. | Apareceu anúncio. Confira se o uBlock Origin Lite está em modo "Completo" e tente de novo. |
| `updateAvailable` | Update available: click "Update Karaoke MP3" on your desktop | Tem atualização: clique em "Atualizar Baixador" na área de trabalho |
| `songsFolder` | Songs to sing | Músicas para cantar |

- **Installer and shortcuts** (same en / pt-BR rule): folder and shortcut
  `songsFolder`; update shortcut "Update Karaoke MP3" / "Atualizar Baixador";
  the remaining prompts are written in Phase 3½ in the tone of the table.

## 10. For whoever picks this up (human or agent)

- Read this file and `C:\sources\claude-tools\AGENTS.md` (vault and PAT usage).
  No `gh` installed: REST API with `curl`, PAT injected by `vault run`, never printed.
- Claude Code's auto mode blocks the vault: it needs `vault unlock` (Vinicius, in
  his terminal) and the rule in `.claude/settings.local.json` (git-ignored, this
  machine only).
- Order: Phase 1 → 0 → 2 → 3 → 3½ → 4 → tag `v1.0.0` → 5.
- Write scope: this folder only. Do not touch Vinicius's Chrome without asking.
- Upstream files are CRLF on disk (Windows checkout; LF in the repo). Scripts that
  edit them must normalise line endings, or multi-line anchors never match.
- Tick the checkboxes here as you go; this file is the source of truth for status.
