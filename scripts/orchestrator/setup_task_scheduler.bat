@echo off
REM Setup Windows Task Scheduler for Master Orchestrator
REM Run as Administrator

set PROJECT_ROOT=C:\Projects\Code\Crypto\cryonix-agent-army

echo Creating Master Orchestrator task (every 4 hours)...
schtasks /Create /TN "CryonixMasterOrchestrator" /TR "%PROJECT_ROOT%\scripts\orchestrator\run_orchestrator.bat" /SC HOURLY /MO 4 /ST 00:00 /F /RL HIGHEST

echo Creating Watchdog task (every 30 minutes)...
schtasks /Create /TN "CryonixOrchestratorWatchdog" /TR "%PROJECT_ROOT%\scripts\orchestrator\watchdog.bat" /SC MINUTE /MO 30 /F /RL HIGHEST

echo Creating catch-up task (run at logon after PC restart)...
schtasks /Create /TN "CryonixOrchestratorCatchup" /TR "%PROJECT_ROOT%\scripts\orchestrator\run_orchestrator.bat" /SC ONLOGON /F /RL HIGHEST /DELAY 0002:00

echo.
echo Done! Verify with:
echo   schtasks /Query /TN "CryonixMasterOrchestrator"
echo   schtasks /Query /TN "CryonixOrchestratorWatchdog"
echo   schtasks /Query /TN "CryonixOrchestratorCatchup"
echo.
echo IMPORTANT: Set these environment variables before first run:
echo   TELEGRAM_ORCHESTRATOR_BOT_TOKEN
echo   TELEGRAM_ORCHESTRATOR_CHAT_ID
echo.
echo To set them system-wide:
echo   setx TELEGRAM_ORCHESTRATOR_BOT_TOKEN "your_token"
echo   setx TELEGRAM_ORCHESTRATOR_CHAT_ID "your_chat_id"
echo.
echo NOTE: After setx, restart your terminal for changes to take effect.
pause
