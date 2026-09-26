#Requires -Version 5.1
<#
  Karaoke MP3 Downloader - installer and updater for Windows.

  Run (no admin, nothing outside %LOCALAPPDATA%, Downloads and the desktop):
    irm https://raw.githubusercontent.com/alex-vinny/karaoke-mp3-downloader/main/install.ps1 | iex

  Running it again updates the extension in place. The songs folder is never
  deleted. Messages follow the Windows display language: Portuguese (pt-*) or
  English, the same rule the extension uses for its own texts.

  -Zip <path>   install from a local zip instead of the latest GitHub release
                (testing before a release exists):
                powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Zip .\karaoke-mp3-downloader.zip
#>
param([string]$Zip)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repo         = 'alex-vinny/karaoke-mp3-downloader'
$ZipUrl       = "https://github.com/$Repo/releases/latest/download/karaoke-mp3-downloader.zip"
$InstallerUrl = "https://raw.githubusercontent.com/$Repo/main/install.ps1"
$Base         = Join-Path $env:LOCALAPPDATA 'KaraokeMP3'
$ExtDir       = Join-Path $Base 'extension'
$TmpDir       = Join-Path $Base 'tmp'
$VersionFile  = Join-Path $Base 'version.txt'

# ---- strings -------------------------------------------------------------------
$pt = (Get-UICulture).Name -like 'pt*'
$S = if ($pt) { @{
  Title       = 'Baixar MP3 (karaoke) - instalador'
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
    'Depois abra qualquer vídeo no YouTube: o botão "Baixar MP3" fica no player.',
    '')
  NoChrome    = 'Não achei o Chrome para abrir. Abra o Chrome, digite chrome://extensions e siga os passos acima.'
  Updated     = 'Atualizado: {0} -> {1}. O Chrome carrega a nova versão quando for aberto de novo.'
  Same        = 'Já estava na versão {0}; reinstalado.'
  OpenChrome  = 'Abrir o Chrome agora? [S/N]'
  Yes         = '^[sS]'
  Done        = 'Pronto.'
  Failed      = 'Deu erro: {0}'
  PressEnter  = 'Pressione Enter para fechar'
} } else { @{
  Title       = 'Karaoke MP3 Downloader - installer'
  SongsFolder = 'Songs to sing'
  UpdateLink  = 'Update Karaoke MP3'
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
    'Then open any video on YouTube: the "Download MP3" button is in the player.',
    '')
  NoChrome    = 'Could not find Chrome to open it. Open Chrome, type chrome://extensions and follow the steps above.'
  Updated     = 'Updated: {0} -> {1}. Chrome loads the new version the next time it starts.'
  Same        = 'Already on version {0}; reinstalled.'
  OpenChrome  = 'Open Chrome now? [Y/N]'
  Yes         = '^[yY]'
  Done        = 'Done.'
  Failed      = 'Something went wrong: {0}'
  PressEnter  = 'Press Enter to close'
} }

function Get-DownloadsFolder {
  # The real Downloads folder (works when OneDrive or the user moved it).
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders'
  $raw = (Get-ItemProperty -Path $key -ErrorAction SilentlyContinue).'{374DE290-123F-4565-9164-39C4925E467B}'
  if ($raw) { return [Environment]::ExpandEnvironmentVariables($raw) }
  return (Join-Path $env:USERPROFILE 'Downloads')
}

function New-Shortcut([string]$Path, [string]$Target, [string]$Arguments, [string]$Icon) {
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($Path)
  $lnk.TargetPath = $Target
  if ($Arguments) { $lnk.Arguments = $Arguments }
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
  if (-not $firstInstall) {
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

  # 5. desktop shortcuts: the songs folder, and "update" = this same one-liner
  $desktop = [Environment]::GetFolderPath('Desktop')
  New-Shortcut -Path (Join-Path $desktop "$($S.SongsFolder).lnk") -Target $Songs -Icon '%SystemRoot%\System32\shell32.dll,116'
  New-Shortcut -Path (Join-Path $desktop "$($S.UpdateLink).lnk") `
    -Target "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
    -Arguments "-NoProfile -ExecutionPolicy Bypass -Command `"irm $InstallerUrl | iex`"" `
    -Icon '%SystemRoot%\System32\shell32.dll,238'
  Write-Host ($S.Shortcuts -f $S.SongsFolder, $S.UpdateLink)
  Write-Host ($S.Songs -f $Songs)

  # 6. first install: hand over the path and open chrome://extensions; update: offer to reopen Chrome
  if ($firstInstall) {
    Set-Clipboard -Value $ExtDir
    $S.FirstRun | ForEach-Object { Write-Host $_ -ForegroundColor Green }
    Write-Host $ExtDir
    Write-Host ''
    if (-not (Start-Chrome 'chrome://extensions')) { Write-Host $S.NoChrome -ForegroundColor Yellow }
    Read-Host $S.PressEnter | Out-Null
  } else {
    if ($oldVersion -and $oldVersion -ne $newVersion) { Write-Host ($S.Updated -f $oldVersion, $newVersion) -ForegroundColor Green }
    else { Write-Host ($S.Same -f $newVersion) }
    $answer = Read-Host $S.OpenChrome
    if ($answer -match $S.Yes) { Start-Chrome 'https://www.youtube.com/' | Out-Null }
  }
  Write-Host $S.Done -ForegroundColor Cyan
} catch {
  Write-Host ($S.Failed -f $_.Exception.Message) -ForegroundColor Red
  Read-Host $S.PressEnter | Out-Null
  exit 1
}
