@echo off
cd /d "C:\Projects\Code\Crypto\cryonix-agent-army"
echo Starting Evolution Cycle at %date% %time% >> evolution.log

:: Ensure environment variables (if needed locally, or rely on .env)
:: set POSTGRES_URL=... 

:: Run the evolver
node scripts/copilot-evolution.mjs >> evolution.log 2>&1

echo Completed at %date% %time% >> evolution.log
echo -------------------------------------------- >> evolution.log
