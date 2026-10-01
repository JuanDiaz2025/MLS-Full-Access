@echo off
REM Double-click this (while the app is running) so WordPress can send website leads to the app.
REM It opens a free Cloudflare tunnel: a public https:// address that forwards to this computer.
cd /d "%~dp0"
title DealTrack - online for WordPress

where curl >nul 2>nul
if errorlevel 1 (
  echo This needs curl, which comes with Windows 10 and 11. Update Windows and try again.
  pause
  exit /b 1
)

curl -s -o nul http://localhost:3000
if errorlevel 1 (
  echo The app isn't running yet. Double-click start.bat first, wait for the browser to open,
  echo then double-click this file again.
  pause
  exit /b 1
)

if not exist .tools mkdir .tools
if not exist .tools\cloudflared.exe (
  echo Downloading Cloudflare's tunnel tool, one time only...
  curl -L -s -o .tools\cloudflared.exe https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
  if errorlevel 1 (
    echo The download failed. Check the internet connection and try again.
    pause
    exit /b 1
  )
)

if exist .tools\tunnel.log del .tools\tunnel.log
echo Opening the public address. This takes a few seconds...
start "" /b .tools\cloudflared.exe tunnel --no-autoupdate --url http://localhost:3000 --logfile .tools\tunnel.log

REM Wait for the tunnel's address, then save it so the Leads page shows the right webhook address.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$url = $null; for ($i = 0; $i -lt 60 -and -not $url; $i++) { Start-Sleep -Seconds 1; if (Test-Path '.tools\tunnel.log') { $m = Select-String -Path '.tools\tunnel.log' -Pattern 'https://[a-z0-9]+(-[a-z0-9]+)+\.trycloudflare\.com' | Select-Object -First 1; if ($m) { $url = $m.Matches[0].Value } } };" ^
  "if (-not $url) { Write-Host 'Could not open the public address. Close this window and try again.'; exit 1 };" ^
  "New-Item -ItemType Directory -Force -Path '.data' | Out-Null; Set-Content -Path '.data\public-url' -Value $url -NoNewline;" ^
  "$key = $env:LEADS_WEBHOOK_SECRET; if (-not $key -and (Test-Path '.env.local')) { $l = Select-String -Path '.env.local' -Pattern '^LEADS_WEBHOOK_SECRET=(.+)$' | Select-Object -First 1; if ($l) { $key = $l.Matches[0].Groups[1].Value.Trim() } };" ^
  "if (-not $key -and (Test-Path '.data\webhook-secret')) { $key = (Get-Content '.data\webhook-secret' -Raw).Trim() };" ^
  "$hook = $null; if ($key) { $hook = $url + '/api/leads/webhook?key=' + [uri]::EscapeDataString($key) };" ^
  "Write-Host ''; Write-Host 'The app is online for WordPress.' -ForegroundColor Green;" ^
  "if ($hook) { Set-Clipboard -Value $hook; Write-Host ''; Write-Host 'Your webhook address (already copied, paste it into WordPress):'; Write-Host ''; Write-Host $hook -ForegroundColor Yellow } else { Write-Host 'Open the Leads page in the app once, then run this file again to get the webhook address.' };" ^
  "Write-Host ''; Write-Host 'Keep this window open: leads only arrive while it and the app are running.'; Write-Host 'The address changes each time you run this, so paste the new one into WordPress each time.'"
if errorlevel 1 (
  pause
  exit /b 1
)
echo.
echo Close this window to go offline.
:wait
timeout /t 3600 /nobreak >nul
goto wait
