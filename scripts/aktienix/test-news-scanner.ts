// Dry-run test for StockNewsScanner
// Usage: XAI_API_KEY=xai-xxx npx ts-node scripts/aktienix/test-news-scanner.ts
// Without XAI_API_KEY: runs with mock data to verify parsing/output logic

import { StockNewsScanner, MacroSignal } from '../../packages/agents/src/aktienix/intelligence/news-scanner';
import { NEWS_SOURCES } from '../../packages/agents/src/aktienix/intelligence/x-accounts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimestamp(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return (
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    );
}

function printSignals(signals: MacroSignal[]): void {
    const ts = formatTimestamp(new Date());

    console.log('\n=== AKTIENIX MACRO INTELLIGENCE SCAN ===');
    console.log(`Timestamp: ${ts}`);
    console.log('');

    if (signals.length === 0) {
        console.log('  (no actionable macro signals detected)');
    } else {
        signals.forEach((sig, i) => {
            const pct = Math.round(sig.confidence * 100);
            console.log(`[${i + 1}] EVENT: ${sig.event}`);
            console.log(`    Impact:     ${sig.impact.toUpperCase()}`);
            console.log(`    Sectors:    ${sig.sectors.join(', ')}`);
            console.log(`    Tickers:    ${sig.tickers.join(', ')}`);
            console.log(`    Confidence: ${pct}%`);
            console.log(`    Reasoning:  ${sig.reasoning}`);
            if (sig.sourceUrl) {
                console.log(`    Source:     ${sig.sourceUrl}`);
            }
            console.log('');
        });
    }

    console.log(`TOTAL: ${signals.length} actionable macro signal${signals.length !== 1 ? 's' : ''} detected.`);
    console.log('=== END SCAN ===\n');
}

function printMonitoredAccounts(): void {
    console.log('--- Monitored X Accounts ---');

    const flat: Record<string, string[]> = {};

    for (const [category, value] of Object.entries(NEWS_SOURCES)) {
        if (Array.isArray(value)) {
            flat[category] = value;
        } else if (typeof value === 'object') {
            // Nested (e.g., sectors)
            for (const [sub, accounts] of Object.entries(value as Record<string, string[]>)) {
                flat[`${category}.${sub}`] = accounts;
            }
        }
    }

    for (const [group, accounts] of Object.entries(flat)) {
        console.log(`  [${group}]`);
        accounts.forEach(acc => console.log(`    ${acc}`));
    }

    const totalFlat = Object.values(flat).reduce((sum, arr) => sum + arr.length, 0);
    console.log(`\n  Total: ${totalFlat} accounts across ${Object.keys(flat).length} groups`);
    console.log('----------------------------\n');
}

// ---------------------------------------------------------------------------
// Mock data (used when XAI_API_KEY is not set)
// ---------------------------------------------------------------------------

const MOCK_SIGNALS: MacroSignal[] = [
    {
        event: 'fed_rate_cut',
        impact: 'bullish',
        sectors: ['technology', 'real_estate', 'small_caps'],
        tickers: ['QQQ', 'ARKK', 'IWM', 'XLRE'],
        confidence: 0.85,
        reasoning: '[MOCK] WSJ Nick Timiraos just leaked that Fed is considering 50bps cut tomorrow.',
        sourceUrl: 'https://x.com/NickTimiraos/status/mock000001'
    },
    {
        event: 'middle_east_conflict',
        impact: 'bearish',
        sectors: ['airlines', 'consumer_discretionary'],
        tickers: ['UAL', 'DAL', 'AAL'],
        confidence: 0.72,
        reasoning: '[MOCK] Escalation at Strait of Hormuz — tanker attacked, Brent +4%.'
    }
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    const hasApiKey = Boolean(process.env.XAI_API_KEY);

    console.log('\n[test-news-scanner] Starting StockNewsScanner smoke test...');
    console.log(`[test-news-scanner] Mode: ${hasApiKey ? 'LIVE (XAI_API_KEY set)' : 'DRY-RUN (mock data)'}\n`);

    // Always show which accounts are being monitored — validates x-accounts.ts import
    printMonitoredAccounts();

    const scanner = new StockNewsScanner();

    let signals: MacroSignal[];

    if (!hasApiKey) {
        console.log('[test-news-scanner] XAI_API_KEY not set — using mock signals to verify output logic.\n');
        signals = MOCK_SIGNALS;
    } else {
        console.log('[test-news-scanner] Calling scanner.scanMacroEvents()...\n');
        signals = await scanner.scanMacroEvents();
    }

    printSignals(signals);
}

main().then(() => {
    process.exit(0);
}).catch((err: unknown) => {
    console.error('[test-news-scanner] Fatal error:', err);
    process.exit(1);
});
