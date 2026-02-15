/**
 * Cryonix Auto-Trader Background Process
 * Polls the auto-trade API endpoint every 30 seconds to process pending signals.
 * Run: npx ts-node scripts/auto-trader.ts
 */

const API_BASE = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
const POLL_INTERVAL = 30_000; // 30 seconds
const HEALTH_CHECK_INTERVAL = 300_000; // 5 minutes

let isRunning = true;
let cycleCount = 0;
let totalExecuted = 0;
let totalSkipped = 0;
let lastError: string | null = null;

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

    if (data.executed > 0) {
      totalExecuted += data.executed;
      console.log(`[CYCLE ${cycleCount}] EXECUTED ${data.executed} trades!`, data.results?.filter((r: any) => r.status === 'EXECUTED'));
    }

    if (data.rejected > 0) {
      console.log(`[CYCLE ${cycleCount}] Rejected ${data.rejected} (non-qualifying)`);
    }

    if (data.processed > 0 && data.executed === 0) {
      totalSkipped += data.skipped || 0;
      // Only log every 10th cycle to reduce noise
      if (cycleCount % 10 === 0) {
        console.log(`[CYCLE ${cycleCount}] ${data.processed} pending, 0 qualifying. Queue: ${data.processed} | Daily trades: ${data.dailyState?.tradesExecuted || 0}`);
      }
    }

    lastError = null;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (lastError !== msg) {
      console.error(`[CYCLE ${cycleCount}] Error: ${msg}`);
      lastError = msg;
    }
  }
}

async function healthCheck() {
  try {
    const res = await fetch(`${API_BASE}/api/auto-trade`);
    const data = await res.json();
    console.log(`[HEALTH] Status: ${data.status} | Testnet: ${data.isTestnet} | Pending: ${data.queues?.pending} | Daily trades: ${data.dailyState?.tradesExecuted} | Total executed: ${totalExecuted}`);
  } catch (error) {
    console.error(`[HEALTH] API unreachable`);
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('  CRYONIX AUTO-TRADER');
  console.log(`  API: ${API_BASE}`);
  console.log(`  Poll interval: ${POLL_INTERVAL / 1000}s`);
  console.log(`  Started: ${new Date().toISOString()}`);
  console.log('='.repeat(60));

  // Initial health check
  await healthCheck();

  // Main loop
  const pollTimer = setInterval(() => {
    if (isRunning) processSignals();
  }, POLL_INTERVAL);

  // Periodic health check
  const healthTimer = setInterval(healthCheck, HEALTH_CHECK_INTERVAL);

  // Run first cycle immediately
  await processSignals();

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down auto-trader...');
    console.log(`Total cycles: ${cycleCount}, Executed: ${totalExecuted}, Skipped: ${totalSkipped}`);
    isRunning = false;
    clearInterval(pollTimer);
    clearInterval(healthTimer);
    process.exit(0);
  });
}

main();
