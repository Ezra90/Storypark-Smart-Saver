@echo off
setlocal enabledelayedexpansion
title Storypark Photo Sync – Windows Installer

echo.
echo ============================================================
echo   Storypark Photo Sync – Windows Installer
echo ============================================================
echo.
echo This will install everything the app needs on your PC.
echo It may take 10-30 minutes (mostly compiling face recognition).
echo.
echo Please do NOT close this window while it runs.
echo.
pause

REM ── Change to the folder this script lives in ──────────────────
cd /d "%~dp0"

REM ── 1. Check for Python 3.10+ ──────────────────────────────────
echo [1/6] Checking for Python 3.10 or later...
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

REM ── 2. Check / install CMake ────────────────────────────────────
echo [2/6] Checking for CMake...
cmake --version >nul 2>&1
if errorlevel 1 (
    echo     CMake not found. Installing via winget...
    winget install --id Kitware.CMake --source winget --accept-source-agreements --accept-package-agreements
    if errorlevel 1 (
        echo.
        echo     ERROR: Could not install CMake automatically.
        echo     Please install it from: https://cmake.org/download/
        echo     Choose "Add CMake to the system PATH" during install,
        echo     then re-run this installer.
        echo.
        pause
        exit /b 1
    )
    REM Refresh PATH for this session
    call refreshenv >nul 2>&1
) else (
    for /f "tokens=3" %%v in ('cmake --version 2^>^&1 ^| findstr /i "cmake version"') do echo     Found CMake %%v.
)

REM ── 3. Check / install Visual C++ Build Tools ───────────────────
echo [3/6] Checking for Visual C++ Build Tools...
where cl.exe >nul 2>&1
if errorlevel 1 (
    echo     C++ compiler not found. Installing Visual C++ Build Tools...
    echo     This download is about 3 GB and may take several minutes.
    winget install --id Microsoft.VisualStudio.2022.BuildTools --source winget ^
        --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended" ^
        --accept-source-agreements --accept-package-agreements
    if errorlevel 1 (
        echo.
        echo     ERROR: Could not install Build Tools automatically.
        echo     Please install them manually from:
        echo     https://visualstudio.microsoft.com/visual-cpp-build-tools/
        echo     Select "Desktop development with C++" then re-run this installer.
        echo.
        pause
        exit /b 1
    )
)
echo     C++ Build Tools: OK

REM ── 4. Create virtual environment ──────────────────────────────
echo [4/6] Creating Python virtual environment...
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

REM ── 5. Install Python dependencies ────────────────────────────
echo [5/6] Installing Python dependencies...
echo     (The face_recognition step compiles C++ code and may take 10-30 minutes)
echo.
call venv\Scripts\activate
python -m pip install --upgrade pip --quiet
pip install -r requirements.txt
if errorlevel 1 (
    echo.
    echo     ERROR: Dependency installation failed.
    echo     Common fix: make sure Visual C++ Build Tools were installed correctly.
    echo     See WINDOWS.md for alternative installation methods.
    pause
    exit /b 1
)

REM ── 6. Install Playwright browser ─────────────────────────────
echo [6/6] Installing Playwright browser (Chromium)...
playwright install chromium
if errorlevel 1 (
    echo     WARNING: Playwright browser install had issues.
    echo     Try running:  venv\Scripts\playwright install chromium
    echo     If your antivirus blocks it, temporarily disable it and retry.
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
