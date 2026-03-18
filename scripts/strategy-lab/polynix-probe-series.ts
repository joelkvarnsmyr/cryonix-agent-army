#!/usr/bin/env npx tsx
/**
 * Polynix Series Probe — discover 5-min crypto markets on Polymarket.
 *
 * Competitor screenshots show slugs like:
 *   eth-updown-5m-1773776288
 *   btc-multistrike-4h-1758873600
 *
 * This script probes the Gamma API to find what series patterns exist.
 */

const GAMMA = 'https://gamma-api.polymarket.com';

async function fetchJson(url: string): Promise<any> {
    const res = await fetch(url, {
        signal: AbortSignal.timeout(8_000),
        headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) return null;
    return res.json();
}

async function main() {
    console.log('=== Polynix Series Probe ===\n');

    // 1. Slug-based series discovery
    const slugPatterns = [
        // 5-min patterns (from competitor screenshots)
        'btc-updown-5m', 'eth-updown-5m', 'sol-updown-5m',
        'bitcoin-updown-5m', 'bitcoin-up-down-5m',
        'btc-5min', 'btc-5m', 'bitcoin-5-minute',
        'bitcoin-up-or-down', 'btc-up-or-down',
        'crypto-5-minute', 'crypto-5min',
        // 4h patterns (seen in backtest data)
        'btc-multistrike-4h', 'bitcoin-multi-strikes-4h',
        'eth-multistrike-4h', 'ethereum-multi-strikes-4h',
        // 1h patterns
        'btc-multistrike-1h', 'bitcoin-multi-strikes-1h',
        // Daily patterns
        'bitcoin-above-on', 'bitcoin-price',
        'btc-daily', 'bitcoin-daily',
    ];

    console.log('--- Slug-based event search ---');
    for (const slug of slugPatterns) {
        const data = await fetchJson(`${GAMMA}/events?slug=${slug}&closed=false&limit=3`);
        if (Array.isArray(data) && data.length > 0) {
            console.log(`\n  FOUND: "${slug}" → ${data.length} event(s)`);
            for (const e of data.slice(0, 3)) {
                const mkts = e.markets?.length ?? 0;
                console.log(`    ${e.slug} | ${e.title?.slice(0, 70)} | ${mkts} markets`);
            }
        }
        await new Promise(r => setTimeout(r, 200));
    }

    // 2. Series endpoint (some APIs support this)
    console.log('\n--- Series endpoint search ---');
    const seriesSlugs = [
        'bitcoin-up-or-down-5-min', 'bitcoin-multi-strikes-5m',
        'bitcoin-multi-strikes-4h', 'crypto-5-minute',
        'btc-5min-up-down', 'bitcoin-updown',
    ];
    for (const s of seriesSlugs) {
        // Try both events?series= and direct /series/ endpoint
        for (const url of [
            `${GAMMA}/events?series=${s}&closed=false&limit=3`,
            `${GAMMA}/series/${s}`,
        ]) {
            const data = await fetchJson(url);
            if (data && ((Array.isArray(data) && data.length > 0) || data.id)) {
                console.log(`  FOUND: ${url}`);
                console.log(`    ${JSON.stringify(data).slice(0, 200)}`);
            }
        }
        await new Promise(r => setTimeout(r, 200));
    }

    // 3. Broad market scan — find ANY market expiring within 1 hour
    console.log('\n--- Markets expiring within 1 hour ---');
    const now = Date.now();
    const allMarkets = await fetchJson(`${GAMMA}/markets?closed=false&active=true&limit=200&order=volume24hr&ascending=false`);
    if (Array.isArray(allMarkets)) {
        let shortCount = 0;
        for (const m of allMarkets) {
            if (!m.endDate) continue;
            const expiresAt = new Date(m.endDate).getTime();
            const ttl = (expiresAt - now) / 1000;
            if (ttl > 0 && ttl < 3600) {
                shortCount++;
                const mins = Math.floor(ttl / 60);
                console.log(`  ${mins}m left | vol=$${parseFloat(m.volume24hr || 0).toFixed(0)} | ${(m.question || '').slice(0, 70)}`);
            }
        }
        console.log(`\n  Total short-lived markets (<1h): ${shortCount} out of ${allMarkets.length} scanned`);
    }

    // 4. Keyword search in active markets
    console.log('\n--- Keyword matches in active markets ---');
    if (Array.isArray(allMarkets)) {
        const keywords = ['5 minutes', '5 min', 'up or down', 'updown', '10 minutes', '15 minutes', '1 hour', 'next hour'];
        for (const kw of keywords) {
            const matches = allMarkets.filter((m: any) =>
                (m.question || '').toLowerCase().includes(kw)
            );
            if (matches.length > 0) {
                console.log(`  "${kw}": ${matches.length} match(es)`);
                for (const m of matches.slice(0, 3)) {
                    console.log(`    ${(m.question || '').slice(0, 80)}`);
                }
            }
        }
    }

    // 5. Check specific series that appear in competitor slugs
    console.log('\n--- Competitor slug reconstruction ---');
    // From screenshot: eth-updown-5m-1773776288 — the timestamp is Unix seconds
    // Generate current + next few 5-min windows
    const nowSec = Math.floor(now / 1000);
    const roundTo5m = Math.ceil(nowSec / 300) * 300;
    for (let offset = 0; offset <= 3; offset++) {
        const ts = roundTo5m + (offset * 300);
        for (const asset of ['btc', 'eth', 'sol']) {
            const slug = `${asset}-updown-5m-${ts}`;
            const data = await fetchJson(`${GAMMA}/events?slug=${slug}&limit=1`);
            if (Array.isArray(data) && data.length > 0) {
                console.log(`  FOUND: ${slug} → ${data[0].title}`);
            }
        }
        await new Promise(r => setTimeout(r, 300));
    }

    console.log('\n=== Probe complete ===');
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
