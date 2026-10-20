#!/usr/bin/env bash
# Stand up flipscout-server on a fresh Ubuntu 22.04/24.04 box.
#
#   curl -fsSL https://raw.githubusercontent.com/JuanDiaz2025/MLS-Full-Access/claude/keen-meitner-t4gora/flipscout-server/deploy.sh | sudo bash
#
# or, having cloned the repo:  sudo bash flipscout-server/deploy.sh
#
# It asks for the REI login and the mailbox that receives REI's verification
# codes, writes them 0600 where only root can read them, and runs the service
# under its own unmoneyed user behind HTTPS.
#
# Nothing here is irreversible: `systemctl disable --now flipscout` and
# `rm -rf /opt/flipscout` undoes all of it.

set -euo pipefail

REPO="https://github.com/JuanDiaz2025/MLS-Full-Access.git"
BRANCH="claude/keen-meitner-t4gora"
DIR=/opt/flipscout
SVC_USER=flipscout

say() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31mx\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run this with sudo"

say "Installing Node 20, git and Chromium's libraries"
apt-get update -qq
apt-get install -y -qq curl git ca-certificates gnupg >/dev/null
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

say "Fetching the server"
id -u "$SVC_USER" >/dev/null 2>&1 || useradd --system --home "$DIR" --shell /usr/sbin/nologin "$SVC_USER"
if [ -d "$DIR/.git" ]; then git -C "$DIR" fetch --depth 1 origin "$BRANCH" && git -C "$DIR" reset --hard FETCH_HEAD
else rm -rf "$DIR"; git clone --depth 1 -b "$BRANCH" "$REPO" "$DIR"; fi
cd "$DIR/flipscout-server"
npm install --omit=dev --no-audit --no-fund
npm install playwright --no-audit --no-fund
npx playwright install --with-deps chromium

say "Credentials"
echo "These go to /opt/flipscout/flipscout-server/.env, readable only by root."
read -rp  "  REI BlackBook email    : " REI_USER
read -rsp "  REI BlackBook password : " REI_PASS; echo
echo "  The mailbox REI sends verification codes to. For Gmail use an App"
echo "  Password (https://myaccount.google.com/apppasswords), not your own."
read -rp  "  Mail IMAP host [imap.gmail.com] : " MAIL_HOST; MAIL_HOST=${MAIL_HOST:-imap.gmail.com}
read -rp  "  Mail user              : " MAIL_USER
read -rsp "  Mail app password      : " MAIL_PASS; echo

API_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

umask 077
cat > .env <<ENV
PORT=8080
API_TOKEN=$API_TOKEN
REI_BASE=https://my.reiblackbook.com
REI_USER=$REI_USER
REI_PASS=$REI_PASS
REI_PROFILE_ID=5289
REI_STATE_PATH=$DIR/flipscout-server/data/rei-session.json
MAIL_HOST=$MAIL_HOST
MAIL_PORT=993
MAIL_USER=$MAIL_USER
MAIL_PASS=$MAIL_PASS
QUEUE_PATH=$DIR/flipscout-server/data/queue.json
ENV
chmod 600 .env
mkdir -p data && chmod 700 data
chown -R "$SVC_USER:$SVC_USER" "$DIR"

say "Installing the service"
cat > /etc/systemd/system/flipscout.service <<UNIT
[Unit]
Description=Twin Network server — Lead Board pushes into REI BlackBook
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SVC_USER
WorkingDirectory=$DIR/flipscout-server
EnvironmentFile=$DIR/flipscout-server/.env
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5
# it holds live CRM credentials: give it as little of the machine as possible
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DIR/flipscout-server/data
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now flipscout

say "HTTPS"
echo "The token and your contacts both cross the wire, so this must not run on"
echo "plain http. Give it a domain pointed at this box and Caddy gets a"
echo "certificate automatically; leave it blank to skip (then put it behind a"
echo "tunnel or a VPN yourself — do not open port 8080 to the internet)."
read -rp "  Domain (e.g. flipscout.twinhomebuyer.com), or blank : " DOMAIN
if [ -n "$DOMAIN" ]; then
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https >/dev/null
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
  printf '%s {\n  reverse_proxy 127.0.0.1:8080\n}\n' "$DOMAIN" > /etc/caddy/Caddyfile
  systemctl restart caddy
  command -v ufw >/dev/null && { ufw allow 80/tcp >/dev/null 2>&1 || true; ufw allow 443/tcp >/dev/null 2>&1 || true; }
  BASE="https://$DOMAIN"
else
  BASE="http://127.0.0.1:8080"
fi

sleep 3
say "Done"
echo
echo "  Address    : $BASE"
echo "  API token  : $API_TOKEN"
echo
echo "  Health     : curl $BASE/health"
echo "  Status page: $BASE/  (send the token: Authorization: Bearer <token>)"
echo "  Logs       : journalctl -u flipscout -f"
echo
echo "  Give Claude the address and the token and it will point the Lead"
echo "  Board's Push to REI button at this server."
echo
systemctl --no-pager --lines=5 status flipscout || true
