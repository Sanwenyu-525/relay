@echo off
setlocal

rem Desktop trial entry point. Legacy preview flags remain supported.
rem Usage: dev-stack.bat [Build|Start|Stop|Preview|DesktopDev|Status] [options]
rem
rem Menu mode (no arguments) hands the console to PowerShell and returns at once.
rem A foreground batch job makes cmd.exe swallow Ctrl+C with its
rem "Terminate batch job (Y/N)?" prompt instead of returning to the menu.
rem Keep this file ASCII-only: cmd.exe reads batch files in the OEM codepage.

if "%~1"=="" (
  start "Relay Desktop Trial" /b powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\test-desktop.ps1"
  exit /b 0
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\test-desktop.ps1" %*
set "DEV_STACK_EXIT=%ERRORLEVEL%"

if not "%DEV_STACK_EXIT%"=="0" (
  echo.
  echo Dev stack stopped with exit code %DEV_STACK_EXIT%.
  pause
)

exit /b %DEV_STACK_EXIT%
