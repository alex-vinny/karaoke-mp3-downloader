#Requires -Version 5.1
<#
  Karaoke Downloader - installer and updater for Windows.

  Run (no admin, nothing outside %LOCALAPPDATA%, Downloads and the desktop):
    irm https://raw.githubusercontent.com/alex-vinny/karaoke-mp3-downloader/main/install.ps1 | iex

  Running it again updates the extension in place. The songs folder is never
  deleted. Messages follow the Windows display language: Portuguese (pt-*) or
  English, the same rule the extension uses for its own texts.

  The "update" desktop shortcut runs %LOCALAPPDATA%\KaraokeMP3\update.cmd, which
  starts a local copy of this script (install.ps1 next to it); that copy fetches the
  latest installer from GitHub and hands over to it before doing anything (step 0).

  -Zip <path>     install from a local zip instead of the latest GitHub release
                  (testing before a release exists):
                  powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Zip .\karaoke-mp3-downloader.zip
  -NoSelfUpdate   skip step 0 (set by step 0 itself when it hands over)

  Tests (tests/unit/installer.test.mjs) set KARAOKE_TEST_ROOT: everything then lands
  under that folder (KaraokeMP3, Desktop, Downloads), Chrome, the clipboard and the
  prompts are skipped, and KARAOKE_ZIP_URL / KARAOKE_INSTALLER_URL replace the
  GitHub URLs (file:// works).
#>
param([string]$Zip, [switch]$NoSelfUpdate)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repo         = 'alex-vinny/karaoke-mp3-downloader'
$ZipUrl       = "https://github.com/$Repo/releases/latest/download/karaoke-mp3-downloader.zip"
$InstallerUrl = "https://raw.githubusercontent.com/$Repo/main/install.ps1"
$TestRoot     = $env:KARAOKE_TEST_ROOT
if ($TestRoot) {
  if ($env:KARAOKE_ZIP_URL)       { $ZipUrl       = $env:KARAOKE_ZIP_URL }
  if ($env:KARAOKE_INSTALLER_URL) { $InstallerUrl = $env:KARAOKE_INSTALLER_URL }
}
$Base         = if ($TestRoot) { Join-Path $TestRoot 'KaraokeMP3' } else { Join-Path $env:LOCALAPPDATA 'KaraokeMP3' }
$ExtDir       = Join-Path $Base 'extension'
$TmpDir       = Join-Path $Base 'tmp'
$VersionFile  = Join-Path $Base 'version.txt'
$LocalScript  = Join-Path $Base 'install.ps1'   # the copy the desktop shortcut runs
$UpdateCmd    = Join-Path $Base 'update.cmd'

# 0. Started from the local copy (the desktop shortcut): fetch the latest installer and
#    hand over to it, so the update logic itself stays current. Offline, or with GitHub
#    down, this copy carries on and the zip download below says what is wrong.
if ($PSCommandPath -and -not $Zip -and -not $NoSelfUpdate) {
  $latest = Join-Path (Split-Path -Parent $PSCommandPath) 'install.new.ps1'
  $changed = $false
  try {
    Invoke-WebRequest -Uri $InstallerUrl -OutFile $latest -UseBasicParsing
    $changed = (Get-Content $latest -Raw) -ne (Get-Content $PSCommandPath -Raw)
  } catch { $changed = $false }
  if ($changed) {
    try { & $latest -NoSelfUpdate } finally { Remove-Item $latest -Force -ErrorAction SilentlyContinue }
    if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 0 }
  }
  Remove-Item $latest -Force -ErrorAction SilentlyContinue
}

