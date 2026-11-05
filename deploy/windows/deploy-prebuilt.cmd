@echo off
rem One-click DEPLOY of a prebuilt package: unzip over the project root, then double-click this file.
rem No npm install / no compile needed (dist is already built). Elevates automatically.
setlocal
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-prebuilt.ps1"
echo.
pause
