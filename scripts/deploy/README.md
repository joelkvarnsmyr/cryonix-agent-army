# scripts/deploy/

Deployment automation, database backups, and health monitoring scripts for the Cryonix production VM.

## Files

| File | Description |
|------|-------------|
| `auto-deploy.sh` | Pull-based auto-deploy triggered by cron every minute. Implements a 3-layer safety model: (1) work lock -- skips deploy if `/tmp/cryonix-work.lock` exists (auto-clears after 2h), (2) fast-forward-only pull -- blocks and alerts on diverged branches, (3) post-deploy health check with automatic rollback if containers fail. Sends Telegram alerts on block or rollback. |
| `deploy.sh` | Manual deploy from a local machine. Packages the repo via `git archive` and pushes over SSH, then rebuilds Docker containers on the VM. |
| `deploy-vm.sh` | Runs on the VM after a push (called by GitHub Actions). Performs `git fetch` + `git reset --hard origin/main`, rebuilds Docker containers, and runs a health check against the four core services (web, engine, redis, postgres). |
| `backup-postgres.sh` | Daily `pg_dump` of the `cryonix` database from the `cryonix-postgres-1` container. Compresses to gzip and stores in `~/cryonix/backups/`. Deletes backups older than 7 days. |
| `health-monitor.sh` | Curls the `/api/health` endpoint and parses the JSON response. Sends a Telegram alert with failed checks, latencies, open positions, and market regime when status is `degraded` or `unhealthy`. Silent on `healthy`. |

## Usage

```bash
# Install auto-deploy cron (every minute)
crontab -e
# * * * * * /home/azureuser/cryonix/scripts/deploy/auto-deploy.sh

# Prevent auto-deploy during active work
touch /tmp/cryonix-work.lock    # blocks auto-deploy
rm /tmp/cryonix-work.lock       # re-enables auto-deploy

# Manual deploy from local machine
bash scripts/deploy/deploy.sh

# Daily Postgres backup (add to cron)
# 0 3 * * * /home/azureuser/cryonix/scripts/deploy/backup-postgres.sh

# Health monitor (add to cron, every 5 minutes)
# */5 * * * * /home/azureuser/cryonix/scripts/deploy/health-monitor.sh

# View auto-deploy log
tail -50 /tmp/auto-deploy.log
```

## Environment Variables

Read from `~/cryonix/.env`:

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Telegram bot token for deploy/health alerts. |
| `TELEGRAM_CHAT_ID` | Telegram chat ID for notifications. |
