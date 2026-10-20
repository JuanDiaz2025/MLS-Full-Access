# Browsing the MLSListings Pro Dashboard from Claude Code on the web

Target: <https://prodashboard.mlslistings.com/>

It redirects to the MLSListings Pro **Sign In** page hosted on Azure AD B2C
(`mlslpro.b2clogin.com`). Reaching the dashboard behind the login requires
credentials (username/password, or "Sign in with Google/Facebook").

## Quick start

```bash
npm install                     # or: bash scripts/setup-browser.sh
bash scripts/setup-browser.sh   # trust CA + install Chromium TLS policy
node scripts/open-dashboard.js  # loads the URL, saves prodashboard.png
```

`open-dashboard.js` accepts optional args: `node scripts/open-dashboard.js <url> <outfile>`.

## Why a plain headless browser fails here (and how it's fixed)

All outbound HTTPS in the web environment is forced through a local egress
proxy (`$HTTPS_PROXY`, e.g. `http://127.0.0.1:40687`) that re-terminates TLS.
Getting Chromium to work through it took three fixes:

1. **Use the pre-installed browser.** Chromium binaries live at
   `/opt/pw-browsers`; only the `playwright` npm package needs installing
   (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`). The installed package version may not
   match the binary, so we launch with an explicit
   `executablePath` (`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`).

2. **Route the browser through the proxy** with `--proxy-server=$HTTPS_PROXY`
   (minus the scheme) and **trust the proxy CA**
   (`/root/.ccr/agent-proxy-ca.crt`) in the NSS store Chromium reads
   (`~/.pki/nssdb`, via `certutil`). This Chromium build uses the built-in cert
   verifier, so `--ignore-certificate-errors` does **not** work — the CA must be
   trusted in NSS.

3. **Shrink the TLS ClientHello.** This was the real blocker. Symptom:
   `net::ERR_CONNECTION_RESET` on every HTTPS site (even example.com), while
   `curl` through the same proxy returned 200. A Chromium netlog showed the
   reset happening mid-handshake right after the ClientHello, which was ~1811
   bytes because Chromium sends a **post-quantum key share** (X25519+MLKEM/Kyber)
   and a GREASE **Encrypted Client Hello (ECH)** extension. The egress proxy
   resets that oversized/ECH ClientHello. `curl`/`openssl` send a small classic
   ClientHello, so they were unaffected.

   `--disable-features=PostQuantumKyber,EncryptedClientHello` did **not** take
   effect in this build. What worked was a Chromium **enterprise policy**:

   ```json
   {
     "PostQuantumKeyAgreementEnabled": false,
     "EncryptedClientHelloEnabled": false
   }
   ```

   dropped in `/etc/chromium/policies/managed/`,
   `/etc/opt/chrome/policies/managed/`, and
   `/etc/chromium-browser/policies/managed/`. That shrank the ClientHello to
   ~508 bytes and the handshake succeeded (200 OK).

## Notes

- The environment is ephemeral. `scripts/setup-browser.sh` re-applies the CA
  trust and policy; re-run it in a fresh session before browsing.
- `node_modules/` is gitignored; run `npm install` after cloning.
