@echo off
setlocal

rem Double-click entry point for the dev stack: apps/api + apps/workbench preview.
rem All checks and the start/stop logic live in scripts\dev-stack.ps1 (single source).
rem Usage: dev-stack.bat [-FrontendOnly] [-FrontendPort 5173] [-SkipInstall] [-SkipBuild]

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev-stack.ps1" %*
set "DEV_STACK_EXIT=%ERRORLEVEL%"

if not "%DEV_STACK_EXIT%"=="0" (
  echo.
  echo Dev stack stopped with exit code %DEV_STACK_EXIT%.
  pause
)

exit /b %DEV_STACK_EXIT%