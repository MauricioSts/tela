# MIMO desktop

Casca nativa (Electron) em volta do mesmo app web de sempre. A janela carrega
`https://tela.mauriciosts.com` — então **o deploy da interface continua sendo
salvar o `public/room.html`**, sem gerar versão nova do app.

O que só existe aqui:

- **Seletor de tela próprio** (`picker.html`). No navegador quem desenha essa
  janela é o Chrome; no Electron somos nós, o que dá controle sobre o que é
  capturado.
- **Áudio do PC junto da tela**, sem depender de o usuário marcar a caixinha
  certa na janela do navegador.
- *(fase 2, ainda não feito)* **áudio por processo**: incluir só o jogo ou
  excluir só o Discord, usando o process loopback do Windows
  (`ActivateAudioInterfaceAsync` + `AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS`,
  Windows 10 build 20348+). É a razão de o app existir.

## Rodar em desenvolvimento

```bash
npm install
npm start                  # aponta pro site de produção
npm run start:local        # aponta pro servidor local (:8080)
npm run smoke              # teste de fumaça com xvfb (Linux)
```

`MIMO_DEBUG=1` liga os logs do caminho de captura.

## Gerar o instalador

Não dá pra compilar Windows nesta VM Linux — quem compila é o GitHub Actions
(`.github/workflows/desktop.yml`, runner `windows-latest`):

```bash
# 1. subir o código
git push origin main

# 2. marcar a versão — a tag TEM que ser v<version> do package.json, porque é
#    essa que o electron-builder usa pra achar/criar o release
git tag v0.1.1 && git push origin v0.1.1
```

A Action compila e publica `MIMO-0.1.1-Setup.exe` em **Releases**. Sem tag, dá
pra rodar pelo botão *Run workflow* — aí o `.exe` fica só como artifact da
execução, sem virar release.

## Instalar

Baixar o `.exe` da página de Releases e abrir. Instala em `%LOCALAPPDATA%`, pro
usuário atual: **não pede senha de administrador**.

Como o instalador não é assinado, o Windows mostra *"O Windows protegeu o seu
PC"* na primeira vez → **Mais informações** → **Executar assim mesmo**. Assinar
tira esse aviso, mas exige certificado de code signing pago (com token físico ou
HSM na nuvem) — vale a pena só se o app for distribuído fora do grupo de amigos.
