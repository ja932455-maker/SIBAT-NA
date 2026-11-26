@echo off
REM ===========================================================================
REM  SIBAT NA - run.bat
REM  Builds the C++ engine if needed, starts it on :8787 and opens the app.
REM ===========================================================================
setlocal
cd /d "%~dp0"

if not exist "backend\sibat-server.exe" (
  echo Engine not built yet - building now...
  call "backend\build.bat"
  if errorlevel 1 (
    echo Build failed. Fix the errors above, then run this file again.
    pause
    exit /b 1
  )
)

echo Starting the Sibat Na C++ engine on http://127.0.0.1:8787 ...
start "Sibat Na engine" /min "%~dp0backend\sibat-server.exe" --port 8787
timeout /t 1 /nobreak >nul
start "" "http://127.0.0.1:8787/"

echo.
echo App:     http://127.0.0.1:8787/
echo Admin:   http://127.0.0.1:8787/assets/compiled/frontend-all.html
echo Driver:  http://127.0.0.1:8787/#driver  (gate 2468)
echo.
echo Close the minimised "Sibat Na engine" window to stop the server.
endlocal
