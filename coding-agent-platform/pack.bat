@echo off
chcp 65001 >nul
setlocal
cd /d %~dp0

rem ============================================================
rem  Janus 桌面应用打包脚本（onedir + pywebview 原生窗口）
rem  产物：dist\Janus\ ，整个文件夹拷到任意 Windows 机器双击 Janus.exe 即可
rem ============================================================

rem 若默认 pip 镜像不可用，放开下面一行改走官方源
rem set PIP_ARGS=--index-url https://pypi.org/simple

echo [1/5] 生成图标资源 ...
if not exist "assets\janus.ico" (
  where node >nul 2>nul && (
    node tools\make_icon.mjs
  ) || (
    echo    [警告] 未找到 node，且 assets\janus.ico 不存在，将使用 PyInstaller 默认图标
  )
) else (
  echo    已存在 assets\janus.ico，跳过。需要重绘请先删除该文件
)

echo.
echo [2/5] 安装打包依赖 ...
.venv\Scripts\python.exe -m pip install -U pyinstaller pywebview %PIP_ARGS%

echo.
echo [3/5] 构建前端产物 ...
if not exist "web\dist\index.html" (
  pushd web
  call npm run build
  popd
) else (
  echo    已存在 web\dist\index.html，跳过。前端有改动请先手动执行 build
)

echo.
echo [4/5] 打包为 dist\Janus\ ...
.venv\Scripts\pyinstaller --noconfirm --clean --onedir --name Janus --noconsole ^
  --icon assets\janus.ico ^
  --add-data "web/dist;web/dist" ^
  --add-data "assets\janus.ico;assets" ^
  --hidden-import multipart ^
  --hidden-import clr ^
  --collect-all webview ^
  --collect-all pythonnet ^
  --hidden-import uvicorn.logging ^
  --hidden-import uvicorn.loops.auto ^
  --hidden-import uvicorn.protocols.http.auto ^
  --hidden-import uvicorn.protocols.websockets.auto ^
  --hidden-import uvicorn.protocols.ws.auto ^
  --collect-submodules uvicorn ^
  --collect-submodules starlette ^
  --collect-submodules fastapi ^
  pack_launch.py

if errorlevel 1 (
  echo.
  echo [失败] 打包出错，请检查上方输出。
  pause
  exit /b 1
)

echo.
echo [5/5] 生成 exe 同级配置模板 ...
.venv\Scripts\python.exe tools\make_config_ini.py dist\Janus

echo.
echo 完成。产物在 dist\Janus\ ，把整个文件夹拷到任意 Windows 机器双击 Janus.exe 即可。
echo 运行日志：dist\Janus\logs\janus.log
echo.
echo 提示：
echo   1. 端口、管理员口令等配置都在 dist\Janus\config.ini，直接编辑后重启程序即可生效；
echo      配置不内置进 exe，改配置不需要重新打包。
echo   2. 目标机器需有 WebView2 运行时（Win10 1803+ 及 Win11 通常自带）。
pause
