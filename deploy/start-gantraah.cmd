@echo off
rem Starts Ganttraah without Docker. Requires Node.js 20 or newer.
rem Settings are read from .env in this folder (see .env.example).
cd /d "%~dp0"
node server\src\index.js
