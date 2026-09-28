@echo off
setlocal

rem Double-click for the desktop trial menu. Legacy preview flags remain supported.
rem Usage: dev-stack.bat [Build|Start|Stop|Preview|Status] [options]

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\test-desktop.ps1" %*
set "DEV_STACK_EXIT=%ERRORLEVEL%"

if not "%DEV_STACK_EXIT%"=="0" (
  echo.
  echo Dev stack stopped with exit code %DEV_STACK_EXIT%.
  pause
)

exit /b %DEV_STACK_EXIT%
