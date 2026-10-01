@echo off
REM Sets up the "Ask about your ads" chat to use your Claude account (no API key):
REM installs Claude Code if it's missing, then signs in with your Claude subscription.
REM The chat's "Sign in with Claude" button opens this too.
cd /d "%~dp0"
title Sign in to Claude for DealTrack

set "CLAUDE="
where claude >nul 2>nul && set "CLAUDE=claude"
if not defined CLAUDE if exist "%USERPROFILE%\.local\bin\claude.exe" set "CLAUDE=%USERPROFILE%\.local\bin\claude.exe"
if not defined CLAUDE if exist "%APPDATA%\npm\claude.cmd" set "CLAUDE=%APPDATA%\npm\claude.cmd"

if not defined CLAUDE (
  echo Installing Claude Code. This takes a minute or two...
  call npm install -g @anthropic-ai/claude-code
  if errorlevel 1 (
    echo.
    echo The install failed. Take a screenshot of this window and send it over.
    pause
    exit /b 1
  )
  if exist "%APPDATA%\npm\claude.cmd" (set "CLAUDE=%APPDATA%\npm\claude.cmd") else (set "CLAUDE=claude")
)

echo.
echo A browser window opens next. Sign in with your Claude account and click Authorize.
echo (If the browser doesn't open, copy the address shown below into your browser.)
echo.
REM The app's own API key must not be used here: sign in with the Claude account instead.
set "ANTHROPIC_API_KEY="
call "%CLAUDE%" auth login --claudeai
echo.
call "%CLAUDE%" auth status --text
echo.
echo Done. Go back to DealTrack and ask your question again. You can close this window.
pause
