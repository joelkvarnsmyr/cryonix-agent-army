#!/bin/bash
# Setup cron job for nightly evolution on Azure VM

set -e

echo "🔧 Setting up nightly evolution cron job..."

# Project directory
PROJECT_DIR="$HOME/cryonix"
cd "$PROJECT_DIR"

# Install GitHub Copilot CLI if not already installed
if ! command -v gh &> /dev/null; then
    echo "📦 Installing GitHub CLI..."
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
    sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
    sudo apt update
    sudo apt install gh -y
fi

# Install Copilot extension
echo "🤖 Installing GitHub Copilot CLI extension..."
gh extension install github/gh-copilot || echo "Already installed"

# Authenticate (this requires manual step first time)
if ! gh auth status &> /dev/null; then
    echo "⚠️  GitHub CLI not authenticated. Please run:"
    echo "    gh auth login"
    echo "    gh copilot auth"
    exit 1
fi

# Create systemd service for evolution
echo "📝 Creating systemd service..."

sudo tee /etc/systemd/system/cryonix-evolution.service > /dev/null << EOF
[Unit]
Description=Cryonix Evolution Engine
After=network.target docker.service
Requires=docker.service

[Service]
Type=oneshot
User=azureuser
WorkingDirectory=$PROJECT_DIR
Environment="NODE_ENV=production"
Environment="PROJECT_ROOT=$PROJECT_DIR"
ExecStart=/usr/bin/node $PROJECT_DIR/scripts/copilot-evolution.mjs
StandardOutput=append:$PROJECT_DIR/logs/evolution.log
StandardError=append:$PROJECT_DIR/logs/evolution-error.log

[Install]
WantedBy=multi-user.target
EOF

# Create systemd timer for 03:00 UTC daily
echo "⏰ Creating systemd timer..."

sudo tee /etc/systemd/system/cryonix-evolution.timer > /dev/null << EOF
[Unit]
Description=Cryonix Nightly Evolution Timer
Requires=cryonix-evolution.service

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true
Unit=cryonix-evolution.service

[Install]
WantedBy=timers.target
EOF

# Create logs directory
mkdir -p "$PROJECT_DIR/logs"

# Reload systemd and enable timer
echo "🔄 Enabling systemd timer..."
sudo systemctl daemon-reload
sudo systemctl enable cryonix-evolution.timer
sudo systemctl start cryonix-evolution.timer

# Show status
echo ""
echo "✅ Evolution system installed!"
echo ""
echo "Status:"
sudo systemctl status cryonix-evolution.timer --no-pager
echo ""
echo "Next scheduled run:"
sudo systemctl list-timers cryonix-evolution.timer --no-pager
echo ""
echo "📋 Useful commands:"
echo "  - View timer status: sudo systemctl status cryonix-evolution.timer"
echo "  - View logs: tail -f $PROJECT_DIR/logs/evolution.log"
echo "  - Run manually: sudo systemctl start cryonix-evolution.service"
echo "  - Disable: sudo systemctl disable cryonix-evolution.timer"
echo ""
echo "⚠️  Remember to set these environment variables in the service if needed:"
echo "     POSTGRES_URL, KV_URL, BINANCE_API_KEY, etc."
