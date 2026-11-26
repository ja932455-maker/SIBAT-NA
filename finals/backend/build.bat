@echo off
REM ===========================================================================
REM  SIBAT NA - backend/build.bat
REM  Compiles the C++ demo engine and its tests with MinGW g++ (MSYS2 UCRT64).
REM  Run this from anywhere; it always works inside the backend folder.
REM ===========================================================================
setlocal
cd /d "%~dp0"

where g++ >nul 2>nul
if errorlevel 1 (
  set "PATH=C:\msys64\ucrt64\bin;%PATH%"
)

echo [1/3] Building engine...
g++ -std=c++20 -O2 -Wall -Wextra -static ^
  src\core.cpp src\server.cpp src\main.cpp ^
  -o sibat-server.exe -lws2_32
if errorlevel 1 goto :fail

echo [2/3] Building tests...
g++ -std=c++20 -O2 -Wall -Wextra -static ^
  src\core.cpp tests\domain_test.cpp ^
  -o sibat-tests.exe
if errorlevel 1 goto :fail

echo [3/3] Running tests...
sibat-tests.exe
if errorlevel 1 goto :fail

echo.
echo Build OK.
echo Start the app from the project root with:  run.bat
exit /b 0

:fail
echo.
echo BUILD FAILED
exit /b 1
