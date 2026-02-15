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
import OpenAI from 'openai';
import { TelegramBot } from './telegram-bot.mjs';
import 'dotenv/config'; // Load .env file

const { Client } = pg;

// Configuration
const CONFIG = {
  DB_URL_CANDIDATES: [
    process.env.POSTGRES_URL,
    `postgresql://postgres:${process.env.POSTGRES_PASSWORD || 'password'}@localhost:5432/cryonix`,
    'postgresql://postgres:password@localhost:5432/cryonix',
    'postgresql://postgres:password@postgres:5432/cryonix'
  ].filter((value, index, all) => value && all.indexOf(value) === index),
  REDIS_URL: process.env.KV_URL || 'redis://localhost:6379',
  LOOKBACK_HOURS: 24,
  MIN_TRADES_FOR_ANALYSIS: 3,
  PERFORMANCE_THRESHOLD: -2.0, // Trigger evolution if daily PnL < -2%
  MAX_EVOLUTION_ATTEMPTS: 3,
  COPILOT_TIMEOUT: 600000, // 10 minutes
  PROJECT_ROOT: '/home/azureuser/cryonix',

  // Test suite to run after mutation
  VERIFICATION_COMMANDS: [
    'python3 scripts/verify_deep_value.py',
    'python3 scripts/verify_grid.py',
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
    this.telegram = new TelegramBot();
    this.runId = `evo_${Date.now()}`;
    this.startTime = new Date();
  }

  async initialize() {
    console.log(`[${this.runId}] 🚀 Initializing Evolution Engine...`);

    // Connect to Postgres
    this.db = await this.connectPostgres();
    console.log('✅ Connected to Postgres');
    await this.ensureEvolutionRunsTable();

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
        COALESCE(SUM(pnl), 0) as total_pnl,
        COALESCE(AVG(pnl), 0) as avg_roi,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losses,
        COALESCE(MAX(pnl), 0) as best_trade,
        COALESCE(MIN(pnl), 0) as worst_trade
      FROM trades
      WHERE status = 'CLOSED'
        AND timestamp > NOW() - INTERVAL '${CONFIG.LOOKBACK_HOURS} hours'
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

  /**
   * Phase 1: GROK analyzes performance data + source code and generates
   *          a precise instruction for Copilot CLI.
   * Phase 2: Copilot CLI executes the instruction (edits files).
   */
  async runCopilotEvolution(performanceData) {
    console.log('\n🤖 Running GROK → Copilot CLI evolution...');

    try {
      // Phase 1: GROK generates the evolution plan
      console.log('\n🧠 Phase 1: GROK analyzing performance + source code...');
      const copilotInstruction = await this.askGrokForPlan(performanceData);

      if (!copilotInstruction) {
        console.error('❌ GROK failed to generate an evolution plan');
        return false;
      }

      // Save the instruction for audit
      const promptDir = join(CONFIG.PROJECT_ROOT, '.evolution-prompts');
      await this.execCommand(`mkdir -p ${promptDir}`);
      await writeFile(join(promptDir, `${this.runId}-grok-plan.md`), copilotInstruction);
      console.log('📝 GROK plan saved for audit');

      // Phase 2: Copilot CLI executes the code changes
      console.log('\n🔧 Phase 2: Copilot CLI executing code changes...');
      const model = process.env.EVOLUTION_MODEL_MUTATION || 'claude-sonnet-4.5';
      await this.telegram.sendCopilotPhase(true, model);

      const result = await this.execCommand(
        `gh copilot -- -p ${this.shellEscape(copilotInstruction)} --allow-all --model ${model} -s`,
        { timeout: CONFIG.COPILOT_TIMEOUT, cwd: CONFIG.PROJECT_ROOT }
      );

      // Save Copilot's output
      await writeFile(join(promptDir, `${this.runId}-copilot-output.txt`), result);
      console.log('📤 Copilot output saved');
      console.log('\n✅ Copilot evolution completed');
      return true;

    } catch (error) {
      console.error('❌ Evolution failed:', error.message);
      await this.telegram.sendCopilotPhase(false, process.env.EVOLUTION_MODEL_MUTATION || 'claude-sonnet-4.5');
      return false;
    }
  }

  /**
   * Uses GROK (xAI) to analyze performance data and source code,
   * then generates a precise, actionable instruction for Copilot CLI.
   */
  async askGrokForPlan(performanceData) {
    const grok = new OpenAI({
      apiKey: process.env.XAI_API_KEY,
      baseURL: 'https://api.x.ai/v1',
    });

    // Read actual source code from critical files
    const sourceCode = {};
    for (const file of CONFIG.CRITICAL_FILES) {
      try {
        sourceCode[file] = await readFile(join(CONFIG.PROJECT_ROOT, file), 'utf-8');
      } catch {
        sourceCode[file] = '(file not found)';
      }
    }

    // Load prompt template
    let promptTemplate = '';
    try {
      promptTemplate = await readFile(join(CONFIG.PROJECT_ROOT, 'scripts/prompts/evolution_prompt.txt'), 'utf-8');
    } catch {
      console.warn('⚠️  Could not load prompt template, using inline prompt');
    }

    const { weakestPattern, weakestPnl, totalPnl, totalTrades, patterns } = performanceData;

    const patternBreakdown = patterns.map(p =>
      `- ${p.pattern}: ${p.trade_count} trades, $${parseFloat(p.total_pnl).toFixed(2)} P&L, ` +
      `${((parseInt(p.wins) / parseInt(p.trade_count)) * 100).toFixed(1)}% win rate`
    ).join('\n');

    const systemPrompt = `You are a Senior Quantitative Developer orchestrating an autonomous trading system evolution.

Your job: analyze the performance data and source code below, then produce a SINGLE, precise instruction
that GitHub Copilot CLI will execute to improve the code.

RULES FOR YOUR OUTPUT:
1. Output ONLY the instruction text that Copilot CLI will receive — no preamble, no markdown wrapping.
2. The instruction must tell Copilot exactly which files to edit and what changes to make.
3. Be surgical: 1-3 small parameter tweaks or condition changes. No rewrites.
4. NEVER remove risk checks (stop-loss, max position size, daily loss limits).
5. Changes must pass: python scripts/verify_deep_value.py && python scripts/verify_grid.py
6. After editing, tell Copilot to run the verification tests.`;

    const userPrompt = `## Performance Data (last ${CONFIG.LOOKBACK_HOURS}h)
Total P&L: $${totalPnl.toFixed(2)} | Total Trades: ${totalTrades}
Weakest Pattern: ${weakestPattern} (P&L: $${weakestPnl.toFixed(2)})

${patternBreakdown}

## Source Code

### packages/engine/src/guilds/quant.py
\`\`\`python
${sourceCode['packages/engine/src/guilds/quant.py']}
\`\`\`

### packages/engine/src/core/risk_gate.py
\`\`\`python
${sourceCode['packages/engine/src/core/risk_gate.py']}
\`\`\`

### packages/engine/src/core/risk_manager.py
\`\`\`python
${sourceCode['packages/engine/src/core/risk_manager.py']}
\`\`\`

### apps/web/src/app/api/auto-trade/route.ts
\`\`\`typescript
${sourceCode['apps/web/src/app/api/auto-trade/route.ts']}
\`\`\`

${promptTemplate ? `## Additional Guidelines\n${promptTemplate}` : ''}

Now generate the Copilot CLI instruction to fix the ${weakestPattern} pattern.`;

    console.log(`   Sending ${userPrompt.length} chars to GROK...`);

    const response = await grok.chat.completions.create({
      model: 'grok-4-1-fast-reasoning',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 4000,
    });

    const instruction = response.choices[0]?.message?.content?.trim();
    const usage = response.usage;
    console.log(`   GROK tokens: ${usage?.prompt_tokens || '?'} in / ${usage?.completion_tokens || '?'} out`);
    await this.telegram.sendGrokPhase(instruction?.length || 0, usage?.prompt_tokens || 0, usage?.completion_tokens || 0);

    if (!instruction || instruction.length < 50) {
      console.error('❌ GROK returned insufficient instruction');
      return null;
    }

    console.log(`   ✅ GROK generated instruction (${instruction.length} chars)`);
    return instruction;
  }

  /** Escape a string for safe use as a single shell argument */
  shellEscape(str) {
    return "'" + str.replace(/'/g, "'\\''") + "'";
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

    let pushed = false;
    try {
      await this.execCommand('git push');
      pushed = true;
    } catch (error) {
      console.warn('⚠️  Git push failed:', error.message);
    }

    console.log(`✅ Changes committed${pushed ? ' and pushed' : ''}`);
    await this.telegram.sendGitReport(message, pushed);
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

    if (this.redis) {
      await this.redis.hset(`evolution:${this.runId}`, {
        ended_at: endTime.toISOString(),
        duration_seconds: duration,
        status: success ? 'SUCCESS' : 'FAILED',
        details: JSON.stringify(details)
      });
    }

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
      Math.round(duration),
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
      await this.telegram.sendEvolutionStart(this.runId);

      // Step 1: Analyze performance
      performanceData = await this.analyzePerformance();
      await this.telegram.sendPerformanceReport(performanceData);

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
        await this.telegram.sendVerificationResult(verificationPassed);

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

      const duration = (new Date() - this.startTime) / 1000;

      if (!mutationApplied) {
        console.log(`\n❌ Evolution failed after ${CONFIG.MAX_EVOLUTION_ATTEMPTS} attempts`);
        await this.logEvolutionResult(false, {
          reason: 'max_attempts_reached',
          performance: performanceData,
          attempts: attempt
        });
        await this.telegram.sendEvolutionResult(false, { runId: this.runId, duration, reason: 'max_attempts_reached', attempts: attempt });
        return;
      }

      await this.logEvolutionResult(true, {
        reason: 'evolution_completed',
        performance: performanceData,
        attempts: attempt,
        changes: 'Applied mutation and verified'
      });
      await this.telegram.sendEvolutionResult(true, { runId: this.runId, duration, reason: 'evolution_completed', attempts: attempt });

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
      await this.telegram.sendEvolutionResult(false, {
        runId: this.runId,
        duration: (new Date() - this.startTime) / 1000,
        reason: `crash: ${error.message}`,
        attempts: '?'
      });

      throw error;
    } finally {
      // Cleanup
      if (this.db) await this.db.end();
      if (this.redis) await this.redis.quit();
    }
  }

  // Helper methods
  async connectPostgres() {
    let lastError = null;

    for (const connectionString of CONFIG.DB_URL_CANDIDATES) {
      const client = new Client({ connectionString });
      try {
        await client.connect();
        return client;
      } catch (error) {
        lastError = error;
        await client.end().catch(() => undefined);
      }
    }

    throw lastError || new Error('Failed to connect to Postgres');
  }

  async ensureEvolutionRunsTable() {
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS evolution_runs (
        id SERIAL PRIMARY KEY,
        run_id VARCHAR(64) UNIQUE NOT NULL,
        started_at TIMESTAMP WITH TIME ZONE NOT NULL,
        ended_at TIMESTAMP WITH TIME ZONE,
        duration_seconds INTEGER,
        status VARCHAR(20) NOT NULL,
        performance_data JSONB,
        changes_made JSONB,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

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
