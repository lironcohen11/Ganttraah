@echo off
rem Starts Ganttraah without Docker. Requires Node.js 20 or newer.
rem Settings are read from .env in this folder (see .env.example).
rem Output goes to logs\server.log (and to the window, when started by hand).
cd /d "%~dp0"
if not exist logs mkdir logs
node server\src\index.js >> logs\server.log 2>&1
