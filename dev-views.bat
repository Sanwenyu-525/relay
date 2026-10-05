@echo off
setlocal

rem One-click entry: start the feature map server, then open the feature map,
rem preview.html and motion-border-prototype.html in the default browser.
rem Keep this file ASCII-only: cmd.exe reads batch files in the OEM codepage.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\open-dev-views.ps1"
set "DEV_VIEWS_EXIT=%ERRORLEVEL%"

if not "%DEV_VIEWS_EXIT%"=="0" (
  echo.
  echo Failed to open the dev views with exit code %DEV_VIEWS_EXIT%.
  pause
)

exit /b %DEV_VIEWS_EXIT%