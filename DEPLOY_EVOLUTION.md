# Quick Deployment Guide - Evolution System

## 🚀 One-Command Deploy

Från din laptop:

```bash
cd C:\Projects\Code\Crypto\cryonix-agent-army
bash scripts/deploy-evolution-to-vm.sh
```

Detta kommer:
1. ✅ Ladda upp alla evolution scripts till VM:en
2. ✅ Installera GitHub CLI + Copilot på VM:en
3. ✅ Skapa database-tabellen
4. ✅ Setup systemd timer för 03:00 UTC

## 📝 Manual Installation (om deploy-scriptet inte funkar)

### Steg 1: SSH in till VM och kör setup

```bash
# Från din laptop - kör alla kommandon på VM:en
ssh azureuser@openclaw-vm

# Nu är du på VM:en
cd ~/cryonix

# Ladda ner senaste koden från din laptop
exit  # Gå tillbaka till laptop

# Från laptop: Skicka koden till VM
cd C:\Projects\Code\Crypto\cryonix-agent-army
git archive --format=tar HEAD | ssh azureuser@openclaw-vm "cd ~/cryonix && tar xf -"

# SSH tillbaka till VM
ssh azureuser@openclaw-vm
cd ~/cryonix
```

### Steg 2: Installera Node dependencies på VM

```bash
# På VM:en
pnpm add pg ioredis

# Gör scripts körbara
chmod +x scripts/*.sh scripts/*.mjs
```

### Steg 3: Installera GitHub Copilot CLI på VM

```bash
# På VM:en

# Installera GitHub CLI (om ej installerat)
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
sudo apt update
sudo apt install gh -y

# Installera Copilot extension
gh extension install github/gh-copilot

# Autentisera (VIKTIGT!)
gh auth login
# Välj: GitHub.com -> HTTPS -> Login with browser -> följ instruktionerna

# Autentisera Copilot
gh copilot auth

# Verifiera
gh copilot --help
```

### Steg 4: Skapa database-tabell på VM

```bash
# På VM:en
docker exec -i cryonix-postgres-1 psql -U postgres -d cryonix << 'EOSQL'
CREATE TABLE IF NOT EXISTS evolution_runs (
  id SERIAL PRIMARY KEY,
  run_id VARCHAR(64) UNIQUE NOT NULL,
  started_at TIMESTAMP WITH TIME ZONE NOT NULL,
  ended_at TIMESTAMP WITH TIME ZONE,
  duration_seconds INTEGER,
  status VARCHAR(20) NOT NULL,
  performance_data JSONB,
  trigger_reason VARCHAR(100),
  weak_pattern VARCHAR(50),
  total_pnl_usd DECIMAL(12, 4),
  changes_made JSONB,
  files_modified TEXT[],
  commit_hash VARCHAR(40),
  verification_passed BOOLEAN,
  deployment_successful BOOLEAN,
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
EOSQL

echo "✅ Database table created"
```

### Steg 5: Setup systemd timer på VM

```bash
# På VM:en
cd ~/cryonix
./scripts/setup-evolution-cron.sh
```

## ✅ Verify Installation

```bash
# Check timer status
sudo systemctl status cryonix-evolution.timer

# Check next run time
sudo systemctl list-timers cryonix-evolution.timer

# Test manual run
cd ~/cryonix
node scripts/copilot-evolution.mjs

# Check logs
tail -f ~/cryonix/logs/evolution.log
```

## 🐛 Troubleshooting

### Problem: "gh: command not found"

```bash
# Installera GitHub CLI igen
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
sudo apt update
sudo apt install gh -y
```

### Problem: "gh copilot: command not found"

```bash
# Installera Copilot extension
gh extension install github/gh-copilot
gh extension upgrade gh-copilot
```

### Problem: "Authentication required"

```bash
# Re-authenticate
gh auth login
gh copilot auth

# Check status
gh auth status
```

### Problem: "Database connection failed"

```bash
# Check Postgres is running
docker ps | grep postgres

# Check connection
docker exec cryonix-postgres-1 psql -U postgres -d cryonix -c "SELECT 1"
```

### Problem: "Permission denied"

```bash
# Fix permissions
cd ~/cryonix
chmod +x scripts/*.sh scripts/*.mjs
sudo chown -R azureuser:azureuser ~/cryonix
```

## 📊 Monitoring After Install

```bash
# Real-time logs
ssh azureuser@openclaw-vm 'tail -f ~/cryonix/logs/evolution.log'

# Check last 5 evolution runs
ssh azureuser@openclaw-vm 'docker exec cryonix-postgres-1 psql -U postgres -d cryonix -c "SELECT run_id, started_at, status, weak_pattern FROM evolution_runs ORDER BY started_at DESC LIMIT 5;"'

# Systemd logs
ssh azureuser@openclaw-vm 'sudo journalctl -u cryonix-evolution.service -n 50'
```

## 🎯 Quick Commands

```bash
# Trigger evolution NOW (don't wait for 03:00)
ssh azureuser@openclaw-vm 'sudo systemctl start cryonix-evolution.service'

# Stop evolution (disable timer)
ssh azureuser@openclaw-vm 'sudo systemctl stop cryonix-evolution.timer'

# Re-enable evolution
ssh azureuser@openclaw-vm 'sudo systemctl start cryonix-evolution.timer'

# View current status
ssh azureuser@openclaw-vm 'sudo systemctl status cryonix-evolution.timer'
```

## 🌙 It runs at 03:00 UTC every night automatically!

Ditt system förbättrar sig själv medan du sover. 🚀
