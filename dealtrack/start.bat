@echo off
REM Double-click to install and start DealTrack on Windows.
cd /d "%~dp0"
title DealTrack

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS version from https://nodejs.org, then run this file again.
  start "" https://nodejs.org
  pause
  exit /b 1
)

if not exist .env.local (
  copy .env.example .env.local >nul
  echo Created .env.local. Fill in your Google Ads keys in that file, save it, then run this file again.
  notepad .env.local
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing DealTrack. This takes a minute or two the first time...
  call npm install
  if errorlevel 1 (
    echo Install failed. Take a screenshot of this window and send it over.
    pause
    exit /b 1
  )
)

echo Starting DealTrack. Your browser will open at http://localhost:3000
echo Keep this window open while you use it. Close it to stop.
start "" cmd /c "timeout /t 8 >nul & start http://localhost:3000/overview"
call npm run dev
pause
