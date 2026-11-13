@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "BrowserControl.exe" (
  start "" "%~dp0BrowserControl.exe"
  exit /b 0
)
where node >nul 2>nul
if errorlevel 1 (
  echo Please download the complete Windows portable ZIP, or install Node.js 22+.
  pause
  exit /b 1
)
if not exist "node_modules\@modelcontextprotocol\sdk\package.json" (
  call npm ci --no-audit --no-fund --cache .local\npm-cache
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
node scripts\cli.mjs setup %*
pause
