@echo off
setlocal EnableExtensions
rem Root = this bat's own folder (coding-agent-platform)
set "ROOT=%~dp0"
set "BACKEND_PORT=8000"
set "FRONTEND_PORT=5173"

if "%~1"==""      goto :dev
if /i "%~1"=="start"   goto :dev
if /i "%~1"=="dev"     goto :dev
if /i "%~1"=="build"   goto :build
if /i "%~1"=="stop"    goto :stop
if /i "%~1"=="restart" goto :restart
echo Usage: %~nx0 [dev ^| build ^| start ^| stop ^| restart [dev^|build]]
echo   dev     (default) - backend (8000) + frontend Vite dev (5173), hot reload
echo   build             - npm run build -> web/dist, then backend (8000) serves it
echo   stop              - kill services on ports 8000 and 5173
echo   restart [dev^|build] - stop then start (default dev)
exit /b 1


:dev
echo ============================================================
echo  Starting coding-agent-platform  [DEV mode]
echo    backend  : http://localhost:%BACKEND_PORT%  (FastAPI)
echo    frontend : http://localhost:%FRONTEND_PORT%  (Vite dev, hot reload)
echo ============================================================
echo.

rem --- pre-check: warn if ports already occupied ---
netstat -ano 2>nul | findstr /R ":%BACKEND_PORT% " | findstr "LISTENING" >nul && echo [WARN] port %BACKEND_PORT% already in use - backend may already be running.
netstat -ano 2>nul | findstr /R ":%FRONTEND_PORT% " | findstr "LISTENING" >nul && echo [WARN] port %FRONTEND_PORT% already in use - frontend may already be running.

rem --- backend (FastAPI) ---
if exist "%ROOT%.venv\Scripts\activate.bat" (
  echo [backend] starting with .venv ...
  start "CAP-Backend" /D "%ROOT%" cmd /k "call .venv\Scripts\activate.bat && python start.py"
) else (
  echo [backend] [WARN] .venv not found, falling back to system python.
  echo           First-time setup: python -m venv .venv ^&^& .venv\Scripts\activate ^&^& pip install -r requirements.txt
  start "CAP-Backend" /D "%ROOT%" cmd /k "python start.py"
)

rem --- frontend (Vite dev server) ---
echo [frontend] starting Vite dev server ...
start "CAP-Frontend" /D "%ROOT%web" cmd /k "npm run dev"

echo.
echo  Launched in separate windows. Close those windows or run "%~nx0 stop" to stop.
echo  Press any key to close this launcher (services keep running) ...
pause >nul
exit /b 0


:build
echo ============================================================
echo  Starting coding-agent-platform  [BUILD mode]
echo    backend  : http://localhost:%BACKEND_PORT%  (FastAPI, serves web/dist)
echo ============================================================
echo.
netstat -ano 2>nul | findstr /R ":%BACKEND_PORT% " | findstr "LISTENING" >nul && echo [WARN] port %BACKEND_PORT% already in use - backend may already be running.

rem --- build frontend (tsc + vite build -> web/dist) ---
echo [frontend] building (npm run build -> web/dist) ...
pushd "%ROOT%web"
call npm run build
set "BUILD_ERR=%errorlevel%"
popd
if not "%BUILD_ERR%"=="0" (
  echo [ERROR] frontend build failed (exit %BUILD_ERR%). Aborting - backend not started.
  exit /b 1
)

rem --- backend (FastAPI, serves the built web/dist) ---
echo [backend] starting with built frontend ...
if exist "%ROOT%.venv\Scripts\activate.bat" (
  start "CAP-Backend" /D "%ROOT%" cmd /k "call .venv\Scripts\activate.bat && python start.py"
) else (
  start "CAP-Backend" /D "%ROOT%" cmd /k "python start.py"
)

echo.
echo  Backend now serving the built frontend at http://localhost:%BACKEND_PORT%
echo  Press any key to close this launcher (service keeps running) ...
pause >nul
exit /b 0


:stop
echo Stopping coding-agent-platform services (ports %BACKEND_PORT% and %FRONTEND_PORT%) ...
call :killport %BACKEND_PORT%
call :killport %FRONTEND_PORT%
taskkill /FI "WINDOWTITLE eq CAP-Backend"  /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq CAP-Frontend" /F >nul 2>&1
echo Done.
exit /b 0


:killport
set "P=%~1"
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr /R ":%P% " ^| findstr "LISTENING"') do (
  echo   port %P%: killing PID %%a
  taskkill /PID %%a /F >nul 2>&1
)
goto :eof


:restart
set "RMODE=%~2"
if "%RMODE%"=="" set "RMODE=dev"
call :stop
timeout /t 2 >nul
if /i "%RMODE%"=="build" ( goto :build ) else ( goto :dev )
