@echo off
REM ============================================================
REM  CodeBuddy Credit Widget - Launcher (Windows)
REM ============================================================
setlocal

REM ---- 1. Locate script directory ----
set "APP_DIR=%~dp0"
cd /d "%APP_DIR%"

REM ---- 2. Configure Node 18 (local nvm install path) ----
set "NVM_NODE18=D:\Tools\nvm\v18.20.4"
if exist "%NVM_NODE18%\node.exe" (
    set "PATH=%NVM_NODE18%;%PATH%"
    echo [OK] Using Node 18: %NVM_NODE18%
) else (
    echo [WARN] Node 18 not found, using system default
)

REM ---- 3. Check node ----
node -v >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not detected. Please install Node 18.
    pause
    exit /b 1
)

REM ---- 4. Install deps if missing ----
if not exist "node_modules\electron\dist\electron.exe" (
    echo [INFO] Installing dependencies...
    set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
    call npm install
    if errorlevel 1 (
        echo [ERROR] Dependency install failed.
        pause
        exit /b 1
    )
    echo [OK] Dependencies installed
)

REM ---- 5. Launch ----
echo [START] CodeBuddy Credit Widget...
echo First use: click "WeChat QR Login" on the widget.
echo Closing the widget hides it to the tray. Right-click tray to exit.
echo.
call npm start
if errorlevel 1 (
    echo [ERROR] App failed to start.
    pause
)

endlocal
