@echo off
setlocal EnableExtensions
rem ---------------------------------------------------------------------------------------------
rem  Parasites New Dawn - Enhanced :: The Hive Remembers - start the optional Oracle sidecar.
rem  Install location: <instance>\local\pne_oracle\ (this file sits next to sidecar.py there).
rem  The pack works without the sidecar. It stops by itself after 10 minutes without telemetry.
rem  To stop it now, run stop_oracle.cmd: it only creates stop.flag. Nothing here ever ends,
rem  signals or touches any other process on this computer.
rem  Options are passed through, for example:  launch_oracle.cmd --exit-after 120
rem ---------------------------------------------------------------------------------------------
set "HERE=%~dp0"
set "BRIDGE=%HERE:~0,-1%"
if defined PNE_ORACLE_BRIDGE set "BRIDGE=%PNE_ORACLE_BRIDGE%"
if not exist "%BRIDGE%\" mkdir "%BRIDGE%"

set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (
  where python >nul 2>nul && set "PY=python"
)
if not defined PY (
  echo Python 3 was not found. Install Python 3.9 or newer with numpy, then run this again.
  pause
  exit /b 1
)
%PY% -c "import numpy" >nul 2>nul
if errorlevel 1 (
  echo This Python has no numpy. Install it yourself if you want the Oracle ^(python -m pip install numpy^).
  pause
  exit /b 1
)
title PNE Oracle sidecar
echo Starting the Oracle sidecar. Close this window or run stop_oracle.cmd to stop it.
%PY% "%HERE%sidecar.py" --bridge "%BRIDGE%" %*
set "CODE=%ERRORLEVEL%"
if "%CODE%"=="3" echo Another Oracle sidecar is already running for this instance; nothing was changed.
endlocal & exit /b %CODE%
