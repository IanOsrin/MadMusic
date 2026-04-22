@echo off
:: ─────────────────────────────────────────────────────────────
::  Digital Cupboard — Demucs AI Stem Server Launcher (Windows)
::  Double-click this file to start the server.
::  Keep this window open while using AI Split in the audio app.
::  Press Ctrl+C to stop the server.
:: ─────────────────────────────────────────────────────────────

title Digital Cupboard - Demucs AI Server
cls

echo.
echo  Digital Cupboard - Demucs AI Stem Server
echo  ------------------------------------------

:: Check Python is available
where python >nul 2>&1
if errorlevel 1 (
    where python3 >nul 2>&1
    if errorlevel 1 (
        echo.
        echo  ERROR: Python not found.
        echo  Install it from https://www.python.org
        echo  Make sure to check "Add Python to PATH" during install.
        echo.
        pause
        exit /b 1
    )
    set PYTHON=python3
) else (
    set PYTHON=python
)

echo  Python found.
echo.
echo  Starting server...
echo  First run downloads the Demucs model (~330 MB^).
echo  Subsequent runs start instantly.
echo.
echo  ------------------------------------------
echo.

%PYTHON% "%~dp0demucs-server.py"

echo.
echo  ------------------------------------------
echo  Server stopped.
echo.
pause