# ---- strings -------------------------------------------------------------------
$pt = (Get-UICulture).Name -like 'pt*'
$S = if ($pt) { @{
  Title       = 'Baixar vídeo (karaokê) - instalador'
  SongsFolder = 'Músicas para cantar'
  UpdateLink  = 'Atualizar Baixador'
  Downloading = 'Baixando a última versão...'
  UsingZip    = 'Usando o zip local: {0}'
  BadZip      = 'O zip não tem um manifest.json na raiz. Abortando.'
  CloseChrome = 'O Chrome está aberto e a extensão só pode ser trocada com ele fechado. Feche TODAS as janelas do Chrome e pressione Enter...'
  Installing  = 'Instalando a versão {0} em {1}'
  Shortcuts   = 'Atalhos na área de trabalho: "{0}" e "{1}".'
  Songs       = 'Pasta das músicas: {0}'
  FirstRun    = @(
    '',
    'FALTA UM PASSO, SÓ NA PRIMEIRA VEZ.',
    'O caminho da extensão já está copiado (Ctrl+V). Na janela do Chrome que vai abrir:',
    '  1. Ligue o "Modo do desenvolvedor" (canto superior direito)',
    '  2. Clique em "Carregar sem compactação"',
    '  3. Cole o caminho (Ctrl+V) e pressione Enter',
    'Depois abra qualquer vídeo no YouTube: o botão vermelho "Baixar vídeo" fica no canto do player.',
    '')
  NoChrome    = 'Não achei o Chrome para abrir. Abra o Chrome, digite chrome://extensions e siga os passos acima.'
  Updated     = 'Atualizado: {0} -> {1}. O Chrome carrega a nova versão quando for aberto de novo.'
  Same        = 'Já estava na versão {0}; reinstalado.'
  OpenChrome  = 'Abrir o Chrome agora? [S/N]'
  Yes         = '^[sS]'
  Done        = 'Pronto.'
  Failed      = 'Deu erro: {0}'
  PressEnter  = 'Pressione Enter para fechar'
  NoPowerShell = 'Nao encontrei o PowerShell neste computador. Diga isso para quem instalou.'
} } else { @{
  Title       = 'Karaoke Downloader - installer'
  SongsFolder = 'Songs to sing'
  UpdateLink  = 'Update Karaoke Downloader'
  Downloading = 'Downloading the latest release...'
  UsingZip    = 'Using local zip: {0}'
  BadZip      = 'The zip has no manifest.json at its root. Aborting.'
  CloseChrome = 'Chrome is open and the extension can only be replaced while it is closed. Close ALL Chrome windows and press Enter...'
  Installing  = 'Installing version {0} into {1}'
  Shortcuts   = 'Desktop shortcuts: "{0}" and "{1}".'
  Songs       = 'Songs folder: {0}'
  FirstRun    = @(
    '',
    'ONE MORE STEP, FIRST TIME ONLY.',
    'The extension path is already on your clipboard (Ctrl+V). In the Chrome window that opens:',
    '  1. Turn on "Developer mode" (top right)',
    '  2. Click "Load unpacked"',
    '  3. Paste the path (Ctrl+V) and press Enter',
    'Then open any video on YouTube: the red "Download video" button is in the corner of the player.',
    '')
  NoChrome    = 'Could not find Chrome to open it. Open Chrome, type chrome://extensions and follow the steps above.'
  Updated     = 'Updated: {0} -> {1}. Chrome loads the new version the next time it starts.'
  Same        = 'Already on version {0}; reinstalled.'
  OpenChrome  = 'Open Chrome now? [Y/N]'
  Yes         = '^[yY]'
  Done        = 'Done.'
  Failed      = 'Something went wrong: {0}'
  PressEnter  = 'Press Enter to close'
  NoPowerShell = 'Could not find PowerShell on this computer. Tell whoever set this up.'
} }

function Get-DownloadsFolder {
  # The real Downloads folder (works when OneDrive or the user moved it).
  if ($TestRoot) { return (Join-Path $TestRoot 'Downloads') }
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders'
  $raw = (Get-ItemProperty -Path $key -ErrorAction SilentlyContinue).'{374DE290-123F-4565-9164-39C4925E467B}'
  if ($raw) { return [Environment]::ExpandEnvironmentVariables($raw) }
  return (Join-Path $env:USERPROFILE 'Downloads')
}

function New-Shortcut([string]$Path, [string]$Target, [string]$Arguments, [string]$Icon, [string]$WorkDir) {
  # CreateShortcut opens an existing .lnk, so every field is set (an empty string
  # clears what an older installer left there).
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($Path)
  $lnk.TargetPath = $Target
  $lnk.Arguments = [string]$Arguments
  $lnk.WorkingDirectory = [string]$WorkDir
  if ($Icon) { $lnk.IconLocation = $Icon }
  $lnk.Save()
}

function Start-Chrome([string]$Url) {
  try { Start-Process 'chrome' -ArgumentList $Url; return $true } catch {}
  foreach ($p in @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
                   "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
                   "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe")) {
    if (Test-Path $p) { Start-Process $p -ArgumentList $Url; return $true }
  }
  return $false
}

