import Redis from 'ioredis';

const API_BASE = process.env.NEXT_PUBLIC_APP_URL || 'http://web:3000';
const KV_URL = process.env.KV_URL || 'redis://redis:6379';

const subscriber = new Redis(KV_URL);
let processing = false;
let cycleCount = 0;

subscriber.subscribe('signals:new', (err) => {
    if (err) { console.error('[SIGNAL-WORKER] Subscribe failed:', err); process.exit(1); }
    console.log('[SIGNAL-WORKER] Subscribed to signals:new');
});

subscriber.on('message', async (channel, message) => {
    if (processing) return;
    processing = true;
    cycleCount++;

    try {
        const signal = JSON.parse(message);
        console.log(`[SIGNAL-WORKER] #${cycleCount} Signal: ${signal.symbol} ${signal.action} ${(signal.confidence * 100).toFixed(0)}%`);

        const res = await fetch(`${API_BASE}/api/auto-trade`, { method: 'POST' });
        const data = await res.json();

        if (data.buys > 0) console.log(`[SIGNAL-WORKER] BOUGHT ${data.buys}!`, data.buyResults?.filter(r => r.status === 'EXECUTED'));
        if (data.rejected > 0) {
            const reasons = (data.buyResults || [])
                .filter(r => r.status !== 'EXECUTED')
                .map(r => `${r.symbol}: ${r.reason || r.error || '?'}`.slice(0, 60))
                .join(' | ');
            console.log(`[SIGNAL-WORKER] Rejected ${data.rejected}: ${reasons}`);
        }
        if (data.sells > 0) console.log(`[SIGNAL-WORKER] SOLD ${data.sells}`);
    } catch (err) {
        console.error('[SIGNAL-WORKER] Error:', err.message || err);
    } finally {
        processing = false;
    }
});

// Fallback: poll every 60s for missed signals
setInterval(async () => {
    if (processing) return;
    processing = true;
    try {
        const res = await fetch(`${API_BASE}/api/auto-trade`, { method: 'POST' });
        const data = await res.json();
        if (data.buys > 0) console.log(`[SIGNAL-WORKER] Fallback: BOUGHT ${data.buys}`);
    } catch {} finally { processing = false; }
}, 60_000);

// Health heartbeat
setInterval(async () => {
    try {
        const res = await fetch(`${API_BASE}/api/auto-trade`);
        const data = await res.json();
        const posCount = data.positions?.length || 0;
        const totalPnl = data.positions?.reduce((s, p) => s + (p.pnl || 0), 0) || 0;
        console.log(`[SIGNAL-WORKER] Health: ${posCount} pos | PnL $${totalPnl.toFixed(4)} | Pending: ${data.queues?.pending || 0} | Signals processed: ${cycleCount}`);
    } catch { console.error('[SIGNAL-WORKER] Health check failed'); }
}, 300_000);

console.log('='.repeat(50));
console.log('  CRYONIX SIGNAL WORKER (Push-based)');
console.log(`  API: ${API_BASE}`);
console.log(`  Redis: ${KV_URL}`);
console.log('='.repeat(50));
