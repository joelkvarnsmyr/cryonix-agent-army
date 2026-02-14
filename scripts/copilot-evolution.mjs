#!/usr/bin/env node
/**
 * Copilot Evolution Engine
 * Autonomous self-improvement system using GitHub Copilot CLI
 * Runs nightly at 03:00 UTC on Azure VM
 */

import { spawn } from 'child_process';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import pg from 'pg';
import Redis from 'ioredis';

const { Client } = pg;

// Configuration
const CONFIG = {
  DB_URL: process.env.POSTGRES_URL || 'postgresql://postgres:password@postgres:5432/cryonix',
  REDIS_URL: process.env.KV_URL || 'redis://redis:6379',
  LOOKBACK_HOURS: 24,
  MIN_TRADES_FOR_ANALYSIS: 3,
  PERFORMANCE_THRESHOLD: -2.0, // Trigger evolution if daily PnL < -2%
  MAX_EVOLUTION_ATTEMPTS: 3,
  COPILOT_TIMEOUT: 600000, // 10 minutes
  PROJECT_ROOT: '/home/azureuser/cryonix',
  
  // Test suite to run after mutation
  VERIFICATION_COMMANDS: [
    'python scripts/verify_deep_value.py',
    'python scripts/verify_grid.py',
    'pnpm type-check',
    'pnpm test'
  ],
  
  // Critical files to backup before evolution
  CRITICAL_FILES: [
    'packages/engine/src/guilds/quant.py',
    'packages/engine/src/core/risk_gate.py',
    'packages/engine/src/core/risk_manager.py',
    'apps/web/src/app/api/auto-trade/route.ts'
  ]
};

class EvolutionEngine {
  constructor() {
    this.db = null;
    this.redis = null;
    this.runId = `evo_${Date.now()}`;
    this.startTime = new Date();
  }

  async initialize() {
    console.log(`[${this.runId}] 🚀 Initializing Evolution Engine...`);
    
    // Connect to Postgres
    this.db = new Client({ connectionString: CONFIG.DB_URL });
    await this.db.connect();
    console.log('✅ Connected to Postgres');
    
    // Connect to Redis
    this.redis = new Redis(CONFIG.REDIS_URL);
    await this.redis.ping();
    console.log('✅ Connected to Redis');
    
    // Store run metadata
    await this.redis.hset(`evolution:${this.runId}`, {
      started_at: this.startTime.toISOString(),
      status: 'RUNNING'
    });
  }

  async analyzePerformance() {
    console.log('\n📊 Analyzing trading performance...');
    
    const query = `
      SELECT 
        pattern,
        COUNT(*) as trade_count,
        SUM(pnl_usd) as total_pnl,
        AVG(pnl_pct) as avg_roi,
        SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN pnl_usd < 0 THEN 1 ELSE 0 END) as losses,
        MAX(pnl_usd) as best_trade,
        MIN(pnl_usd) as worst_trade
      FROM trades 
      WHERE status = 'CLOSED' 
        AND closed_at > NOW() - INTERVAL '${CONFIG.LOOKBACK_HOURS} hours'
      GROUP BY pattern
      ORDER BY total_pnl ASC;
    `;
    
    const result = await this.db.query(query);
    
    if (result.rows.length === 0) {
      console.log('⚠️  No closed trades in the last 24h. Skipping evolution.');
      return null;
    }
    
    // Calculate portfolio-level metrics
    const totalPnl = result.rows.reduce((sum, row) => sum + parseFloat(row.total_pnl), 0);
    const totalTrades = result.rows.reduce((sum, row) => sum + parseInt(row.trade_count), 0);
    const avgPnl = totalPnl / totalTrades;
    
    console.log(`\n📈 Performance Summary (${CONFIG.LOOKBACK_HOURS}h):`);
    console.log(`   Total Trades: ${totalTrades}`);
    console.log(`   Total P&L: $${totalPnl.toFixed(2)}`);
    console.log(`   Avg P&L per trade: $${avgPnl.toFixed(2)}\n`);
    
    // Pattern breakdown
    console.log('Pattern Performance:');
    result.rows.forEach(row => {
      const winRate = (parseInt(row.wins) / parseInt(row.trade_count) * 100).toFixed(1);
      console.log(`  ${row.pattern}:`);
      console.log(`    Trades: ${row.trade_count} | Win Rate: ${winRate}%`);
      console.log(`    P&L: $${parseFloat(row.total_pnl).toFixed(2)} | Avg ROI: ${parseFloat(row.avg_roi).toFixed(2)}%`);
      console.log(`    Best: $${parseFloat(row.best_trade).toFixed(2)} | Worst: $${parseFloat(row.worst_trade).toFixed(2)}\n`);
    });
    
    // Check if evolution is needed
    if (totalTrades < CONFIG.MIN_TRADES_FOR_ANALYSIS) {
      console.log(`⚠️  Insufficient trades (${totalTrades} < ${CONFIG.MIN_TRADES_FOR_ANALYSIS}). Skipping evolution.`);
      return null;
    }
    
    // Find weakest pattern
    const weakestPattern = result.rows[0];
    const weakestPnl = parseFloat(weakestPattern.total_pnl);
    
    return {
      totalPnl,
      totalTrades,
      avgPnl,
      patterns: result.rows,
      weakestPattern: weakestPattern.pattern,
      weakestPnl,
      needsEvolution: totalPnl < CONFIG.PERFORMANCE_THRESHOLD
    };
  }