try {
  Write-Host ''
  Write-Host "== $($S.Title) ==" -ForegroundColor Cyan

  # 1. folders
  New-Item -ItemType Directory -Force -Path $Base | Out-Null
  if (Test-Path $TmpDir) { Remove-Item -Recurse -Force $TmpDir }
  New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null
  $Songs = Join-Path (Get-DownloadsFolder) $S.SongsFolder
  New-Item -ItemType Directory -Force -Path $Songs | Out-Null

  $firstInstall = -not (Test-Path (Join-Path $ExtDir 'manifest.json'))
  $oldVersion = if (Test-Path $VersionFile) { (Get-Content $VersionFile -Raw).Trim() } else { $null }

  # 2. get the zip (release or local) and unpack it into tmp
  $zipPath = Join-Path $TmpDir 'karaoke-mp3-downloader.zip'
  if ($Zip) {
    Write-Host ($S.UsingZip -f $Zip)
    Copy-Item -Path $Zip -Destination $zipPath
  } else {
    Write-Host $S.Downloading
    Invoke-WebRequest -Uri $ZipUrl -OutFile $zipPath -UseBasicParsing
  }
  $extract = Join-Path $TmpDir 'extension'
  Expand-Archive -Path $zipPath -DestinationPath $extract -Force
  $manifestPath = Join-Path $extract 'manifest.json'
  if (-not (Test-Path $manifestPath)) { throw $S.BadZip }
  $newVersion = (Get-Content $manifestPath -Raw | ConvertFrom-Json).version

  # 3. Chrome must be closed before the folder is swapped: it keeps the files locked
  if (-not $firstInstall -and -not $TestRoot) {
    while (Get-Process chrome -ErrorAction SilentlyContinue) {
      Write-Host $S.CloseChrome -ForegroundColor Yellow
      Read-Host | Out-Null
    }
  }

  # 4. swap the extension folder in one move (old copy kept until the new one is in place)
  Write-Host ($S.Installing -f $newVersion, $ExtDir)
  $oldDir = Join-Path $Base 'extension.old'
  if (Test-Path $oldDir) { Remove-Item -Recurse -Force $oldDir }
  if (Test-Path $ExtDir) { Move-Item -Path $ExtDir -Destination $oldDir }
  try {
    Move-Item -Path $extract -Destination $ExtDir
  } catch {
    if (Test-Path $oldDir) { Move-Item -Path $oldDir -Destination $ExtDir }
    throw
  }
  if (Test-Path $oldDir) { Remove-Item -Recurse -Force $oldDir }
  Set-Content -Path $VersionFile -Value $newVersion -Encoding ASCII
  Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue

  # 5. a local copy of this script, and the small .cmd the "update" shortcut runs: it
  #    finds PowerShell through PATH (falling back to pwsh), keeps any error on screen,
  #    and the local script fetches the latest installer before doing anything (step 0).
  #    Until v1.1.0 the shortcut ran powershell.exe -Command "irm <url> | iex" itself:
  #    on Dad's Windows 11 that ended in a "cannot find powershell.exe" box (cause not
  #    found), and with -Command a failed download closed the window before it could be read.
  if ($PSCommandPath) {
    if ($PSCommandPath -ne $LocalScript) { Copy-Item -Path $PSCommandPath -Destination $LocalScript -Force }
  } else {
    Invoke-WebRequest -Uri $InstallerUrl -OutFile $LocalScript -UseBasicParsing   # run from memory (irm | iex): nothing on disk yet
  }
  $cmdLines = @(
    '@echo off',
    "title $($S.UpdateLink)",
    'where powershell >nul 2>&1',
    'if %errorlevel%==0 (',
    '  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"',
    '  exit /b',
    ')',
    'where pwsh >nul 2>&1',
    'if %errorlevel%==0 (',
    '  pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"',
    '  exit /b',
    ')',
    "echo $($S.NoPowerShell)",
    'pause'
  )
  Set-Content -Path $UpdateCmd -Value $cmdLines -Encoding ASCII

  # desktop shortcuts: the songs folder, and "update" = the .cmd above
  $desktop = if ($TestRoot) { Join-Path $TestRoot 'Desktop' } else { [Environment]::GetFolderPath('Desktop') }
  New-Item -ItemType Directory -Force -Path $desktop | Out-Null
  New-Shortcut -Path (Join-Path $desktop "$($S.SongsFolder).lnk") -Target $Songs -Icon '%SystemRoot%\System32\shell32.dll,116'
  New-Shortcut -Path (Join-Path $desktop "$($S.UpdateLink).lnk") -Target $UpdateCmd -WorkDir $Base -Icon '%SystemRoot%\System32\shell32.dll,238'
  # v1.0.0 named the English shortcut "Update Karaoke MP3"; drop it so there is only one
  $stale = Join-Path $desktop 'Update Karaoke MP3.lnk'
  if ($S.UpdateLink -ne 'Update Karaoke MP3' -and (Test-Path $stale)) { Remove-Item -Force $stale }
  Write-Host ($S.Shortcuts -f $S.SongsFolder, $S.UpdateLink)
  Write-Host ($S.Songs -f $Songs)

  # 6. first install: hand over the path and open chrome://extensions; update: offer to reopen Chrome
  if ($firstInstall) {
    if (-not $TestRoot) { Set-Clipboard -Value $ExtDir }
    $S.FirstRun | ForEach-Object { Write-Host $_ -ForegroundColor Green }
    Write-Host $ExtDir
    Write-Host ''
    if (-not $TestRoot) {
      if (-not (Start-Chrome 'chrome://extensions')) { Write-Host $S.NoChrome -ForegroundColor Yellow }
      Read-Host $S.PressEnter | Out-Null
    }
  } else {
    if ($oldVersion -and $oldVersion -ne $newVersion) { Write-Host ($S.Updated -f $oldVersion, $newVersion) -ForegroundColor Green }
    else { Write-Host ($S.Same -f $newVersion) }
    if (-not $TestRoot) {
      $answer = Read-Host $S.OpenChrome
      if ($answer -match $S.Yes) { Start-Chrome 'https://www.youtube.com/' | Out-Null }
    }
  }
  Write-Host $S.Done -ForegroundColor Cyan
} catch {
  Write-Host ($S.Failed -f $_.Exception.Message) -ForegroundColor Red
  if (-not $TestRoot) { Read-Host $S.PressEnter | Out-Null }
  exit 1
}
