@echo off
REM ============================================================
REM  CodeBuddy Credit Widget - Portable Builder (Windows)
REM  Build the portable single-file exe for sharing.
REM  Usage: double-click this file, or run: build-portable.bat
REM ============================================================
setlocal

set "APP_DIR=%~dp0"
cd /d "%APP_DIR%"

REM ---- Node 18 path ----
set "NVM_NODE18=D:\Tools\nvm\v18.20.4"
set "NODE_BIN="
if exist "%NVM_NODE18%\node.exe" set "NODE_BIN=%NVM_NODE18%"

REM ---- Check node ----
if defined NODE_BIN goto :have_bin
"%NODE_BIN%\node.exe" -v >nul 2>&1
node -v >nul 2>&1
if errorlevel 1 goto :no_node
echo [OK] Using system Node
goto :deps_ok

:have_bin
"%NODE_BIN%\node.exe" -v >nul 2>&1
if errorlevel 1 goto :no_node
echo [OK] Using Node 18: %NODE_BIN%

:deps_ok
REM ---- Install build deps if missing ----
if exist "node_modules\electron-builder\cli.js" goto :deps_done
echo [INFO] Installing build dependencies, may take a few minutes...
if not defined NODE_BIN goto :npm_system
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
call "%NODE_BIN%\npm.cmd" install
goto :npm_done

:npm_system
call npm install

:npm_done
if errorlevel 1 goto :fail_install
echo [OK] Dependencies installed

:deps_done
REM ---- Build portable exe ----
echo.
echo [BUILD] Building portable exe, please wait...
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"
if defined NODE_BIN goto :build_with_bin
call npx electron-builder --win portable
goto :build_done

:build_with_bin
call "%NODE_BIN%\npx.cmd" electron-builder --win portable

:build_done
if errorlevel 1 goto :fail_build

REM ---- Show result ----
echo.
echo ============================================================
echo  [OK] Build complete!
echo  Output: %APP_DIR%dist\
echo  - CodeBuddy integral widget - portable exe (single file)
echo  - win-unpacked\ (unpacked app dir)
echo  Share the portable exe with others. Double-click to run.
echo ============================================================
echo.
goto :end

:no_node
echo [ERROR] Node.js not detected. Please install Node 18 first.
goto :end

:fail_install
echo [ERROR] Dependency install failed. Check network / mirror config.
goto :end

:fail_build
echo.
echo [ERROR] Build failed. See messages above.

:end
pause
endlocal
