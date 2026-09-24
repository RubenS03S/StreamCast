@echo off
title StreamCast (local)
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js est requis : https://nodejs.org & pause & exit /b 1)
start "" http://localhost:8888
node server\dev.mjs
pause
