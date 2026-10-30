@echo off
rem 启动服务端（同端口提供管理端页面）。日志写到 logs\server.log
cd /d "%~dp0..\..\server"
if not exist "..\logs" mkdir "..\logs"
node dist\main.js >> "..\logs\server.log" 2>&1
