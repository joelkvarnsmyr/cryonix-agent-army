# Autonomous Evolution System

**Self-improving trading system using GitHub Copilot CLI**

## Overview

The Cryonix Agent Army includes an autonomous evolution system that runs nightly at **03:00 UTC** on the Azure VM. The system analyzes trading performance, identifies weaknesses, and uses **GitHub Copilot CLI** to autonomously improve the trading logic.

```
┌─────────────────────────────────────────────────────────┐
│  Nightly Evolution Cycle (03:00 UTC)                    │
└─────────────────────────────────────────────────────────┘
           │
           ↓
    1. Analyze Performance
       - Query last 24h trades from Postgres
       - Calculate P&L by pattern
       - Identify weakest pattern
           │
           ↓
    2. Trigger Evolution (if needed)
       - Check if P&L < -$2 threshold
       - Create backup of critical files
           │
           ↓
    3. GitHub Copilot Evolution
       - Generate improvement prompt
       - Run: gh copilot suggest
       - Apply code changes
           │
           ↓
    4. Verification Suite
       ✓ Python tests (verify_deep_value.py, verify_grid.py)
       ✓ TypeScript build (pnpm build)
       ✓ Type checking (pnpm type-check)
       ✓ Unit tests (pnpm test)
           │
           ↓
    5. Deploy to Production
       - Commit changes with [Auto-Evolution] tag
       - Rebuild Docker containers
       - Health check
           │
           ↓
    6. Log Results
       - Store in evolution_runs table
       - Cache in Redis
       - Track metrics over time
```

## Architecture

### Components

1. **copilot-evolution.mjs** - Main evolution engine
   - Performance analysis
   - Copilot orchestration
   - Verification pipeline
   - Auto-deployment

2. **copilot-agent.mjs** - GitHub Copilot wrapper
   - Task execution interface
   - Script generation
   - Code editing helpers

3. **systemd timer** - Scheduling (03:00 UTC daily)
   - Persistent across reboots
   - Logging to `logs/evolution.log`
   - Manual trigger support

4. **Database tracking** - `evolution_runs` table
   - Historical performance
   - Success/failure rates
   - Pattern improvement tracking

## Installation

### On Azure VM

```bash
# 1. SSH into VM
ssh azureuser@openclaw-vm

# 2. Navigate to project
cd ~/cryonix

# 3. Pull latest code with evolution system
git pull origin main

# 4. Install dependencies
pnpm install

# 5. Run database migration
psql $POSTGRES_URL -f packages/database/migrations/006_evolution_runs.sql

# 6. Install GitHub Copilot CLI
gh extension install github/gh-copilot

# 7. Authenticate Copilot
gh auth login
gh copilot auth

# 8. Setup systemd timer
chmod +x scripts/setup-evolution-cron.sh
./scripts/setup-evolution-cron.sh
```

### Verify Installation

```bash
# Check timer status
sudo systemctl status cryonix-evolution.timer

# View next scheduled run
sudo systemctl list-timers cryonix-evolution.timer

# Test run manually
sudo systemctl start cryonix-evolution.service

# View logs
tail -f logs/evolution.log
```

## Configuration

### Environment Variables

Set in systemd service file (`/etc/systemd/system/cryonix-evolution.service`):

```bash
Environment="POSTGRES_URL=postgres://postgres:password@postgres:5432/cryonix"
Environment="KV_URL=redis://redis:6379"
Environment="PROJECT_ROOT=/home/azureuser/cryonix"
Environment="NODE_ENV=production"
```

### Evolution Parameters

Edit `scripts/copilot-evolution.mjs`:

```javascript
const CONFIG = {
  LOOKBACK_HOURS: 24,              // Performance analysis window
  MIN_TRADES_FOR_ANALYSIS: 3,      // Minimum trades to trigger evolution
  PERFORMANCE_THRESHOLD: -2.0,     // Trigger if P&L < -$2
  MAX_EVOLUTION_ATTEMPTS: 3,       // Retry failed mutations
  COPILOT_TIMEOUT: 600000,         // 10 minutes max per attempt
  
  // Files to protect with backups
  CRITICAL_FILES: [
    'packages/engine/src/guilds/quant.py',
    'packages/engine/src/core/risk_gate.py',
    'packages/engine/src/core/risk_manager.py',
    'apps/web/src/app/api/auto-trade/route.ts'
  ]
};
```

## Safety Mechanisms

### 1. Backup Before Evolution
All critical files are backed up to `.evolution-backups/` before any changes.

### 2. Verification Pipeline
All mutations must pass:
- Python regression tests
- TypeScript compilation
- Type checking
- Unit tests

### 3. Automatic Rollback
If verification fails, system automatically:
- Restores from backup
- Reverts git changes (`git reset --hard`)
- Logs failure reason

### 4. Protected Risk Controls
Copilot is explicitly instructed to NEVER remove:
- Stop-loss logic
- Position size limits
- Daily loss limits
- Risk checks

### 5. Max Attempt Limit
System stops after 3 failed evolution attempts to prevent infinite loops.

## Monitoring

### View Evolution History

```sql
-- Recent evolution runs
SELECT 
  run_id, 
  started_at, 
  status, 
  weak_pattern,
  total_pnl_usd,
  duration_seconds
FROM evolution_runs
ORDER BY started_at DESC
LIMIT 10;

-- Success rate by pattern
SELECT 
  weak_pattern,
  COUNT(*) as attempts,
  SUM(CASE WHEN status = 'SUCCESS' THEN 1 ELSE 0 END) as successes,
  ROUND(AVG(total_pnl_usd), 2) as avg_trigger_pnl
FROM evolution_runs
WHERE weak_pattern IS NOT NULL
GROUP BY weak_pattern
ORDER BY attempts DESC;

-- Daily performance view
SELECT * FROM evolution_performance;
```

