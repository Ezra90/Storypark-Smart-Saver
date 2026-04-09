@echo off
setlocal enabledelayedexpansion
title Storypark Photo Sync – Windows Installer

echo.
echo ============================================================
echo   Storypark Photo Sync – Windows Installer
echo ============================================================
echo.
echo This will install everything the app needs on your PC.
echo Installation takes about 2 minutes.
echo.
echo Please do NOT close this window while it runs.
echo.
pause

REM ── Change to the folder this script lives in ──────────────────
cd /d "%~dp0"

REM ── 1. Check for Python 3.10+ ──────────────────────────────────
echo [1/4] Checking for Python 3.10 or later...
python --version >nul 2>&1
if errorlevel 1 (
    echo     Python not found. Installing via winget...
    winget install --id Python.Python.3.12 --source winget --accept-source-agreements --accept-package-agreements
    if errorlevel 1 (
        echo.
        echo     ERROR: Could not install Python automatically.
        echo     Please download and install Python 3.12 manually from:
        echo     https://www.python.org/downloads/
        echo     Make sure to tick "Add Python to PATH" during install.
        echo.
        pause
        exit /b 1
    )
    echo     Restarting installer to pick up new PATH...
    start "" "%~f0"
    exit /b 0
)

for /f "tokens=2 delims= " %%v in ('python --version 2^>^&1') do set PYVER=%%v
echo     Found Python %PYVER%.

REM ── 2. Create virtual environment ──────────────────────────────
echo [2/4] Creating Python virtual environment...
if exist "venv\Scripts\python.exe" (
    echo     Virtual environment already exists, skipping.
) else (
    python -m venv venv
    if errorlevel 1 (
        echo     ERROR: Failed to create virtual environment.
        pause
        exit /b 1
    )
    echo     Virtual environment created.
)

REM ── 3. Install Python dependencies ────────────────────────────
echo [3/4] Installing Python dependencies (pre-compiled, no build tools needed)...
call venv\Scripts\activate
python -m pip install --upgrade pip --quiet

echo        - Installing pre-compiled dlib (dlib-bin)...
pip install dlib-bin
if errorlevel 1 (
    echo.
    echo     ERROR: Could not install pre-compiled dlib (dlib-bin).
    echo     dlib-bin supports Python 3.11 and 3.12 on Windows.
    echo     You are running Python %PYVER%.
    echo.
    echo     Please install Python 3.11 or 3.12 from https://www.python.org/downloads/
    echo     then re-run this installer.
    echo.
    pause
    exit /b 1
)

echo        - Installing remaining dependencies from requirements.txt...
pip install -r requirements.txt
if errorlevel 1 (
    echo.
    echo     ERROR: Dependency installation failed.
    echo     See WINDOWS.md for troubleshooting steps.
    pause
    exit /b 1
)

REM ── 4. Install Playwright browser ─────────────────────────────
echo [4/4] Installing Playwright browser (Chromium)...
playwright install chromium >nul 2>&1
if errorlevel 1 (
    echo     WARNING: Playwright browser install had issues.
    echo     Try running:  venv\Scripts\playwright install chromium
    echo     If your antivirus blocks it, temporarily disable it and retry.
) else (
    echo     Chromium installed successfully.
)

REM ── Check for client_secret.json ──────────────────────────────
echo.
echo ============================================================
echo   Installation complete!
echo ============================================================
echo.

if not exist "client_secret.json" (
    echo   IMPORTANT: client_secret.json is missing!
    echo.
    echo   Before you can use the app, you need to:
    echo   1. Follow the Google Cloud setup in WINDOWS.md
    echo   2. Download client_secret.json and save it here:
    echo      %~dp0client_secret.json
    echo.
) else (
    echo   client_secret.json found - ready to go!
    echo.
)

echo   To start the app, double-click:  run_windows.bat
echo.
pause
