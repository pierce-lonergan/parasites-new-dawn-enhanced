@echo off
setlocal EnableExtensions
rem ---------------------------------------------------------------------------------------------
rem  Parasites New Dawn - Enhanced :: The Hive Remembers - ask the Oracle sidecar to stop.
rem  This only creates stop.flag in the bridge folder. The sidecar sees it within 25 ms, stops its
rem  worker through the worker's own pipe, deletes the flag and its lock, and exits by itself.
rem  A flag created while no sidecar runs is harmless: the next start removes it (it is older than that
rem  process) instead of stopping.
rem  No process is ended, signalled or looked up by this script.
rem ---------------------------------------------------------------------------------------------
set "HERE=%~dp0"
set "BRIDGE=%HERE:~0,-1%"
if defined PNE_ORACLE_BRIDGE set "BRIDGE=%PNE_ORACLE_BRIDGE%"
if not exist "%BRIDGE%\" (
  echo No bridge folder at "%BRIDGE%".
  exit /b 1
)
type nul > "%BRIDGE%\stop.flag"
echo stop.flag created in "%BRIDGE%". The sidecar exits within a second if it is running.
if not exist "%BRIDGE%\sidecar.lock" echo No sidecar.lock there, so no sidecar seems to be running; the next start ignores this flag.
endlocal & exit /b 0