  async createBackup() {
    console.log('\n💾 Creating backup of critical files...');
    
    const backupDir = join(CONFIG.PROJECT_ROOT, '.evolution-backups', this.runId);
    await this.execCommand(`mkdir -p ${backupDir}`);
    
    for (const file of CONFIG.CRITICAL_FILES) {
      const source = join(CONFIG.PROJECT_ROOT, file);
      const dest = join(backupDir, file);
      await this.execCommand(`mkdir -p $(dirname ${dest})`);
      await this.execCommand(`cp ${source} ${dest}`);
      console.log(`  ✅ Backed up: ${file}`);
    }
    
    return backupDir;
  }

  async restoreBackup(backupDir) {
    console.log('\n🔄 Restoring from backup...');
    
    for (const file of CONFIG.CRITICAL_FILES) {
      const source = join(backupDir, file);
      const dest = join(CONFIG.PROJECT_ROOT, file);
      await this.execCommand(`cp ${source} ${dest}`);
      console.log(`  ✅ Restored: ${file}`);
    }
  }

  async runCopilotEvolution(performanceData) {
    console.log('\n🤖 Running GitHub Copilot CLI evolution...');
    
    const prompt = this.constructPrompt(performanceData);
    
    // Save prompt to file for Copilot
    const promptFile = join(CONFIG.PROJECT_ROOT, '.evolution-prompts', `${this.runId}.md`);
    await this.execCommand(`mkdir -p $(dirname ${promptFile})`);
    await writeFile(promptFile, prompt);
    
    console.log(`📝 Prompt saved to: ${promptFile}`);
    console.log('\n--- BEGIN PROMPT ---');
    console.log(prompt);
    console.log('--- END PROMPT ---\n');
    
    // Run GitHub Copilot CLI in autonomous mode
    // We use the terminal agent which can execute commands and edit files
    try {
      // Method 1: Use gh copilot with chat mode (non-interactive)
      // We pipe the prompt directly to copilot and let it execute
      console.log('🔄 Invoking GitHub Copilot CLI...');
      
      const copilotCmd = `gh copilot explain "${prompt.substring(0, 500)}..." --execute`;
      const result = await this.execCommand(copilotCmd, { 
        timeout: CONFIG.COPILOT_TIMEOUT,
        cwd: CONFIG.PROJECT_ROOT 
      });
      
      console.log('📤 Copilot response:', result);
      
      // Alternative: Write a script that Copilot should execute
      const evolutionScript = join(CONFIG.PROJECT_ROOT, '.evolution-prompts', `${this.runId}.sh`);
      await writeFile(evolutionScript, `#!/bin/bash
# Auto-generated evolution script
# Goal: ${performanceData.weakestPattern} pattern improvement

cd ${CONFIG.PROJECT_ROOT}

# Let GitHub Copilot suggest improvements
gh copilot suggest "Improve the ${performanceData.weakestPattern} pattern in packages/engine/src/guilds/quant.py based on performance data: ${performanceData.weakestPnl.toFixed(2)} USD loss. Make the pattern more conservative."
`);
      
      await this.execCommand(`chmod +x ${evolutionScript}`);
      console.log(`📝 Evolution script created: ${evolutionScript}`);
      
      // Execute the script
      await this.execCommand(evolutionScript);
      
      console.log('\n✅ Copilot evolution completed');
      return true;
      
    } catch (error) {
      console.error('❌ Copilot execution failed:', error.message);
      console.error('Full error:', error);
      return false;
    }
  }

