#!/usr/bin/env npx tsx
/**
 * Polynix Leaderboard Probe — find Polymarket trader tracking APIs.
 */

const DATA_API = 'https://data-api.polymarket.com';
const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';

async function probe(url: string): Promise<void> {
    try {
        const res = await fetch(url, {
            signal: AbortSignal.timeout(8_000),
            headers: { 'Accept': 'application/json' },
        });
        const body = await res.text();
        console.log(`${res.status} ${url}`);
        if (res.status < 400) {
            console.log(`  ${body.slice(0, 300)}\n`);
        }
    } catch (e: any) {
        console.log(`ERR ${url}: ${e.message}`);
    }
}

async function main() {
    console.log('=== Polynix Leaderboard Probe ===\n');

    const endpoints = [
        // Data API
        `${DATA_API}/leaderboard`,
        `${DATA_API}/leaderboard?limit=5`,
        `${DATA_API}/rankings`,
        `${DATA_API}/top-traders`,
        `${DATA_API}/users`,
        `${DATA_API}/activity`,
        `${DATA_API}/positions`,
        `${DATA_API}/trades`,
        // Gamma API
        `${GAMMA_API}/leaderboard`,
        `${GAMMA_API}/profiles`,
        `${GAMMA_API}/users`,
        // CLOB API
        `${CLOB_API}/leaderboard`,
        `${CLOB_API}/traders`,
        // Polymarket website API (reverse-engineered)
        'https://polymarket.com/api/leaderboard',
        'https://polymarket.com/api/rankings',
        // Known Polymarket profile patterns
        'https://polymarket.com/api/profile/leaderboard',
    ];

    for (const url of endpoints) {
        await probe(url);
        await new Promise(r => setTimeout(r, 300));
    }

    console.log('\n=== Probe complete ===');
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
