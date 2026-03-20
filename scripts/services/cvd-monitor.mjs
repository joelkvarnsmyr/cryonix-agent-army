/**
 * CVD Monitor — Cumulative Volume Delta via Binance WebSocket.
 *
 * Tracks buy vs sell volume in real-time for BTC, ETH, SOL.
 * Detects divergences: price down + CVD up = hidden buying (dip-buy signal).
 *
 * Writes to Redis: cvd:{SYMBOL} every 15 seconds.
 */

import WebSocket from 'ws';
import Redis from 'ioredis';

const KV_URL = process.env.KV_URL || 'redis://redis:6379';
const redis = new Redis(KV_URL);

const SYMBOLS = ['btcusdt', 'ethusdt', 'solusdt'];
const SYMBOL_MAP = {
    btcusdt: 'BTC', ethusdt: 'ETH', solusdt: 'SOL',
};

const WINDOW_5M = 5 * 60 * 1000;
const WINDOW_15M = 15 * 60 * 1000;
const WRITE_INTERVAL = 15_000;

// In-memory trade buffers
const tradeBuffers = new Map();
for (const sym of SYMBOLS) {
    tradeBuffers.set(sym, []);
}

function connectWebSocket() {
    const streams = SYMBOLS.map(s => `${s}@aggTrade`).join('/');
    const url = `wss://stream.binance.com:9443/stream?streams=${streams}`;

    const ws = new WebSocket(url);

    ws.on('open', () => {
        console.log(`[CVD] Connected to Binance aggTrade stream (${SYMBOLS.length} symbols)`);
    });

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            const trade = msg.data;
            if (!trade || !trade.s) return;

            const symbol = trade.s.toLowerCase();
            const buffer = tradeBuffers.get(symbol);
            if (!buffer) return;

            buffer.push({
                price: parseFloat(trade.p),
                qty: parseFloat(trade.q),
                isBuyerMaker: trade.m,
                timestamp: trade.T || Date.now(),
            });
        } catch { /* ignore */ }
    });

    ws.on('close', () => {
        console.log('[CVD] WebSocket closed. Reconnecting in 5s...');
        setTimeout(connectWebSocket, 5000);
    });

    ws.on('error', (err) => {
        console.error('[CVD] WebSocket error:', err.message);
        ws.close();
    });
}

function computeCVD(trades, windowMs) {
    const cutoff = Date.now() - windowMs;
    const recent = trades.filter(t => t.timestamp >= cutoff);

    if (recent.length < 10) {
        return { cvd: 0, buyVolume: 0, sellVolume: 0, priceChange: 0, tradeCount: 0 };
    }

    let buyVolume = 0;
    let sellVolume = 0;

    for (const t of recent) {
        if (t.isBuyerMaker) {
            sellVolume += t.qty * t.price;
        } else {
            buyVolume += t.qty * t.price;
        }
    }

    const cvd = buyVolume - sellVolume;
    const oldPrice = recent[0].price;
    const newPrice = recent[recent.length - 1].price;
    const priceChange = oldPrice > 0 ? ((newPrice - oldPrice) / oldPrice) * 100 : 0;

    return { cvd, buyVolume, sellVolume, priceChange, tradeCount: recent.length };
}

function detectDivergence(priceChange, cvd) {
    if (priceChange < -0.1 && cvd > 0) return 'bullish';
    if (priceChange > 0.1 && cvd < 0) return 'bearish';
    return 'none';
}

async function writeToRedis() {
    const now = Date.now();

    for (const [symbol, trades] of tradeBuffers) {
        const asset = SYMBOL_MAP[symbol];
        if (!asset) continue;

        const cvd5m = computeCVD(trades, WINDOW_5M);
        const cvd15m = computeCVD(trades, WINDOW_15M);

        const divergence5m = detectDivergence(cvd5m.priceChange, cvd5m.cvd);
        const divergence15m = detectDivergence(cvd15m.priceChange, cvd15m.cvd);

        const data = {
            cvd_5m: Math.round(cvd5m.cvd),
            cvd_15m: Math.round(cvd15m.cvd),
            buy_volume_5m: Math.round(cvd5m.buyVolume),
            sell_volume_5m: Math.round(cvd5m.sellVolume),
            price_change_5m: Math.round(cvd5m.priceChange * 100) / 100,
            price_change_15m: Math.round(cvd15m.priceChange * 100) / 100,
            divergence_5m: divergence5m,
            divergence_15m: divergence15m,
            trade_count_5m: cvd5m.tradeCount,
            timestamp: now,
        };

        try {
            await redis.set(`cvd:${asset}`, JSON.stringify(data), 'EX', 120);
        } catch { /* non-critical */ }

        if (divergence5m !== 'none') {
            console.log(`[CVD] ${asset} 5m DIVERGENCE: ${divergence5m} | price=${cvd5m.priceChange.toFixed(2)}% cvd=$${Math.round(cvd5m.cvd).toLocaleString()} | ${cvd5m.tradeCount} trades`);
        }

        // Evict old trades
        const evictCutoff = now - 20 * 60 * 1000;
        tradeBuffers.set(symbol, trades.filter(t => t.timestamp >= evictCutoff));
    }
}

// Heartbeat
setInterval(() => {
    const counts = SYMBOLS.map(s => `${SYMBOL_MAP[s]}:${tradeBuffers.get(s)?.length ?? 0}`).join(' ');
    console.log(`[CVD] Heartbeat: ${counts} trades buffered`);
}, 60_000);

// Main
console.log('='.repeat(50));
console.log('  CVD Monitor — Cumulative Volume Delta');
console.log(`  Symbols: ${SYMBOLS.map(s => SYMBOL_MAP[s]).join(', ')}`);
console.log(`  Write interval: ${WRITE_INTERVAL / 1000}s`);
console.log('='.repeat(50));

connectWebSocket();
setInterval(writeToRedis, WRITE_INTERVAL);
