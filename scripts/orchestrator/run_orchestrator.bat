@echo off
REM Master Orchestrator — Windows Task Scheduler wrapper
REM Runs the orchestrator via Git Bash

set PROJECT_ROOT=C:\Projects\Code\Crypto\cryonix-agent-army

REM Use Git Bash to execute the shell script
"C:\Program Files\Git\bin\bash.exe" -l -c "cd /c/Projects/Code/Crypto/cryonix-agent-army && bash scripts/orchestrator/run_orchestrator.sh"
