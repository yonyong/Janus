@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem ============================================================
rem  coding-agent-platform launcher
rem    manage.bat [dev | build | start | stop | restart [dev|build] | status | help]
rem ============================================================

rem Root = this bat's own folder (coding-agent-platform)
set "ROOT=%~dp0"
set "BACKEND_PORT=8000"
set "FRONTEND_PORT=5173"

rem --- privilege check: are we running elevated (High integrity)? ---
set "IS_ADMIN="
fltmc >nul 2>&1 && set "IS_ADMIN=1"

if "%~1"==""             goto :dev
if /i "%~1"=="start"     goto :dev
if /i "%~1"=="dev"       goto :dev
if /i "%~1"=="build"     goto :build
if /i "%~1"=="stop"      goto :stop
if /i "%~1"=="restart"   goto :restart
if /i "%~1"=="status"    goto :status
if /i "%~1"=="help"      goto :usage
if /i "%~1"=="-h"        goto :usage
if /i "%~1"=="--help"    goto :usage

echo [ERROR] unknown command: %~1
echo.
goto :usage


rem ============================================================
rem  usage
rem ============================================================
:usage
echo Usage: %~nx0 [dev ^| build ^| start ^| stop ^| restart [dev^|build] ^| status]
echo   dev     (default) - backend (8000) + frontend Vite dev (5173), hot reload
echo   build             - npm run build -^> web/dist, then backend (8000) serves it
echo   stop              - kill whatever listens on ports 8000 / 5173
echo   restart [dev^|build] - stop then start (default dev)
echo   status            - show what currently listens on ports 8000 / 5173
exit /b 1


rem ============================================================
rem  dev / start
rem ============================================================
:dev
echo ============================================================
echo  Starting coding-agent-platform  [DEV mode]
echo    backend  : http://localhost:%BACKEND_PORT%  (FastAPI)
echo    frontend : http://localhost:%FRONTEND_PORT%  (Vite dev, hot reload)
echo ============================================================
echo.

set "BUSY="
call :warnport %BACKEND_PORT%
call :warnport %FRONTEND_PORT%
if defined BUSY (
  echo.
  echo  [!] Ports are occupied. Run "%~nx0 stop" first, otherwise the new
  echo      instance cannot bind and will exit immediately.
  echo.
)

rem --- backend (FastAPI) ---
if exist "%ROOT%.venv\Scripts\activate.bat" (
  echo [backend] starting with .venv ...
  start "CAP-Backend" /D "%ROOT%" cmd /k "title CAP-Backend && call .venv\Scripts\activate.bat && python start.py"
) else (
  echo [backend] [WARN] .venv not found, falling back to system python.
  echo           First-time setup: python -m venv .venv ^&^& .venv\Scripts\activate ^&^& pip install -r requirements.txt
  start "CAP-Backend" /D "%ROOT%" cmd /k "title CAP-Backend && python start.py"
)

rem --- frontend (Vite dev server) ---
echo [frontend] starting Vite dev server ...
start "CAP-Frontend" /D "%ROOT%web" cmd /k "title CAP-Frontend && npm run dev"

echo.
echo  Launched in separate windows. Close those windows or run "%~nx0 stop" to stop.
echo  Press any key to close this launcher (services keep running) ...
pause >nul
exit /b 0


rem ============================================================
rem  build
rem ============================================================
:build
echo ============================================================
echo  Starting coding-agent-platform  [BUILD mode]
echo    backend  : http://localhost:%BACKEND_PORT%  (FastAPI, serves web/dist)
echo ============================================================
echo.

set "BUSY="
call :warnport %BACKEND_PORT%
if defined BUSY (
  echo  [!] Port %BACKEND_PORT% is occupied. Run "%~nx0 stop" first.
  echo.
)

rem --- build frontend (tsc + vite build -^> web/dist) ---
if not exist "%ROOT%web\package.json" (
  echo [ERROR] frontend source not found at %ROOT%web - cannot build.
  exit /b 1
)
echo [frontend] building (npm run build to web/dist) ...
pushd "%ROOT%web"
call npm run build
set "BUILD_ERR=%errorlevel%"
popd
if not "%BUILD_ERR%"=="0" (
  echo [ERROR] frontend build failed, exit code %BUILD_ERR%. Backend not started.
  exit /b 1
)

rem --- backend (FastAPI, serves the built web/dist) ---
echo [backend] starting with built frontend ...
if exist "%ROOT%.venv\Scripts\activate.bat" (
  start "CAP-Backend" /D "%ROOT%" cmd /k "title CAP-Backend && call .venv\Scripts\activate.bat && python start.py"
) else (
  start "CAP-Backend" /D "%ROOT%" cmd /k "title CAP-Backend && python start.py"
)

echo.
echo  Backend now serving the built frontend at http://localhost:%BACKEND_PORT%
echo  Press any key to close this launcher (service keeps running) ...
pause >nul
exit /b 0


rem ============================================================
rem  stop
rem   - kills by port (authoritative) and by console title (best effort)
rem   - never swallows taskkill errors
rem   - verifies the port is really released; retries once, then reports
rem   - if it still fails and we are NOT elevated, re-runs itself via UAC
rem ============================================================
:stop
if /i "%~2"=="elevated" echo (running elevated)
call :dostop
if "!STOP_OK!"=="1" (
  echo Done.
  if /i "%~2"=="elevated" (
    echo.
    echo Press any key to close ...
    pause >nul
  )
  exit /b 0
)