### Check Logs

```bash
# Real-time evolution log
tail -f ~/cryonix/logs/evolution.log

# Error log
tail -f ~/cryonix/logs/evolution-error.log

# Check last run result
sudo journalctl -u cryonix-evolution.service -n 100
```

### Redis Monitoring

```bash
# Get last run metadata
docker exec cryonix-redis-1 redis-cli HGETALL evolution:latest

# List all evolution runs
docker exec cryonix-redis-1 redis-cli KEYS "evolution:*"
```

## Manual Operations

### Trigger Evolution Manually

```bash
# Run immediately (doesn't wait for 03:00)
sudo systemctl start cryonix-evolution.service

# Or run directly with node
cd ~/cryonix
node scripts/copilot-evolution.mjs
```

### Test Specific Pattern Improvement

```bash
# Use Copilot Agent directly
node scripts/copilot-agent.mjs "improve RSI pattern" \
  --file packages/engine/src/guilds/quant.py \
  --context performance.json
```

### Disable Evolution

```bash
# Stop timer (keeps service intact)
sudo systemctl stop cryonix-evolution.timer
sudo systemctl disable cryonix-evolution.timer

# Re-enable later
sudo systemctl enable cryonix-evolution.timer
sudo systemctl start cryonix-evolution.timer
```

### Emergency Rollback

```bash
# List available backups
ls -la ~/cryonix/.evolution-backups/

# Restore from specific backup
BACKUP_ID="evo_1234567890"
cp -r .evolution-backups/$BACKUP_ID/* .
git reset --hard HEAD~1

# Restart services
docker compose -f docker-compose.prod.yml restart engine web auto-trader
```

## Integration with Dashboard

### API Endpoints (Future)

```typescript
// GET /api/evolution/status
// Returns latest evolution run status

// GET /api/evolution/history
// Returns evolution run history

// POST /api/evolution/trigger
// Manually trigger evolution (admin only)

// GET /api/evolution/metrics
// Evolution effectiveness metrics
```

### Dashboard Widget (Future)

```typescript
// Show evolution status in dashboard
<EvolutionStatus>
  Last run: 3 hours ago
  Status: ✅ Success
  Pattern improved: DEEP_VALUE
  P&L improvement: +$3.50
</EvolutionStatus>
```

## GitHub Copilot CLI Commands

### Used by Evolution System

```bash
# Suggest code improvements
gh copilot suggest -t shell "Improve RSI pattern logic..."

# Explain existing code
gh copilot explain packages/engine/src/guilds/quant.py

# Generate test cases
gh copilot suggest "Generate unit tests for risk_gate.py"
```

### Manual Usage

```bash
# Interactive mode
gh copilot

# Direct suggestion
gh copilot suggest "How do I optimize pandas dataframe performance?"

# Code explanation
gh copilot explain path/to/file.py
```

## Troubleshooting

### Evolution Not Running

```bash
# Check timer is active
sudo systemctl is-active cryonix-evolution.timer

# Check timer is enabled
sudo systemctl is-enabled cryonix-evolution.timer

# View timer logs
sudo journalctl -u cryonix-evolution.timer -f
```

### Copilot Authentication Failed

```bash
# Re-authenticate
gh auth login
gh copilot auth

# Verify
gh copilot --help
```

### Verification Tests Failing

```bash
# Run tests manually
cd ~/cryonix
python scripts/verify_deep_value.py
python scripts/verify_grid.py
pnpm type-check
pnpm test

# Check for syntax errors
python -m py_compile packages/engine/src/guilds/quant.py
```

### Database Connection Issues

```bash
# Check Postgres is running
docker ps | grep postgres

# Test connection
docker exec cryonix-postgres-1 psql -U postgres -d cryonix -c "SELECT 1"

# Check migration applied
docker exec cryonix-postgres-1 psql -U postgres -d cryonix -c "\dt evolution_runs"
```

## Best Practices

### 1. Monitor First Week Closely
- Check logs daily
- Review all auto-commits
- Validate improvements are real

### 2. Gradual Rollout
- Start with conservative thresholds
- Increase autonomy over time
- Keep max attempts low initially

### 3. Track Metrics
- Monitor success rate
- Measure actual P&L improvement
- Analyze pattern-specific results

### 4. Git Hygiene
- All evolution commits tagged `[Auto-Evolution]`
- Easy to review with: `git log --grep="Auto-Evolution"`
- Can revert with: `git revert <commit>`

## Future Improvements

- [ ] Multi-pattern evolution in single run
- [ ] A/B testing framework for mutations
- [ ] Reinforcement learning for evolution strategy
- [ ] Slack/Discord notifications on evolution results
- [ ] Web dashboard for evolution monitoring
- [ ] Automatic PR creation for human review
- [ ] Cloud-based Copilot API integration
- [ ] Evolution effectiveness scoring

## Support

For issues or questions:
1. Check logs: `tail -f ~/cryonix/logs/evolution.log`
2. Review recent commits: `git log --oneline --grep="Auto-Evolution"`
3. Check systemd status: `sudo systemctl status cryonix-evolution.service`
4. Inspect database: `SELECT * FROM evolution_runs ORDER BY started_at DESC LIMIT 5;`

---

**Status**: 🟢 Active (runs nightly at 03:00 UTC)  
**Last Updated**: 2026-02-14  
**Version**: 1.0.0
