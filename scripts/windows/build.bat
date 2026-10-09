@echo off
setlocal

pwsh.exe -NoProfile -ExecutionPolicy Bypass ^
  -File "%~dp0full-build-installer.ps1"

set EXITCODE=%ERRORLEVEL%

if not "%EXITCODE%"=="0" (
  echo.
  echo ========================================
  echo StreamDBC build FAILED.
  echo Exit code: %EXITCODE%
  echo ========================================
  pause
  exit /b %EXITCODE%
)

echo.
echo ========================================
echo StreamDBC build completed successfully.
echo ========================================
pause
exit /b 0