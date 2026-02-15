@echo off
REM Windows deployment script for Evolution System
REM Run from: C:\Projects\Code\Crypto\cryonix-agent-army

echo ============================================
echo Deploying Evolution System to Azure VM
echo ============================================
echo.

set VM_HOST=azureuser@openclaw-vm
set PROJECT_DIR=~/cryonix
set GITHUB_TOKEN=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

echo Step 1: Uploading files to VM...
scp scripts\copilot-evolution.mjs %VM_HOST%:%PROJECT_DIR%/scripts/
scp scripts\copilot-agent.mjs %VM_HOST%:%PROJECT_DIR%/scripts/
scp scripts\setup-evolution-cron.sh %VM_HOST%:%PROJECT_DIR%/scripts/
scp EVOLUTION.md %VM_HOST%:%PROJECT_DIR%/

echo.
echo Files uploaded successfully!
echo.

echo Step 2: Installing dependencies on VM...
ssh %VM_HOST% "cd ~/cryonix && pnpm add pg ioredis && chmod +x scripts/*.sh scripts/*.mjs"

echo.
echo Step 3: Setting up GitHub CLI and Copilot...
ssh %VM_HOST% "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && echo 'deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main' | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null && sudo apt update && sudo apt install gh -y"

echo.
echo Step 4: Authenticating with PAT...
ssh %VM_HOST% "echo %GITHUB_TOKEN% | gh auth login --with-token"

echo.
echo Step 5: Installing Copilot extension...
ssh %VM_HOST% "gh extension install github/gh-copilot || echo 'Already installed'"

echo.
echo Step 6: Creating database table...
ssh %VM_HOST% "docker exec -i cryonix-postgres-1 psql -U postgres -d cryonix -c \"CREATE TABLE IF NOT EXISTS evolution_runs (id SERIAL PRIMARY KEY, run_id VARCHAR(64) UNIQUE NOT NULL, started_at TIMESTAMP WITH TIME ZONE NOT NULL, ended_at TIMESTAMP WITH TIME ZONE, duration_seconds INTEGER, status VARCHAR(20) NOT NULL, performance_data JSONB, trigger_reason VARCHAR(100), weak_pattern VARCHAR(50), total_pnl_usd DECIMAL(12,4), changes_made JSONB, files_modified TEXT[], commit_hash VARCHAR(40), verification_passed BOOLEAN, deployment_successful BOOLEAN, error_message TEXT, created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP);\""

echo.
echo Step 7: Setting up systemd timer...
ssh %VM_HOST% "cd ~/cryonix && ./scripts/setup-evolution-cron.sh"

echo.
echo ============================================
echo Deployment Complete!
echo ============================================
echo.
echo Next run: Tonight at 03:00 UTC
echo.
echo Check status:
echo   ssh %VM_HOST% "sudo systemctl status cryonix-evolution.timer"
echo.
echo Test now:
echo   ssh %VM_HOST% "cd ~/cryonix && node scripts/copilot-evolution.mjs"
echo.
echo View logs:
echo   ssh %VM_HOST% "tail -f ~/cryonix/logs/evolution.log"
echo.

pause
