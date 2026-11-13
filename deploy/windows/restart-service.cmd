@echo off
rem Restart ZupuWorkbench service (stop + start + verify).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0service-control.ps1" restart
pause
