@echo off
setlocal

rem Double-click entry for the desktop development window (dev build, hot reload).
rem With no arguments it restarts: closes the previous dev window, then starts a
rem fresh foreground session (close that window or press Ctrl+C to stop).
rem The engine is apps\desktop\scripts\dev-desktop.ps1; AI/CLI development calls it
rem directly with -Action start|stop|status|restart (see docs/deployment).
rem Keep this file ASCII-only: cmd.exe reads batch files in the OEM codepage.

if "%~1"=="" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0apps\desktop\scripts\dev-desktop.ps1" -Action restart
  set "DEV_DESKTOP_EXIT=%ERRORLEVEL%"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0apps\desktop\scripts\dev-desktop.ps1" %*
  set "DEV_DESKTOP_EXIT=%ERRORLEVEL%"
)

if not "%DEV_DESKTOP_EXIT%"=="0" (
  echo.
  echo Dev desktop stopped with exit code %DEV_DESKTOP_EXIT%.
  pause
)

exit /b %DEV_DESKTOP_EXIT%