echo.
if defined IS_ADMIN (
  echo [ERROR] Port still occupied even with administrator rights.
  echo         See the diagnostics above.
) else (
  echo [!] Port still occupied. The owning process was most likely started
  echo     with administrator rights, so this script has no permission to
  echo     kill it. Requesting elevation now ^(accept the UAC prompt^) ...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList 'stop','elevated' -Verb RunAs"
)
exit /b 1


rem --- core of stop, no elevation logic here ---
:dostop
set "STOP_OK=1"
echo Stopping coding-agent-platform services (ports %BACKEND_PORT% and %FRONTEND_PORT%) ...
call :killtitle CAP-Backend
call :killtitle CAP-Frontend
call :killport %BACKEND_PORT%
call :killport %FRONTEND_PORT%
goto :eof


rem --- kill all processes listening on port %1, then verify it is free ---
:killport
set "P=%~1"
set "KP_SEEN="
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr /C:":%P% " ^| findstr /C:"LISTENING"') do (
  echo !KP_SEEN! | findstr /C:"[%%a]" >nul 2>&1 || (
    set "KP_SEEN=!KP_SEEN![%%a]"
    call :killpid %%a %P%
  )
)
set "KP_TRY=0"
:killport_retry
call :portfree %P%
if "!PORTFREE!"=="1" goto :eof
set /a KP_TRY+=1
if !KP_TRY! GEQ 4 (
  echo   [ERROR] port %P% could not be released.
  call :diagport %P%
  set "STOP_OK=0"
  goto :eof
)
ping -n 2 127.0.0.1 >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr /C:":%P% " ^| findstr /C:"LISTENING"') do call :killpid %%a %P%
goto :killport_retry


rem --- kill one pid; %1 = pid, %2 = port (for logging only) ---
:killpid
set "KPID=%~1"
set "KPORT=%~2"
echo %KPID%| findstr /R "^[0-9][0-9]*$" >nul 2>&1 || goto :eof
if "%KPID%"=="0" goto :eof
set "KIMG=?"
for /f "tokens=1 delims=," %%n in ('tasklist /FI "PID eq %KPID%" /NH /FO CSV 2^>nul') do set "KIMG=%%~n"
echo   port %KPORT%: killing PID %KPID% [%KIMG%]
taskkill /PID %KPID% /T /F
if not errorlevel 1 goto :eof
echo   [WARN] taskkill failed, exit=%errorlevel% - retrying with Stop-Process ...
powershell -NoProfile -Command "Stop-Process -Id %KPID% -Force -ErrorAction SilentlyContinue" >nul 2>&1
if errorlevel 1 (
  echo   [WARN] could not terminate PID %KPID% - access denied / not elevated.
) else (
  echo   [OK] PID %KPID% terminated via Stop-Process.
)
goto :eof


rem --- %1 = port ; sets PORTFREE=1 when nothing listens on it anymore ---
:portfree
set "PORTFREE=1"
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr /C:":%~1 " ^| findstr /C:"LISTENING"') do set "PORTFREE=0"
goto :eof


rem --- best effort: kill the cmd windows we spawned (their title is set by "title") ---
:killtitle
taskkill /FI "WINDOWTITLE eq %~1" /T /F >nul 2>&1
goto :eof


rem --- %1 = port ; warn (and set BUSY) when it is already in use ---
:warnport
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr /C:":%~1 " ^| findstr /C:"LISTENING"') do (
  set "BUSY=1"
  echo [WARN] port %~1 already in use - PID %%a, probably an instance that did not exit.
)
goto :eof


rem --- %1 = port ; print who still holds it ---
:diagport
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr /C:":%~1 " ^| findstr /C:"LISTENING"') do (
  echo     holder PID %%a:
  tasklist /FI "PID eq %%a" /NH 2>nul
)
echo     If that process runs elevated, right-click this script and pick
echo     "Run as administrator", or kill it manually:
echo         taskkill /PID ^<PID^> /T /F
goto :eof


rem ============================================================
rem  status
rem ============================================================
:status
echo ============================================================
echo  coding-agent-platform  status
echo ============================================================
call :statusport %BACKEND_PORT%  "backend  FastAPI"
call :statusport %FRONTEND_PORT% "frontend Vite"
echo.
if defined IS_ADMIN (echo  shell rights: Administrator) else (echo  shell rights: Standard user)
goto :eof


rem --- %1 = port, %2 = label ---
:statusport
set "SP=%~1"
set "SPLABEL=%~2"
set "SPFOUND="
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr /C:":%SP% " ^| findstr /C:"LISTENING"') do (
  set "SPFOUND=1"
  for /f "tokens=1 delims=," %%n in ('tasklist /FI "PID eq %%a" /NH /FO CSV 2^>nul') do echo   port %SP% [%SPLABEL%] : LISTENING  PID=%%a  %%~n
)
if not defined SPFOUND echo   port %SP% [%SPLABEL%] : free
goto :eof


rem ============================================================
rem  restart
rem ============================================================
:restart
set "RMODE=%~2"
if "%RMODE%"=="" set "RMODE=dev"
if /i "%RMODE%"=="restart" set "RMODE=dev"
call :dostop
if not "!STOP_OK!"=="1" (
  echo.
  echo [ERROR] ports not released - starting aborted. Fix the port conflict first.
  exit /b 1
)
ping -n 2 127.0.0.1 >nul 2>&1
if /i "%RMODE%"=="build" ( goto :build ) else ( goto :dev )
