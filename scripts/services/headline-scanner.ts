import OpenAI from 'openai';
import Redis from 'ioredis';

const SCAN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const HEADLINE_TTL = 1800; // 30 minutes — headlines are stale fast

const redis = new Redis(process.env.KV_URL || 'redis://localhost:6379');
const grok = new OpenAI({
    apiKey: process.env.XAI_API_KEY,
    baseURL: 'https://api.x.ai/v1',
});

async function scanHeadlines(): Promise<void> {
    try {
        const response = await grok.chat.completions.create({
            model: 'grok-3-mini',
            messages: [{
                role: 'user',
                content: `You have access to real-time X/Twitter data.

Scan X/Twitter RIGHT NOW for any market-moving events in the last 10 minutes.
Focus on: geopolitical news, Fed/central bank statements, crypto-specific events,
major earnings surprises, trade war developments, regulatory actions, hacks/exploits.

If nothing significant happened, respond with impact: 0.

Respond ONLY as JSON:
{
    "impact": -3 to +3 (0 = nothing, 1 = minor, 2 = notable, 3 = major),
    "summary": "what happened",
    "category": "geopolitik|fed|crypto|earnings|trade_war|regulation|hack|other",
    "affectedAssets": ["BTC", "ETH", "SOL", "STOCKS", "OIL", etc],
    "sources": ["@user: tweet summary", ...],
    "confidence": 0.0 to 1.0
}`
            }],
            temperature: 0.1,
            max_tokens: 500,
        });

        const text = response.choices[0]?.message?.content?.trim();
        if (!text) return;

        // Parse JSON from response (handle markdown code blocks)
        const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const scan = JSON.parse(jsonStr);

        if (typeof scan.impact !== 'number') return;

        const direction = scan.impact > 0 ? 'bullish' : scan.impact < 0 ? 'bearish' : 'neutral';
        const state = {
            scan,
            timestamp: Date.now(),
            direction,
            ageSeconds: 0,
        };

        // Always write latest scan (even impact=0, so consumers know scanner is alive)
        await redis.set('headlines:latest', JSON.stringify(state), 'EX', HEADLINE_TTL);

        // Only write to active key if impact is meaningful (|impact| >= 2)
        if (Math.abs(scan.impact) >= 2) {
            await redis.set('headlines:active', JSON.stringify(state), 'EX', HEADLINE_TTL);
            console.log(`[HEADLINES] 🔴 ACTIVE: impact=${scan.impact} ${direction} | ${scan.summary}`);

            // Push to history for analysis
            await redis.lpush('headlines:history', JSON.stringify(state));
            await redis.ltrim('headlines:history', 0, 99); // Keep last 100
        } else {
            console.log(`[HEADLINES] Scan complete: impact=${scan.impact} (${scan.summary || 'nothing notable'})`);
        }
    } catch (err) {
        console.warn('[HEADLINES] Scan error:', err instanceof Error ? err.message : err);
    }
}

// ── Main loop ──────────────────────────────────────────────────

async function main() {
    console.log('============================================================');
    console.log('  Headline Scanner — Grok X/Twitter Monitor');
    console.log(`  Interval: ${SCAN_INTERVAL_MS / 1000}s`);
    console.log('============================================================');

    // Initial scan
    await scanHeadlines();

    // Loop
    setInterval(scanHeadlines, SCAN_INTERVAL_MS);
}

main().catch(err => {
    console.error('[HEADLINES] Fatal:', err);
    process.exit(1);
});
