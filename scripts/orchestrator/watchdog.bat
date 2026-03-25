@echo off
REM Watchdog — Windows Task Scheduler wrapper
set "SCRIPT_DIR=%~dp0"
set "PROJECT_ROOT=%SCRIPT_DIR%..\.."
"C:\Program Files\Git\bin\bash.exe" -l -c "cd '%PROJECT_ROOT%' && bash scripts/orchestrator/watchdog.sh"
