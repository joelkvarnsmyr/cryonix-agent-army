@echo off
REM Master Orchestrator — Windows Task Scheduler wrapper
REM Runs the orchestrator via Git Bash

set "SCRIPT_DIR=%~dp0"
set "PROJECT_ROOT=%SCRIPT_DIR%..\.."

"C:\Program Files\Git\bin\bash.exe" -l -c "cd '%PROJECT_ROOT%' && bash scripts/orchestrator/run_orchestrator.sh"
