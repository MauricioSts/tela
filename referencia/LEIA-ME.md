# MIMO — pacote de referência visual

Tudo que a IA precisa para reproduzir o design.

## O que tem aqui

| Arquivo | O que é |
|---|---|
| `PROMPT-PARA-IA.md` | **Comece por aqui.** Spec completa: o que já existe no app, correção do microfone, WebRTC/Opus, features a criar, tokens e critérios de aceite. |
| `MIMO-standalone.html` | Protótipo funcional offline. Abra no navegador e clique em tudo — é a fonte da verdade do design. |
| `00-logo-mimo.jpg` | Logo MIMO (monograma em lima sobre disco escuro, usada em círculo). |
| `01-login.png` | Login: logo + lista do que o app faz + e-mail/senha. |
| `02-cadastro.png` | Aba criar conta (e-mail, senha, nick). |
| `03-chat-geral.png` | Shell do app: rail de servidores, sidebar, `#chat-geral`. |
| `04-modal-criar-sala.png` | Modal de criar sala: nome, 6 formatos, limite, pública/privada. |
| `05-call.png` | Call: tiles hexagonais, anel de quem fala, barra de voz no rodapé. |
| `06-call-chat.png` | Call com o chat lateral aberto. |
| `07-chat-com-barra-de-voz.png` | Navegando no chat **com a call ativa** (barra persistente). |
| `08-amigos-online.png` | Amigos online + adicionar por nick#0000 + grupos. |
| `09-amigos-pedidos.png` | Pedidos recebidos (aceitar/recusar). |
| `10-modal-criar-grupo.png` | Modal de criar grupo selecionando amigos. |
| `11-modal-criar-servidor.png` | Modal de criar servidor (nome + cor do emblema). |
| `12-mobile-chat.png` | Mobile: rail horizontal + barra de voz empilhada. |
| `13-mobile-gaveta.png` | Mobile: sidebar como gaveta (☰). |
| `14-mobile-call.png` | Mobile: call. |

## Ordem de leitura sugerida

1. Abrir `MIMO-standalone.html` no navegador e navegar por todas as telas.
2. Ler `PROMPT-PARA-IA.md` inteiro.
3. Usar os PNGs como checagem visual durante a implementação.

## Lembrete de escopo

No app real de hoje **só a transmissão de tela funciona** (com volume e chat da call). Microfone, contas, servidores, chat fora da call, amizades e grupos precisam ser construídos. Preserve o pipeline de vídeo existente.
