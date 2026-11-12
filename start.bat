@echo off
rem ==========================================================================
rem  Ganttraah - start client + server together
rem
rem    start.bat        build the client and start the server (one window)
rem    start.bat dev    development mode: server auto-restart + client live
rem                     reload, each in its own window
rem
rem  Close the window (or press Ctrl+C) to stop.
rem ==========================================================================
setlocal
cd /d "%~dp0"
title Ganttraah

set "PORT=8080"
if exist .env for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do if /i "%%a"=="PORT" set "PORT=%%b"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install Node.js 20 or newer and try again.
  pause
  exit /b 1
)

if not exist "server\node_modules" (
  echo Installing server packages...
  call npm --prefix server install --no-audit --no-fund
  if errorlevel 1 goto :fail
)
if not exist "client\node_modules" (
  echo Installing client packages...
  call npm --prefix client install --no-audit --no-fund
  if errorlevel 1 goto :fail
)

if /i "%~1"=="dev" goto :dev

rem ---- already running? just open it
netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul
if not errorlevel 1 (
  echo Ganttraah is already running on port %PORT%.
  if not defined NO_BROWSER start "" "http://localhost:%PORT%"
  exit /b 0
)

echo Building the client...
call npm --prefix client run build
if errorlevel 1 goto :fail

echo.
echo Ganttraah: http://localhost:%PORT%
echo Close this window to stop the server.
echo.
if not defined NO_BROWSER start "" /min powershell -NoProfile -Command "Start-Sleep 4; Start-Process 'http://localhost:%PORT%'"
node server\src\index.js
goto :eof

:dev
echo Development mode:
echo   server  http://localhost:%PORT%  (restarts when server code changes)
echo   client  http://localhost:5173  (reloads when client code changes)
start "Ganttraah server" cmd /k "node --watch server\src\index.js"
start "Ganttraah client" cmd /k "npm --prefix client run dev"
if not defined NO_BROWSER start "" /min powershell -NoProfile -Command "Start-Sleep 5; Start-Process 'http://localhost:5173'"
goto :eof

:fail
echo.
echo Something failed - see the messages above.
pause
exit /b 1
