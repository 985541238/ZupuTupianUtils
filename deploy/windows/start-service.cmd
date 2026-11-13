@echo off
rem Start ZupuWorkbench service and verify it is listening.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0service-control.ps1" start
pause
