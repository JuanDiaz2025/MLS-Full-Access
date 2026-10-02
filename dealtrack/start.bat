@echo off
REM Double-click to install and start DealTrack on Windows.
cd /d "%~dp0"
title DealTrack

REM An older copy still running would keep port 3000, and the browser would show the old version:
REM close it first (its files are in use while it runs).
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":3000 .*LISTENING"') do (
  echo Closing the copy of DealTrack that is already running...
  taskkill /pid %%p /t /f >nul 2>nul
)

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

REM Install the first time, and again whenever a pull changed the packages (package-lock.json
REM differs from the copy saved after the last install).
set "NEED_INSTALL="
if not exist node_modules set "NEED_INSTALL=1"
if not exist node_modules\.dealtrack-installed-lock.json set "NEED_INSTALL=1"
if not defined NEED_INSTALL (
  fc /b package-lock.json node_modules\.dealtrack-installed-lock.json >nul 2>nul
  if errorlevel 1 set "NEED_INSTALL=1"
)
if defined NEED_INSTALL (
  echo Installing DealTrack. This takes a minute or two...
  call npm install
  if errorlevel 1 (
    echo Install failed. Take a screenshot of this window and send it over.
    pause
    exit /b 1
  )
  copy /y package-lock.json node_modules\.dealtrack-installed-lock.json >nul
)

REM Build the fast version only when the code changed since the last build (after a git pull),
REM instead of every start. If building fails, DealTrack still starts in the slower mode.
set "VERSION="
for /f %%v in ('git rev-parse HEAD 2^>nul') do set "VERSION=%%v"
if not defined VERSION set "VERSION=unknown"
set "NEED_BUILD="
if not exist .next\BUILD_ID set "NEED_BUILD=1"
if "%VERSION%"=="unknown" set "NEED_BUILD=1"
if not defined NEED_BUILD (
  set /p BUILT=<.next\dealtrack-built-version 2>nul
)
if not defined NEED_BUILD if not "%BUILT%"=="%VERSION%" set "NEED_BUILD=1"
set "MODE=start"
if defined NEED_BUILD (
  echo Preparing DealTrack. This takes about a minute after an update...
  call npm run build
  if errorlevel 1 (
    echo The fast version couldn't be built, so DealTrack starts in the slower mode.
    set "MODE=dev"
  ) else (
    echo %VERSION%> .next\dealtrack-built-version
  )
)

echo Starting DealTrack. Your browser will open at http://localhost:3000
echo Keep this window open while you use it. Close it to stop.
start "" cmd /c "timeout /t 5 >nul & start http://localhost:3000/overview"
if "%MODE%"=="dev" (call npm run dev) else (call npm start)
pause
