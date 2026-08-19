# Setup — tela.mauriciosts.com

Compartilhamento de tela P2P (WebRTC), 1 transmissor + 1 espectadora, sem áudio.

Antes de tudo, troque **em todos os arquivos** o token e a senha do TURN:

- `server.js`, `public/host.html`, `public/view.html` → `TOKEN`
- `public/host.html`, `public/view.html`, `turnserver.conf` → senha `troque-esta-senha-turn`
- `turnserver.conf` → `external-ip=SEU_IP_PUBLICO`

Suponha o projeto em `/home/ubuntu/tela` e o domínio já apontando pra VM.

---

## 1. Node / server de sinalização

```bash
cd /home/ubuntu/tela
npm install          # instala ws
node server.js       # teste rápido; Ctrl+C depois
```

## 2. coturn (TURN)

```bash
sudo apt-get update
sudo apt-get install -y coturn

# habilita o daemon
echo 'TURNSERVER_ENABLED=1' | sudo tee /etc/default/coturn

# usa a nossa config
sudo cp /home/ubuntu/tela/turnserver.conf /etc/turnserver.conf
sudo systemctl enable --now coturn
sudo systemctl restart coturn
sudo systemctl status coturn --no-pager
```

## 3. Caddy (TLS + estático + proxy do WebSocket)

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update
sudo apt-get install -y caddy

sudo cp /home/ubuntu/tela/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo systemctl status caddy --no-pager
```

O Caddy emite o certificado sozinho no primeiro acesso HTTPS (precisa da 80/443 abertas — ver passo 5).

## 4. systemd pro server.js

```bash
sudo tee /etc/systemd/system/tela.service >/dev/null <<'EOF'
[Unit]
Description=tela-share signaling
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/tela
ExecStart=/usr/bin/node /home/ubuntu/tela/server.js
Environment=PORT=8080
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now tela.service
sudo systemctl status tela.service --no-pager
```

## 5. Portas — OCI Security List + iptables local

São **dois** firewalls. Precisa abrir nos dois.

### 5a. OCI Security List (Console web)

Networking → VCN → Subnet → Security List → **Add Ingress Rules**, source `0.0.0.0/0`:

| Protocolo | Porta          | Pra quê          |
|-----------|----------------|------------------|
| TCP       | 80             | Caddy / ACME     |
| TCP       | 443            | HTTPS            |
| UDP       | 3478           | TURN             |
| TCP       | 3478           | TURN (opcional)  |
| UDP       | 49160-49200    | Relay do TURN    |

### 5b. iptables local (obrigatório!)

As imagens Ubuntu da OCI já vêm com iptables bloqueando **tudo** exceto a 22
(há uma regra `REJECT` no fim da chain INPUT). `-I` insere as regras **antes**
dessa regra de bloqueio:

```bash
sudo iptables -I INPUT -p tcp --dport 80    -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 443   -j ACCEPT
sudo iptables -I INPUT -p udp --dport 3478  -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 3478  -j ACCEPT
sudo iptables -I INPUT -p udp --dport 49160:49200 -j ACCEPT

# Persistir entre reboots:
sudo apt-get install -y iptables-persistent
sudo netfilter-persistent save
```

Confira: `sudo iptables -L INPUT -n --line-numbers` — as regras ACCEPT precisam
aparecer **acima** da linha `REJECT ... icmp-host-prohibited`.

---

## 6. Uso

1. No PC (Chrome/Windows): abra `https://tela.mauriciosts.com/host.html`, clique **Iniciar**, escolha a tela/janela do jogo.
2. No iPhone (Safari): abra `https://tela.mauriciosts.com/view.html`, clique **Conectar**.
3. Na host.html, o indicador mostra o estado e o caminho:
   - **host** = LAN direta · **srflx** = P2P via STUN (o normal, mesma cidade) · **relay (TURN!)** = caiu no TURN (mais latência; investigar firewall/NAT).

## 7. Diagnóstico rápido

```bash
sudo systemctl status tela caddy coturn --no-pager
sudo journalctl -u coturn -f          # ver alocações de relay
sudo ss -lunp | grep 3478             # TURN escutando em UDP?
```

- Vídeo não aparece e cai sempre em **relay**: a faixa UDP 49160-49200 ou a 3478 não estão abertas nos dois firewalls.
- Nunca conecta: confira se `TOKEN` é idêntico nos 3 arquivos e a senha do TURN idêntica nos 3 lugares.
- Certificado não emite: 80/443 fechadas, ou o DNS de `tela.mauriciosts.com` ainda não propagou.