  constructPrompt(data) {
    const { weakestPattern, weakestPnl, totalPnl, patterns } = data;
    
    return `# Trading System Evolution Task

## Context
You are improving an autonomous crypto trading system. The system has underperformed in the last 24 hours.

## Performance Data
- **Total P&L**: $${totalPnl.toFixed(2)}
- **Weakest Pattern**: ${weakestPattern} (P&L: $${weakestPnl.toFixed(2)})

### Pattern Breakdown:
${patterns.map(p => `- **${p.pattern}**: ${p.trade_count} trades, $${parseFloat(p.total_pnl).toFixed(2)} P&L, ${((parseInt(p.wins) / parseInt(p.trade_count)) * 100).toFixed(1)}% win rate`).join('\n')}

## Your Task
Analyze and improve the trading logic to address the performance issues. Focus on:

1. **Risk Management**: Review \`packages/engine/src/core/risk_gate.py\` and \`risk_manager.py\`
   - Are stop-losses too tight or too loose?
   - Is position sizing appropriate?
   
2. **Pattern Logic**: Review \`packages/engine/src/guilds/quant.py\`
   - Is the ${weakestPattern} pattern detector too aggressive?
   - Should confidence thresholds be adjusted?
   - Are entry/exit conditions optimal?

3. **Signal Validation**: Review \`apps/web/src/app/api/auto-trade/route.ts\`
   - Is the GROK AI validation too lenient or strict?
   - Should we add additional filters?

## Constraints
- ⚠️  **SAFETY FIRST**: Do NOT remove risk checks (stop-loss, max position size, daily loss limits)
- 📐 **INCREMENTAL**: Make small, surgical changes. No massive refactors.
- ✅ **VERIFIABLE**: Changes must pass regression tests (verify_deep_value.py, verify_grid.py)
- 🔍 **TYPED**: Maintain strict typing (TypeScript/Python)

## Instructions
1. Analyze the performance data above
2. Identify the root cause of losses in the ${weakestPattern} pattern
3. Make 1-3 specific code changes to address the issue
4. Ensure all type checking and tests pass

Focus on improving the ${weakestPattern} pattern specifically, as it's causing the most losses.`;
  }

  async runVerification() {
    console.log('\n🧪 Running verification suite...');
    
    for (const command of CONFIG.VERIFICATION_COMMANDS) {
      console.log(`\n  Running: ${command}`);
      try {
        const result = await this.execCommand(command, { cwd: CONFIG.PROJECT_ROOT });
        console.log(`  ✅ PASSED: ${command}`);
      } catch (error) {
        console.error(`  ❌ FAILED: ${command}`);
        console.error(`  Error: ${error.message}`);
        return false;
      }
    }
    
    return true;
  }

  async commitChanges(message) {
    console.log('\n📝 Committing changes...');
    
    await this.execCommand('git add .');
    await this.execCommand(`git commit -m "${message}"`);
    
    console.log('✅ Changes committed');
  }

  async deployToProduction() {
    console.log('\n🚀 Deploying to production...');
    
    // Rebuild and restart containers
    const deployCommand = 'docker compose -f docker-compose.prod.yml up -d --build --no-deps engine web auto-trader';
    await this.execCommand(deployCommand, { cwd: CONFIG.PROJECT_ROOT });
    
    console.log('✅ Deployment complete');
    
    // Wait for services to be healthy
    await this.sleep(10000);
    
    // Health check
    const healthCheck = await this.checkSystemHealth();
    if (!healthCheck) {
      throw new Error('Health check failed after deployment');
    }
    
    console.log('✅ System health verified');
  }

  async checkSystemHealth() {
    try {
      const result = await this.execCommand('curl -s http://localhost:80/api/health');
      const health = JSON.parse(result);
      return health.healthy === true;
    } catch {
      return false;
    }
  }

