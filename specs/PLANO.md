# Karaoke MP3 Downloader — Plano

**Estado:** Fase 1 concluída (fork, rename, Actions, clone, commit inicial). Próxima: Fase 0 (baseline).
**Atualizado em:** 2026-09-25.

## 1. Objetivo

Uma extensão Chrome com **um botão só — "⬇ Download MP3" / "⬇ Baixar MP3"** —
dentro do player do YouTube, para o pai do Vinicius: cantor amador de karaokê
que usa o YouTube como repertório e cujo laptop **não tem nenhuma ferramenta de
desenvolvimento**.

Fork do [Triangle-Downloader](https://github.com/HelpFreedom/Triangle-Downloader)
(GPL-3), simplificado, **em inglês por padrão com pt-BR automático** (`_locales`:
o Chrome escolhe pelo idioma do navegador) e distribuído pelo GitHub com um
instalador PowerShell de uma linha. Qualquer pessoa pode usar; o pai vê tudo em
português sem configurar nada.

## 2. Decisões tomadas

| Tema | Decisão | Motivo |
|---|---|---|
| Base | Fork de `HelpFreedom/Triangle-Downloader` | GPL-3 obriga manter licença/crédito; fork permite `git fetch upstream` quando o YouTube quebrar algo |
| Nome do repo | `alex-vinny/karaoke-mp3-downloader` (fork criado como `baixar-mp3-karaoke` e renomeado em 2026-09-25; o GitHub redireciona o nome antigo) | Inglês é a língua do projeto. A pasta local continua `baixar-mp3-karaoke` — não precisa coincidir |
| Idioma | Repositório, README principal, código, comentários, nomes de arquivo e instalador em **inglês**. Textos visíveis da extensão em `_locales/en` (padrão) e `_locales/pt_BR`. `README.pt-BR.md` com a dedicatória em português. Instalador fala pt-BR quando o Windows é pt-BR | A tradução de página do Chrome **não** alcança textos injetados pela extensão (o YouTube do pai já está em pt-BR; o Chrome nem oferece traduzir). `_locales` é o mecanismo nativo: `chrome.i18n.getMessage` funciona em content script, background e offscreen |
| Diff mínimo | Esconder o menu por CSS, chamar o `download()` existente com parâmetros fixos, strings por `t(key)`; **não reescrever o hook** | Merge do upstream continua viável quando o YouTube mudar o player |
| Navegador do pai | Google Chrome no **Windows 11** | Confirmado em 2026-09-25. Já tem **uBlock Origin Lite** instalado; precisa estar no modo **"Completo"** (Complete) em youtube.com — no "Básico" padrão o anúncio entra no stream e a captura aborta |
| Anúncios | Botão desabilitado enquanto `#movie_player` tiver a classe `ad-showing`; anúncio no meio da captura aborta com mensagem clara (`adDetected`) | O hook do upstream não detecta anúncio; sem isso o sintoma é MP3 estragado ou erro genérico |
| Pasta de dev | `C:\sources\extensions\baixar-mp3-karaoke` (esta) | |
| Pasta no laptop do pai | `%LOCALAPPDATA%\KaraokeMP3\extension` | Sem admin, invisível para ele, fora de Downloads (não apaga sem querer) |
| Pasta das músicas | `Downloads\<songsFolder>`: "Músicas para cantar" (pt-BR) / "Songs to sing" (en). A extensão lê `chrome.i18n.getMessage('songsFolder')`; o instalador decide por `Get-UICulture` | Nome pelo propósito, localizado como o resto. Risco pequeno: Windows num idioma e Chrome em outro → dois nomes; o Chrome cria a subpasta sozinho no primeiro download, só o atalho apontaria errado |
| Botão | "⬇ Download MP3" / "⬇ Baixar MP3" | Uma ação, sem menu |
| Ícone na barra | **Não há** (o upstream não tem `action`/popup e não vamos criar) | Menos diff; a pasta abre pelo atalho da área de trabalho e pelo "Abrir pasta" do toast |
| Distribuição | GitHub Release (zip de `extension/`) + `install.ps1` na raiz | URL fixa `releases/latest/download/karaoke-mp3-downloader.zip` |
| Aviso de atualização | `GET https://api.github.com/repos/alex-vinny/karaoke-mp3-downloader/releases/latest` → `tag_name`, 1×/dia no `background.js` via `chrome.alarms` | A Release é o que o instalador baixa; ler o manifest de `main` avisaria de versão que ainda não dá para baixar. A API responde com CORS `*`; 60 req/h por IP bastam |
| Instalação | "Carregar sem compactação" (modo desenvolvedor) | `.crx` fora da loja é bloqueado no Windows; Chrome Web Store rejeita downloaders de YouTube; `--load-extension` foi removido do Chrome oficial no 137 (2025) |
| Testes | Playwright **local** (Chromium do Playwright) + `node --test` para funções puras | YouTube bloqueia IPs de datacenter (GitHub Actions); só os unitários rodam em CI |
| Ferramentas | git 2.54, Node 22, npm 10. **Sem `gh`** → API REST do GitHub via `curl` com o PAT do vault. PAT `github-pat` tem `repo` + `workflow` (conferido 2026-09-25; `workflow` é obrigatório para dar push em `.github/workflows/`) | Ver §10 |

## 3. Como o Triangle funciona (resumo)

Pasta `extension/` (v1.4.6, último commit upstream 2026-08-26; 90 estrelas, 9
forks, branch `main`). Sem build: é só uma pasta.

- `manifest.json`: MV3, `permissions: downloads, offscreen, storage`,
  `host_permissions: *://www.youtube.com/*`, CSP com `wasm-unsafe-eval`.
  **Sem** `key`, `action`, `_locales`, `minimum_chrome_version`.
- `content_hook.js` (mundo MAIN, `document_start`): intercepta
  `SourceBuffer.prototype.appendBuffer`, separa áudio/vídeo pelo MIME, trava a
  qualidade com `setPlaybackQualityRange(q,q)` e "seeks to the edge of the
  buffered region" até cobrir a faixa. Termina quando cobre até `capEnd - 0.4`
  ou `mediaEnd - 1.5`, ou após ~60 s sem progresso; **timeout fixo de 30 min**;
  aborta se o vídeo trocar. **Não trata anúncio.**
- `content_ui.js` + `content_ui.css` (mundo ISOLATED, `document_idle`):
  `ensureButton()` insere o ▽ em `.ytp-right-controls` (MutationObserver +
  `yt-navigate-finish`); menu (vídeo 1080p/720p, áudio MP3, legendas,
  VP9/H.264); `download()` manda a ordem para o hook; nome do arquivo =
  `safeName(title)` (100 chars, tira `[\/:*?"<>|]`) + sufixos; toast singleton.
  ~20 strings em russo espalhadas.
- `background.js`: mensagens `ytdl-ensure` (cria o offscreen document, sem
  duplicar) e `ytdl-save` → `chrome.downloads.download({ url, filename,
  saveAs: false })`. Tem um **segundo** sanitizador, `plainFilename()` (80 chars).
- `offscreen.html/js`: ffmpeg.wasm single-thread de `vendor/ffmpeg/`; MP3 =
  `-vn -c:a libmp3lame -b:a 192k`; **sem tags ID3**; resultado → Blob →
  `URL.createObjectURL` → `ytdl-save`; o blob vive 60 s.
- Raiz: `README.md` (russo), `README.en.md`, `LICENSE`, `docs/screenshot.png`,
  `.gitignore` (ignora `.claude/`, `.vscode/`… e **também `package.json` e
  `package-lock.json`**, que nós precisamos versionar).

Limites: só em `youtube.com/watch`; MP3 é re-encode single-thread (~1 min para
uma música de 4 min); fechar a aba no meio aborta.

## 4. Fases

**Ordem: 1 → 0 → 2 → 3 → 3½ → 4 → tag `v1.0.0` → 5.** A Fase 0 vem depois do
clone e antes de qualquer mudança no código.

### Fase 1 — Fork e clone (agente, 10 min)

- [x] Vault destravado pelo Vinicius (`vault unlock`, no terminal dele) e regra
      em `.claude/settings.local.json` liberando `vault run github-pat=GH_TOKEN -- …`
      (o modo automático do Claude Code bloqueia o vault sem ela). 2026-09-25.
- [x] Fork já com nome: `POST /repos/HelpFreedom/Triangle-Downloader/forks` com
      `{"name": …}` → 202 (assíncrono) → `GET /repos/alex-vinny/<nome>` até 200.
- [x] **Actions habilitado** — fork nasce com workflows desligados; sem isso a
      Fase 3½ nunca roda: `PUT /repos/…/actions/permissions` com
      `{"enabled":true,"allowed_actions":"all"}` → 204; GET confirma.
      Issues também nascem desligadas no fork — deixar assim.
- [x] Nesta pasta: `git init` → remotes `origin` e `upstream` → `git fetch
      --ipv4 origin` → `git checkout -b main origin/main` (v1.4.6, `ff60ae8`).
      `specs/`, `AGENTS.md` e `.claude/` não existem upstream → sem conflito.
- [x] Renomear para `karaoke-mp3-downloader` + descrição (§9) com `PATCH
      /repos/alex-vinny/baixar-mp3-karaoke`. **JSON por arquivo (`-d @req.json`)**:
      acentos em argv chegam mangled ao `curl` pelo MSYS (deu 400 "Problems
      parsing JSON"). Depois `git remote set-url origin`.
- [x] `.gitignore`: partir do upstream, **tirar `package.json` e
      `package-lock.json`**, acrescentar `test-results/`, `playwright-report/`,
      `tests/.tmp/`, `tests/vendor/`, `*.zip`. `.claude/` já vem ignorado.
- [x] Token só por `vault run github-pat=GH_TOKEN -- bash <script>`; dentro do
      script o header vai para o `curl` por stdin (`-K -`), nunca em argv.
      Push com a receita de `C:\sources\claude-tools\AGENTS.md` (extraheader
      via `GIT_CONFIG_*`, `credential.helper=` vazio, `--ipv4`).
- [x] Commit inicial com `specs/`, `AGENTS.md`, `.gitignore` → push.

### Fase 0 — Baseline (agente + Vinicius, 30 min)

Provar que o upstream **intacto** funciona hoje, para separar "quebrei" de "já
não funcionava".

- [ ] **Playwright (agente):** setup do §5 apontando para `extension/` sem
      alteração; abrir o vídeo de teste, clicar em ▽ → áudio MP3; capturar o
      download (técnica A, depois B). É o spike: sai daqui sabendo qual técnica
      funciona e se o YouTube barra o Chromium automatizado.
- [ ] **Chrome oficial (Vinicius, 5 min — pedir antes, §10):** carregar
      `extension/` sem compactação, baixar um MP3, fechar e reabrir o Chrome.
      Responde: o pop-up "Desativar extensões do modo de desenvolvedor" ainda
      existe no Chrome atual (decide o §6)? O upstream funciona fora do Playwright?
- [ ] Anotar o observado no §6 e §7.

### Fase 2 — Um botão só (agente, ~1 h)

Arquivos: `content_ui.js`, `content_ui.css`, `manifest.json`, `background.js`,
`offscreen.js` (só a linha do ffmpeg), `content_hook.js` (só o timeout); novos
`filename.js` e `_locales/`.

- [ ] **Ler `content_ui.js` inteiro antes de mexer.** Funções a tocar:
      `ensureButton()` (botão), `download()` (parâmetros fixos), o toast,
      `safeName()` (substituir pelo módulo comum).
- [ ] `_locales/en/messages.json` (padrão) e `_locales/pt_BR/messages.json` com
      a tabela do §9. Manifest: `default_locale: "en"`, `name:
      "__MSG_extName__"`, `description: "__MSG_extDescription__"`. Helper
      `t(key, ...subs)` = `chrome.i18n.getMessage(key, subs)` no topo de
      `content_ui.js`, `background.js` e `offscreen.js`. Placeholders
      posicionais `$1`, `$2` nas mensagens.
- [ ] Botão `t('button')` grande e legível no lugar do ▽, com
      `data-testid="karaoke-mp3-download"`. Menu escondido por CSS, não removido.
- [ ] Clique = `download()` com áudio, MP3, faixa completa (0 → fim). Botão
      desabilitado durante a captura (ignora clique duplo) e enquanto
      `#movie_player` tiver a classe `ad-showing`.
- [ ] Anúncio no meio da captura: MutationObserver no atributo `class` de
      `#movie_player`; se `ad-showing` aparecer, abortar e mostrar `t('adDetected')`.
- [ ] Toast com `t('keepTabOpen')` enquanto roda. Erros mostram código curto +
      versão (`t('error', [codigo, versao])`) para diagnóstico por telefone.
- [ ] Sanitizador **único** em `extension/filename.js` (função pura
      `safeFilename(title)`; `globalThis.safeFilename` para os content scripts e
      `module.exports` para o `node --test`): tirar emoji e símbolos, colapsar
      espaços, manter acentos, ≤ 60 caracteres, `.mp3`. Declarado no manifest
      antes de `content_ui.js`; usado também no `background.js` no lugar de
      `plainFilename()`. (Rádio de carro engasga com "🎵 … ‖ …".)
- [ ] `background.js`: `chrome.downloads.download({ url, filename:
      `${t('songsFolder')}/<nome>.mp3`, saveAs: false })` — o upstream já usa
      `chrome.downloads`; só muda o `filename`. Guardar o `downloadId` e
      devolver ao content script para o botão `t('openFolder')` →
      `chrome.downloads.show(id)` (Explorer com o MP3 selecionado).
- [ ] `offscreen.js`: acrescentar `-metadata title="<título>" -id3v2_version 3`
      (rádio de carro mostra o nome certo).
- [ ] `content_hook.js`: timeout fixo 30 min → 2 h (mix de karaokê de 1 h).
- [ ] Aviso de atualização no `background.js`: `chrome.alarms` 1×/dia
      (permissão `alarms`), `fetch` de
      `https://api.github.com/repos/alex-vinny/karaoke-mp3-downloader/releases/latest`,
      comparar `tag_name` (sem o `v`) com `chrome.runtime.getManifest().version`
      parte a parte, numérico; resultado em `chrome.storage.local`; o content
      script mostra `t('updateAvailable')` ao abrir `/watch`. `host_permissions`
      para `https://api.github.com/*`.
- [ ] `manifest.json`: `version` 1.0.0, **`key` fixo**. Gerar o par RSA uma vez
      (`openssl genrsa 2048`): chave privada no vault (`vault attach`, pasta a
      combinar com o Vinicius) e `key` = pública em DER/base64. ID estável em
      qualquer máquina; necessário para a allowlist do §6, para o `.crx` da
      opção 3 e para os testes.
- [ ] Código morto (vídeo, legendas, H.264, faixa de tempo): deixar
      inacessível pela UI, não remover. Prioridade é **não quebrar a captura**.
- [ ] `tests/unit/*.test.mjs` com `node --test`: `filename.js`, comparação de
      versão e paridade de chaves entre `en` e `pt_BR` (rodam em CI — não
      precisam de YouTube).

### Fase 3 — Idiomas e READMEs (agente, 30 min)

- [ ] Nenhuma string visível fora de `_locales` e nenhum russo sobrando:
      `grep -P '\p{Cyrillic}' extension/*.js` vazio. Comentários em inglês.
- [ ] `README.md` (inglês, principal, curto): link para `README.pt-BR.md` no
      topo, dedicatória (§9), o que faz, instalação (a linha do `install.ps1` +
      os 3 cliques), atualização, "if it stops working" (o que dizer para o
      Vinicius: a versão e o código do toast), crédito ao autor original +
      GPL-3 (manter `LICENSE`).
- [ ] `README.pt-BR.md`: o mesmo em português. Remover o `README.en.md` do
      upstream (o `README.md` em russo é substituído).

### Fase 3½ — Distribuição (agente, 40 min)

- [ ] **Contrato do zip:** `karaoke-mp3-downloader.zip` tem `manifest.json` na
      raiz (zipar o *conteúdo* de `extension/`, não a pasta). O `install.ps1`
      extrai direto em `extension/`.
- [ ] `.github/workflows/release.yml`, em push de tag `v*`: (1) falhar se o
      `version` do manifest ≠ tag sem `v`; (2) `node --test`; (3) zipar; (4)
      Release com `softprops/action-gh-release` (`permissions: contents: write`,
      `GITHUB_TOKEN` do Actions — o PAT não entra). Depende do Actions
      habilitado na Fase 1.
- [ ] `install.ps1` na raiz. Requisitos: PowerShell 5.1 de fábrica, **sem
      admin**, sem depender de ExecutionPolicy (roda por `irm <url> | iex`, em
      memória), **UTF-8 com BOM** (5.1 lê acentos errado sem BOM), idempotente
      (rodar de novo = atualizar), nunca apaga a pasta das músicas. Strings em
      inglês e pt-BR numa tabela; escolha por `(Get-UICulture).Name -like 'pt*'`.
  1. Pastas: `$env:LOCALAPPDATA\KaraokeMP3\{extension,tmp}`. Downloads real
     lido de `HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders`
     (`{374DE290-123F-4565-9164-39C4925E467B}`, funciona com OneDrive) →
     criar a pasta das músicas (nome localizado, §9).
  2. **Chrome aberto?** (`Get-Process chrome`): em atualização, pedir para
     fechar **antes** de trocar a pasta — com o Chrome aberto os arquivos da
     extensão ficam travados e o rename falha. Esperar o processo sumir.
  3. Baixar `releases/latest/download/karaoke-mp3-downloader.zip` (TLS 1.2),
     `Expand-Archive` em `tmp`, trocar a pasta `extension` de uma vez (rename),
     gravar `version.txt`.
  4. Atalhos na área de trabalho (`WScript.Shell`), nomes localizados (§9):
     pasta das músicas → a pasta; "Update Karaoke MP3" / "Atualizar Baixador" →
     `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm <url> | iex"`.
  5. Primeira instalação: `Set-Clipboard` com o caminho da extensão, abrir
     `chrome://extensions` (`start chrome chrome://extensions`), mostrar na
     tela: *Modo do desenvolvedor → Carregar sem compactação → Ctrl+V → Enter*.
     **Único passo manual, uma vez só** — não há como automatizar sem a opção 3 do §6.
  6. Atualização: ao final, "Abrir o Chrome agora? [S/N]" (extensão sem
     compactação é relida do disco na abertura).
- [ ] Parâmetro `-Zip <caminho>` para testar o instalador com um zip local,
      antes de existir Release.

### Fase 4 — Testes automatizados (agente, ver §5)

- [ ] Cenário principal verde na extensão modificada, nos dois idiomas, com
      screenshot/vídeo em `test-results/`.
- [ ] Cenários seguintes do §5 (clique duplo, emoji, sem rede).
- [ ] `node --test` verde.
- [ ] Tag `v1.0.0` → Release publicada (conferir que o workflow rodou) →
      testar o `install.ps1` num perfil limpo do Windows do Vinicius.

### Fase 5 — Laptop do pai (Vinicius, 10 min)

- [x] Windows 11 + Google Chrome + uBlock Origin Lite instalado (2026-09-25).
- [ ] uBO Lite em modo **"Completo"** no youtube.com: com o YouTube aberto,
      clicar no ícone do uBO Lite → mover o controle para "Completo" → aceitar
      a permissão de ler/alterar dados em youtube.com. Conferir tocando um
      vídeo que costuma ter anúncio.
- [ ] Conferir que o Chrome dele está em português (`chrome://settings/languages`);
      senão a extensão aparece em inglês.
- [ ] PowerShell como o usuário dele:
      `irm https://raw.githubusercontent.com/alex-vinny/karaoke-mp3-downloader/main/install.ps1 | iex`
- [ ] `chrome://extensions`: Modo do desenvolvedor → Carregar sem compactação →
      Ctrl+V → Enter. (Não há ícone na barra: a extensão não tem popup.)
- [ ] Baixar uma música com ele olhando; mostrar "Abrir pasta" e o atalho;
      ensinar o "Cancelar" do pop-up (§6), se ele ainda existir.
- [ ] Deixar a Assistência Rápida do Windows pronta para suporte remoto.
- [ ] Perguntar se ele quer também o vídeo com a letra (seria uma versão 2;
      não muda a 1.0).

## 5. Testes com Playwright

**Por quê:** o Vinicius está com o braço quebrado; o agente testa sozinho e
guarda evidência (screenshot/vídeo) que ele mesmo consegue ler.

**Setup** (raiz do repo, só dev — `extension/` continua sem build):
`package.json` com devDependencies `@playwright/test` e `music-metadata`
(valida o MP3), `npx playwright install chromium`, `playwright.config.mjs`,
`tests/karaoke-mp3.spec.mjs`, `tests/unit/*.test.mjs`; `npm test` roda
`node --test` e depois o Playwright.

**Como carregar a extensão** (doc oficial "Chrome extensions" do Playwright):

```js
const context = await chromium.launchPersistentContext('tests/.tmp/profile', {
  channel: 'chromium',          // Chromium do Playwright, não o Chrome oficial → --load-extension ainda funciona
  headless: false,              // primeiro headed; depois tentar o headless novo
  args: [
    `--disable-extensions-except=${ext}`,
    `--load-extension=${ext}`,
    '--disable-blink-features=AutomationControlled',
    '--lang=pt-BR',             // idioma da UI → escolhe o _locales; segundo projeto com en-US
  ],
});
```

O `userDataDir` é fixo e git-ignored: reaproveitar o perfil entre execuções
reduz o "Sign in to confirm you're not a bot" do YouTube. Se aparecer mesmo
assim, abrir o perfil uma vez à mão e tocar alguns vídeos.

Se o teste precisar de ad blocker: baixar `uBOLite_*.chromium.mv3.zip` das
releases de `uBlockOrigin/uBOL-home` para `tests/vendor/` (git-ignored) e passar
as duas pastas separadas por vírgula nos dois args.

**Cenário principal:**

1. Abrir `https://www.youtube.com/watch?v=jNQXAC9IVRw` ("Me at the zoo", 19 s,
   canal oficial do YouTube — curto, estável, sem anúncios). Fechar diálogo de
   consentimento se aparecer.
2. Esperar o botão `[data-testid="karaoke-mp3-download"]` com o texto do
   idioma do projeto de teste.
3. Clicar; esperar o toast de "pronto" (timeout 3 min).
4. Verificar o arquivo: está na pasta das músicas do idioma, nome sanitizado,
   MP3 válido com duração 19 s ± 2 s e tag `title` (`music-metadata`).
5. Screenshot + vídeo em `test-results/`.

**Ponto a validar no spike (Fase 0):** o download é disparado pela extensão,
não pela página, então o evento `download` do Playwright pode não pegá-lo.
- Técnica A: `context.newCDPSession(page)` → `Browser.setDownloadBehavior({ behavior: 'allow', downloadPath: 'tests/.tmp' })` — preserva nome e subpasta.
- Técnica B (fallback): consultar o service worker da extensão — `context.serviceWorkers()[0].evaluate(() => chrome.downloads.search({}))` — para obter caminho e estado.

**Cenários seguintes:** clique duplo (botão desabilitado); vídeo com título
cheio de emoji (sanitização); sem rede (mensagem de erro).

**Limites:** não roda em GitHub Actions (YouTube bloqueia IPs de datacenter — CI
só roda `node --test` e faz a Release). Não cobre o pop-up do modo
desenvolvedor: só existe no Chrome oficial, e "Carregar sem compactação" abre
um diálogo nativo do Windows.

## 6. Pop-up "Desativar extensões do modo de desenvolvedor"

**Pode estar obsoleto:** há relatos de que o Chrome atual não mostra mais esse
aviso. A Fase 0 (Chrome oficial do Vinicius) responde em 5 min; se não
aparecer, este § vira histórico.

Se ainda existir: aparece a cada abertura do navegador, para toda extensão sem
compactação. Não há flag, configuração ou linha de comando que o desligue
(`--load-extension` removido no Chrome 137; `ExtensionInstallForcelist` fora da
loja só vale em máquina gerenciada). Opções, por esforço:

1. **Padrão: aceitar e ensinar "Cancelar".** Só aparece ao abrir do zero. Se ele
   clicar em "Desativar", a extensão só é desligada (religa em `chrome://extensions`, remoto em 30 s).
2. **Testar (10 min, manual, no Chrome oficial do Vinicius):**
   `HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionInstallAllowlist\1 = <ID fixo>`.
   Há relatos de que silencia o aviso; sem confirmação oficial. Exige admin
   (HKLM) e o Chrome passa a mostrar "Gerenciado pela sua organização".
3. **Definitivo (~3 h):** Chrome Enterprise Core (grátis; exige domínio
   verificado numa conta Google Admin) + `.crx` assinado com a chave do vault +
   `update.xml` no GitHub Pages → instalação forçada, sem modo desenvolvedor,
   auto-atualiza, não dá para remover sem querer. Só se o pop-up incomodar de
   verdade após 1–2 semanas.

## 7. Riscos

- **Ad blocker é o elo frágil.** uBO Lite (MV3) é o que roda no Chrome atual; o
  YouTube muda a entrega de anúncios com frequência. Sintoma: captura aborta.
  Com o tratamento de `ad-showing` (Fase 2) o pai vê "apareceu anúncio" em vez
  de um erro genérico.
- **Mudanças do YouTube no player quebram o hook.** Remédio: `git fetch upstream`
  → merge → teste (§5) → nova tag → o pai clica em "Atualizar Baixador".
- **YouTube barra o Chromium automatizado** ("Sign in to confirm you're not a
  bot"). Mitigação no §5 (perfil reaproveitado, flag de automação escondida).
- **Idioma do Windows ≠ idioma do Chrome** → pasta das músicas com dois nomes
  (ver §2). Fase 5 confere o Chrome do pai em português.
- Fechar a aba no meio aborta.
- Chrome 137+: nenhum atalho de linha de comando; sempre "Carregar sem compactação".

## 8. Plano B

`yt-dlp.exe` + `ffmpeg.exe` portáteis + janelinha PowerShell/WinForms (também sem
instalar nada): colar link → MP3. Mais robusto e sem ad blocker; UX pior (copiar
a URL). Usar se a Fase 4 mostrar instabilidade.

## 9. Textos aprovados

- **About do repo (inglês):** "One button to download MP3 from YouTube. Made for my dad, an amateur karaoke singer."
- **README.md (topo, inglês):** "A fork of [Triangle-Downloader](https://github.com/HelpFreedom/Triangle-Downloader), simplified for my dad — an amateur karaoke singer who uses YouTube as his songbook. One button: **Download MP3**."
- **README.pt-BR.md (topo):** "Fork do [Triangle-Downloader](https://github.com/HelpFreedom/Triangle-Downloader), simplificado para o meu pai — cantor amador de karaokê que usa o YouTube como repertório. Um botão só: **Baixar MP3**."
- **Mensagens da extensão (`_locales`):**

| chave | en (padrão) | pt_BR |
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

- **Instalador e atalhos** (mesma regra en / pt-BR): pasta e atalho
  `songsFolder`; atalho de atualização "Update Karaoke MP3" / "Atualizar
  Baixador"; demais prompts escritos na Fase 3½ seguindo o tom da tabela.

## 10. Para quem retomar (humano ou agente)

- Ler este arquivo e `C:\sources\claude-tools\AGENTS.md` (uso do vault e do PAT).
  Sem `gh` instalado: API REST com `curl`, PAT injetado por `vault run`, nunca impresso.
- O modo automático do Claude Code bloqueia o vault: precisa de `vault unlock`
  (Vinicius, no terminal dele) e da regra em `.claude/settings.local.json`
  (git-ignored, só nesta máquina).
- Ordem: Fase 1 → 0 → 2 → 3 → 3½ → 4 → tag `v1.0.0` → 5.
- Escopo de escrita: só esta pasta. Não mexer no Chrome do Vinicius sem pedir.
- Marcar os checkboxes aqui conforme avança; este arquivo é a fonte de verdade do estado.
