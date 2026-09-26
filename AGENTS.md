# karaoke-mp3-downloader

One-button Chrome extension ("⬇ Download video" / "⬇ Baixar vídeo"; an MP3 until
v1.0.0) for the YouTube player, forked from Triangle-Downloader, built for an
amateur karaoke singer whose laptop has no developer tools. Saves the video as a
720p MP4 (H.264 + AAC, stream copy) so the lyrics stay on screen. English by default; pt-BR is picked automatically
via `_locales`. GitHub repo: `alex-vinny/karaoke-mp3-downloader` (this local
folder kept its old name, `baixar-mp3-karaoke`).

- **Plan, decisions and phase status:** `specs/PLAN.md` — read it before anything else.
- **Credentials (GitHub PAT):** vault, via `C:\sources\claude-tools\AGENTS.md`. Never print it.
- **Scope:** write only inside this folder. Tests run locally (Playwright); CI only publishes the Release.
