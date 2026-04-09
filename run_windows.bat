@echo off
REM run_windows.bat – Double-click launcher for Storypark Photo Sync (Windows)
REM
REM Opens the GUI application.  Run install_windows.bat first if you have
REM not installed the app yet.

setlocal
cd /d "%~dp0"

if not exist "venv\Scripts\python.exe" (
    echo.
    echo  Virtual environment not found.
    echo  Please run install_windows.bat first.
    echo.
    pause
    exit /b 1
)

if not exist "client_secret.json" (
    echo.
    echo  WARNING: client_secret.json not found.
    echo  The app will open, but Google Photos connection will fail until
    echo  you place client_secret.json in this folder.
    echo  See WINDOWS.md for instructions.
    echo.
    timeout /t 4 >nul
)

call venv\Scripts\activate
python gui.py
