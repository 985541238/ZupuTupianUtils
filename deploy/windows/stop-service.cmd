@echo off
rem Stop ZupuWorkbench service and free its port.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0service-control.ps1" stop
pause
