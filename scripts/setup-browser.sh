#!/usr/bin/env bash
# Prepare headless Chromium to browse through the Claude Code on the web egress
# proxy. Idempotent — safe to run more than once.
#
# What it does, and why (see docs/browser-access.md for the full write-up):
#   1. Installs the `playwright` npm package (browser binaries are already at
#      /opt/pw-browsers, so browser download is skipped).
#   2. Trusts the proxy CA in the NSS store Chromium reads.
#   3. Installs a Chromium enterprise policy that disables the post-quantum key
#      share and Encrypted Client Hello. Without this, Chromium sends an
#      oversized ClientHello that the egress proxy resets (ERR_CONNECTION_RESET),
#      even though curl works fine.
set -euo pipefail

CA="${CCR_CA:-/root/.ccr/agent-proxy-ca.crt}"

echo "==> installing playwright npm package (skipping browser download)"
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install >/dev/null 2>&1
echo "    ok"

echo "==> trusting proxy CA in NSS store"
if ! command -v certutil >/dev/null 2>&1; then
  echo "    installing libnss3-tools for certutil"
  (apt-get update >/dev/null 2>&1 && apt-get install -y libnss3-tools >/dev/null 2>&1) \
    || sudo apt-get install -y libnss3-tools >/dev/null 2>&1
fi
mkdir -p "$HOME/.pki/nssdb"
if [ ! -f "$HOME/.pki/nssdb/cert9.db" ]; then
  certutil -N --empty-password -d "sql:$HOME/.pki/nssdb" >/dev/null 2>&1 || true
fi
certutil -d "sql:$HOME/.pki/nssdb" -D -n ccr-agent-proxy >/dev/null 2>&1 || true
certutil -d "sql:$HOME/.pki/nssdb" -A -n ccr-agent-proxy -t "C,," -i "$CA"
echo "    ok"

echo "==> installing Chromium TLS policy (disable PQ key share + ECH)"
for d in /etc/chromium/policies/managed /etc/opt/chrome/policies/managed /etc/chromium-browser/policies/managed; do
  mkdir -p "$d"
  cat > "$d/proxy_tls.json" <<'JSON'
{
  "PostQuantumKeyAgreementEnabled": false,
  "EncryptedClientHelloEnabled": false
}
JSON
done
echo "    ok"

echo "==> done. Try: node scripts/open-dashboard.js"
