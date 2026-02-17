#!/bin/bash
# Remote deployment script - runs FROM your laptop TO deploy on VM
# Usage: ./deploy-evolution-to-vm.sh

set -e

VM_HOST="azureuser@openclaw-vm"
PROJECT_DIR="~/cryonix"

echo "🚀 Deploying Evolution System to Azure VM"
echo "   Target: $VM_HOST"
echo "   Project: $PROJECT_DIR"
echo ""

# Step 1: Upload new files to VM
echo "📦 Step 1: Uploading evolution scripts to VM..."
scp scripts/copilot-evolution.mjs "$VM_HOST:$PROJECT_DIR/scripts/"
scp scripts/copilot-agent.mjs "$VM_HOST:$PROJECT_DIR/scripts/"
scp scripts/setup-evolution-cron.sh "$VM_HOST:$PROJECT_DIR/scripts/"
scp EVOLUTION.md "$VM_HOST:$PROJECT_DIR/"

echo "✅ Files uploaded"

# Step 2: Install dependencies on VM
echo ""
echo "📦 Step 2: Installing dependencies on VM..."
ssh "$VM_HOST" << 'ENDSSH'
cd ~/cryonix

# Install pg and ioredis if not present
if ! npm list -g pg ioredis > /dev/null 2>&1; then
    echo "Installing Node.js dependencies..."
    pnpm add pg ioredis
fi

# Make scripts executable
chmod +x scripts/copilot-evolution.mjs
chmod +x scripts/copilot-agent.mjs
chmod +x scripts/setup-evolution-cron.sh

echo "✅ Dependencies installed"
ENDSSH

# Step 3: Setup GitHub CLI and Copilot on VM
echo ""
echo "🤖 Step 3: Setting up GitHub Copilot CLI on VM..."

# Check if GITHUB_TOKEN is set
if [ -z "$GITHUB_TOKEN" ]; then
    echo "⚠️  GITHUB_TOKEN not set. Skipping authentication."
    echo "   You can set it with: export GITHUB_TOKEN=your_pat_token"
    USE_PAT=false
else
    echo "✅ Using PAT for authentication"
    USE_PAT=true
fi

ssh "$VM_HOST" << ENDSSH
# Check if gh is installed
if ! command -v gh &> /dev/null; then
    echo "📦 Installing GitHub CLI..."
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
    sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
    echo "deb [arch=\$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
    sudo apt update
    sudo apt install gh -y
    echo "✅ GitHub CLI installed"
else
    echo "✅ GitHub CLI already installed"
fi

# Authenticate with PAT if provided
if [ "$USE_PAT" = true ]; then
    echo "🔐 Authenticating with PAT..."
    echo "$GITHUB_TOKEN" | gh auth login --with-token
    echo "✅ GitHub authenticated with PAT"
fi

# Install Copilot extension
if ! gh extension list | grep -q "gh-copilot"; then
    echo "🤖 Installing GitHub Copilot extension..."
    gh extension install github/gh-copilot
    echo "✅ Copilot extension installed"
else
    echo "✅ Copilot extension already installed"
fi

# Verify authentication
if gh auth status &> /dev/null; then
    echo "✅ GitHub authentication verified"
else
    echo "⚠️  GitHub not authenticated"
fi
ENDSSH

# Step 4: Create database table
echo ""
echo "🗄️  Step 4: Creating evolution_runs table..."
ssh "$VM_HOST" << 'ENDSSH'
cd ~/cryonix

# Create the SQL migration if migrations dir exists
if [ -d "packages/database/migrations" ]; then
    cat > /tmp/evolution_migration.sql << 'EOSQL'
-- Migration: Evolution Runs Tracking
CREATE TABLE IF NOT EXISTS evolution_runs (
  id SERIAL PRIMARY KEY,
  run_id VARCHAR(64) UNIQUE NOT NULL,
  started_at TIMESTAMP WITH TIME ZONE NOT NULL,
  ended_at TIMESTAMP WITH TIME ZONE,
  duration_seconds INTEGER,
  status VARCHAR(20) NOT NULL CHECK (status IN ('RUNNING', 'SUCCESS', 'FAILED', 'CANCELLED')),
  
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
  
  copilot_version VARCHAR(50),
  attempt_number INTEGER DEFAULT 1,
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_evolution_runs_started_at ON evolution_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_evolution_runs_status ON evolution_runs(status);
EOSQL

    # Run migration
    docker exec cryonix-postgres-1 psql -U postgres -d cryonix -f /tmp/evolution_migration.sql 2>/dev/null || \
    docker exec -i cryonix-postgres-1 psql -U postgres -d cryonix < /tmp/evolution_migration.sql
    
    echo "✅ Database table created"
else
    echo "⚠️  Skipping database migration (directory not found)"
fi
ENDSSH

# Step 5: Setup systemd timer
echo ""
echo "⏰ Step 5: Setting up systemd timer..."
ssh "$VM_HOST" << 'ENDSSH'
cd ~/cryonix
./scripts/setup-evolution-cron.sh
ENDSSH

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Evolution System Deployed Successfully!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📋 Next steps:"
echo ""
echo "1. Authenticate GitHub Copilot on VM:"
echo "   ssh $VM_HOST"
echo "   gh auth login"
echo "   gh copilot auth"
echo ""
echo "2. Verify installation:"
echo "   ssh $VM_HOST 'sudo systemctl status cryonix-evolution.timer'"
echo ""
echo "3. Test manual run:"
echo "   ssh $VM_HOST 'cd ~/cryonix && node scripts/copilot-evolution.mjs'"
echo ""
echo "4. Check logs:"
echo "   ssh $VM_HOST 'tail -f ~/cryonix/logs/evolution.log'"
echo ""
echo "🌙 Scheduled: Every night at 03:00 UTC"
echo ""
