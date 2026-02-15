#!/bin/bash
# scripts/deploy.sh

# Configuration
VM_USER="azureuser"
VM_HOST="openclaw-vm"
REMOTE_DIR="~/cryonix"

echo "🚀 Deploying to $VM_HOST..."

# 1. Package and Push
echo "📦 Packaging and pushing code..."
# Use git archive to respect .gitignore
git archive --format=tar HEAD | ssh $VM_USER@$VM_HOST "mkdir -p $REMOTE_DIR && cd $REMOTE_DIR && tar xf -"

if [ $? -ne 0 ]; then
    echo "❌ Failed to push code."
    exit 1
fi

# 2. Rebuild and Restart
echo "🔄 Rebuilding Docker containers..."
ssh $VM_USER@$VM_HOST "cd $REMOTE_DIR && docker compose -f docker-compose.prod.yml up -d --build engine web"

if [ $? -ne 0 ]; then
    echo "❌ Failed to rebuild containers."
    exit 1
fi

echo "✅ Deployment complete!"
echo "   Monitor logs with: ssh $VM_USER@$VM_HOST 'docker logs -f cryonix-engine-1'"
