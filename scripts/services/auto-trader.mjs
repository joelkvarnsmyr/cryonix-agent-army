/**
 * Cryonix Auto-Trader (Production Docker version)
 * Plain ESM - no TypeScript dependency needed.
 * Polls the auto-trade API every 30s to process pending signals + monitor positions.
 */

import { getToml } from '../lib/load-toml.mjs';

const API_BASE = process.env.NEXT_PUBLIC_APP_URL || 'http://web:3000';
const POLL_INTERVAL = getToml('timing', 'auto_trader_poll_ms', 30_000);
const HEALTH_CHECK_INTERVAL = getToml('timing', 'health_check_interval_ms', 300_000);

let isRunning = true;
let cycleCount = 0;
let totalExecuted = 0;

async function processSignals() {
  try {
    const res = await fetch(`${API_BASE}/api/auto-trade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    cycleCount++;

    // Log sells (exits)
    if (data.sells > 0) {
      const exits = data.monitor?.filter(r => r.action !== 'HOLD' && r.action !== 'ERROR') || [];
      console.log(`[CYCLE ${cycleCount}] SOLD ${data.sells} positions!`, exits);
    }

    // Log buys
    if (data.buys > 0) {
      totalExecuted += data.buys;
      console.log(`[CYCLE ${cycleCount}] BOUGHT ${data.buys} trades!`, data.buyResults?.filter(r => r.status === 'EXECUTED'));
    }

    // Log rejections
    if (data.rejected > 0) {
      console.log(`[CYCLE ${cycleCount}] Rejected ${data.rejected} (non-qualifying)`);
    }

    // Position P&L summary every 10th cycle
    if (cycleCount % 10 === 0) {
      const holds = data.monitor?.filter(r => r.action === 'HOLD') || [];
      if (holds.length > 0) {
        const summary = holds.map(h => `${h.symbol}: ${h.pnlPct >= 0 ? '+' : ''}${h.pnlPct?.toFixed(2)}%`).join(' | ');
        console.log(`[CYCLE ${cycleCount}] Positions: ${summary}`);
      }
    }
  } catch (error) {
    console.error(`[CYCLE ${cycleCount}] Error: ${error.message || error}`);
  }
}

async function healthCheck() {
  try {
    const res = await fetch(`${API_BASE}/api/auto-trade`);
    const data = await res.json();
    const posCount = data.positions?.length || 0;
    const totalPnl = data.positions?.reduce((s, p) => s + (p.pnl || 0), 0) || 0;
    console.log(`[HEALTH] Status: ${data.status} | Positions: ${posCount} (PnL: $${totalPnl.toFixed(4)}) | Pending: ${data.queues?.pending} | Daily trades: ${data.dailyState?.tradesExecuted} | Total executed: ${totalExecuted}`);
  } catch {
    console.error(`[HEALTH] API unreachable`);
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('  CRYONIX AUTO-TRADER (Docker)');
  console.log(`  API: ${API_BASE}`);
  console.log(`  Poll interval: ${POLL_INTERVAL / 1000}s`);
  console.log(`  Started: ${new Date().toISOString()}`);
  console.log('='.repeat(60));

  // Wait for web service to be ready
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${API_BASE}/api/auto-trade`);
      if (res.ok) { ready = true; break; }
    } catch { /* retry */ }
    console.log(`[STARTUP] Waiting for web service... (${i + 1}/30)`);
    await new Promise(r => setTimeout(r, 2000));
  }

  if (!ready) {
    console.error('[STARTUP] Web service not available after 60s. Exiting.');
    process.exit(1);
  }

  await healthCheck();
  await processSignals();

  const pollTimer = setInterval(() => {
    if (isRunning) processSignals();
  }, POLL_INTERVAL);

  const healthTimer = setInterval(healthCheck, HEALTH_CHECK_INTERVAL);

  process.on('SIGINT', () => {
    console.log('\nShutting down auto-trader...');
    console.log(`Total cycles: ${cycleCount}, Executed: ${totalExecuted}`);
    isRunning = false;
    clearInterval(pollTimer);
    clearInterval(healthTimer);
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    isRunning = false;
    clearInterval(pollTimer);
    clearInterval(healthTimer);
    process.exit(0);
  });
}

main();
