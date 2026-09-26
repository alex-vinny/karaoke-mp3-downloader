# Baixar MP3 (karaokê)

🇺🇸 [English](README.md)

Fork do [Triangle-Downloader](https://github.com/HelpFreedom/Triangle-Downloader), simplificado para o meu pai — cantor amador de karaokê que usa o YouTube como repertório. Um botão só: **Baixar MP3**.

![O botão Baixar MP3 no canto superior direito do player do YouTube](docs/pt-BR/button.png)

| Enquanto trabalha | Quando termina |
|---|---|
| ![Baixando… — Não feche esta aba](docs/pt-BR/downloading.png) | ![Pronto! Está em "Músicas para cantar" — Abrir pasta](docs/pt-BR/done.png) |

## O que faz

- Põe um botão **⬇ Baixar MP3** no player do YouTube, nas páginas `youtube.com/watch`.
- Um clique salva a música inteira em MP3 (192 kbps), com título e artista gravados no arquivo, na pasta `Downloads\Músicas para cantar`. No fim aparece o botão **Abrir pasta**, que mostra o arquivo.
- Tudo acontece dentro do navegador: o áudio que o player já está tocando é capturado e convertido com ffmpeg.wasm. Sem serviço externo, sem yt-dlp, sem instalar mais nada.
- A interface segue o idioma do Chrome: português do Brasil se o Chrome estiver em português; inglês nos demais casos.
- Uma vez por dia confere no GitHub se há versão nova e avisa.

## Requisitos

- Google Chrome (ou outro navegador Chromium que carregue extensão sem compactação). O instalador de uma linha é para Windows; em outros sistemas, descompacte a release e use "Carregar sem compactação".
- Um bloqueador de anúncios que segure os anúncios do YouTube: **uBlock Origin Lite no modo "Completo" em youtube.com**. O YouTube injeta o anúncio no mesmo fluxo da música, então um anúncio que começa durante o download cancela o download (a mensagem avisa).

## Instalar (Windows)

1. Abra o PowerShell e cole esta linha:

   ```powershell
   irm https://raw.githubusercontent.com/alex-vinny/karaoke-mp3-downloader/main/install.ps1 | iex
   ```

   Ela baixa a última versão para `%LOCALAPPDATA%\KaraokeMP3\extension`, cria a pasta das músicas e dois atalhos na área de trabalho (**Músicas para cantar** e **Atualizar Baixador**), copia o caminho da extensão para a área de transferência e abre `chrome://extensions`. Não precisa de administrador.

2. Em `chrome://extensions`: ligue o **Modo do desenvolvedor** (canto superior direito) → **Carregar sem compactação** → cole o caminho (Ctrl+V) → Enter.

3. Abra qualquer vídeo no YouTube. O botão fica nos controles do player, embaixo à direita.

Se o Chrome mostrar o aviso "Desativar extensões do modo de desenvolvedor" ao abrir, clique em **Cancelar**.

Instalação manual: baixe `karaoke-mp3-downloader.zip` da [última release](https://github.com/alex-vinny/karaoke-mp3-downloader/releases/latest), descompacte em qualquer pasta e use "Carregar sem compactação" como acima.

## Atualizar

Dê dois cliques em **Atualizar Baixador** na área de trabalho (roda a mesma linha do instalador) e abra o Chrome de novo. Quando existe versão nova, a extensão mostra "Tem atualização" no YouTube uma vez por dia.

## Se parar de funcionar

- O YouTube muda o player com frequência. Atualize primeiro.
- A mensagem na tela traz um código curto e a versão, por exemplo `Deu erro (E1, v1.0.0)`:
  - **E1** — a captura falhou (rede, ou o YouTube mudou algo).
  - **E2** — a conversão ou a gravação falhou.
  - **"Apareceu anúncio"** — o bloqueador deixou passar um anúncio. Ponha o uBlock Origin Lite em modo "Completo" no youtube.com.
- Recarregue a página (F5) e tente de novo. Deixe a aba aberta enquanto roda; fechar a aba cancela o download.
- Continua travado? Diga para quem instalou o código, a versão e o link do vídeo.

## Limites

- Só em páginas `youtube.com/watch` (não em Shorts).
- A conversão é um re-encode em uma thread: cerca de um minuto para uma música de 4 minutos, mais para mixes de uma hora.
- Sem ícone na barra: tudo acontece dentro do player.

## Para desenvolvedores

```sh
npm install
npx playwright install chromium
npm test                              # testes unitários (node --test) + ponta a ponta (Playwright, com janela)
KMD_LANG=en-US npx playwright test    # ponta a ponta em inglês (padrão: pt-BR)
```

O teste de ponta a ponta carrega `extension/` sem compactação no Chromium do Playwright, baixa um vídeo de 19 segundos e confere o MP3 e as tags. Só roda localmente — o YouTube bloqueia IPs de datacenter. As releases são publicadas pelo GitHub Actions quando uma tag `v*` é enviada. Decisões e estado: [`specs/PLAN.md`](specs/PLAN.md) (em inglês).

## Créditos e licença

Baseado no [Triangle-Downloader](https://github.com/HelpFreedom/Triangle-Downloader), de HelpFreedom: o hook de captura e o pipeline com ffmpeg.wasm são deles; este fork tira o menu e acrescenta a pasta, as tags, os idiomas e o instalador. Licença GPL-3.0, ver [`LICENSE`](LICENSE). Usa [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm).