  async logEvolutionResult(success, details) {
    const endTime = new Date();
    const duration = (endTime - this.startTime) / 1000;
    
    await this.redis.hset(`evolution:${this.runId}`, {
      ended_at: endTime.toISOString(),
      duration_seconds: duration,
      status: success ? 'SUCCESS' : 'FAILED',
      details: JSON.stringify(details)
    });
    
    // Store in Postgres for historical analysis
    await this.db.query(`
      INSERT INTO evolution_runs (
        run_id, started_at, ended_at, duration_seconds, 
        status, performance_data, changes_made
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      this.runId,
      this.startTime,
      endTime,
      duration,
      success ? 'SUCCESS' : 'FAILED',
      JSON.stringify(details.performance || {}),
      JSON.stringify(details.changes || [])
    ]).catch(() => {
      // Table might not exist yet, ignore
      console.log('⚠️  Could not log to evolution_runs table (might not exist yet)');
    });
  }

  async run() {
    let backupDir = null;
    let evolutionSuccess = false;
    let performanceData = null;
    
    try {
      await this.initialize();
      
      // Step 1: Analyze performance
      performanceData = await this.analyzePerformance();
      
      if (!performanceData) {
        console.log('\n✅ No evolution needed - insufficient data or good performance');
        await this.logEvolutionResult(true, { reason: 'skipped', performance: null });
        return;
      }
      
      if (!performanceData.needsEvolution) {
        console.log(`\n✅ Performance acceptable (P&L: $${performanceData.totalPnl.toFixed(2)}). Skipping evolution.`);
        await this.logEvolutionResult(true, { reason: 'performance_ok', performance: performanceData });
        return;
      }
      
      console.log(`\n⚡ Evolution triggered! Poor performance detected (P&L: $${performanceData.totalPnl.toFixed(2)})`);
      
      // Step 2: Create backup
      backupDir = await this.createBackup();
      
      // Step 3: Run Copilot evolution
      let attempt = 0;
      let mutationApplied = false;
      
      while (attempt < CONFIG.MAX_EVOLUTION_ATTEMPTS && !mutationApplied) {
        attempt++;
        console.log(`\n🔄 Evolution attempt ${attempt}/${CONFIG.MAX_EVOLUTION_ATTEMPTS}`);
        
        mutationApplied = await this.runCopilotEvolution(performanceData);
        
        if (!mutationApplied) {
          console.log('⚠️  Mutation failed, retrying...');
          await this.sleep(5000);
          continue;
        }
        
        // Step 4: Verify changes
        console.log('\n🧪 Verifying mutation...');
        const verificationPassed = await this.runVerification();
        
        if (!verificationPassed) {
          console.log('❌ Verification failed! Rolling back...');
          await this.restoreBackup(backupDir);
          await this.execCommand('git reset --hard HEAD');
          mutationApplied = false;
          continue;
        }
        
        // Step 5: Commit and deploy
        const commitMsg = `[Auto-Evolution ${this.runId}] Improve ${performanceData.weakestPattern} pattern (P&L: $${performanceData.weakestPnl.toFixed(2)})`;
        await this.commitChanges(commitMsg);
        
        // Step 6: Deploy to production
        await this.deployToProduction();
        
        evolutionSuccess = true;
        console.log('\n🎉 Evolution successful! System improved and deployed.');
        break;
      }
      
      if (!mutationApplied) {
        console.log(`\n❌ Evolution failed after ${CONFIG.MAX_EVOLUTION_ATTEMPTS} attempts`);
        await this.logEvolutionResult(false, { 
          reason: 'max_attempts_reached', 
          performance: performanceData,
          attempts: attempt
        });
        return;
      }
      
      await this.logEvolutionResult(true, {
        reason: 'evolution_completed',
        performance: performanceData,
        attempts: attempt,
        changes: 'Applied mutation and verified'
      });
      
    } catch (error) {
      console.error('\n💥 Evolution engine crashed:', error);
      
      // Restore backup if available
      if (backupDir) {
        console.log('🔄 Restoring backup due to crash...');
        try {
          await this.restoreBackup(backupDir);
          await this.execCommand('git reset --hard HEAD');
        } catch (restoreError) {
          console.error('💥 Failed to restore backup:', restoreError);
        }
      }
      
      await this.logEvolutionResult(false, {
        reason: 'crash',
        error: error.message,
        performance: performanceData
      });
      
      throw error;
    } finally {
      // Cleanup
      if (this.db) await this.db.end();
      if (this.redis) await this.redis.quit();
    }
  }

  // Helper methods
  execCommand(command, options = {}) {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, {
        shell: true,
        cwd: options.cwd || CONFIG.PROJECT_ROOT,
        timeout: options.timeout || 60000
      });
      
      let stdout = '';
      let stderr = '';
      
      proc.stdout.on('data', (data) => { stdout += data; });
      proc.stderr.on('data', (data) => { stderr += data; });
      
      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Command failed with code ${code}: ${stderr}`));
        }
      });
      
      proc.on('error', reject);
    });
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Run evolution engine
const engine = new EvolutionEngine();
engine.run().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
