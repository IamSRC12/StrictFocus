@echo off
REM ---------------------------------------------------------------------------
REM StrictFocus - code.txt auto-update launcher
REM Keeps code.txt in sync with source files. Leave this window open.
REM   watch_code.bat          -> build once, then watch continuously
REM   watch_code.bat --once   -> build once and exit
REM ---------------------------------------------------------------------------
title StrictFocus code.txt Watcher
node "%~dp0scripts\generate_code.js" %*
if %ERRORLEVEL% NEQ 0 (
  echo.
  echo [ERROR] Could not run node. Is Node.js installed and on PATH?
  pause
)
