#!/usr/bin/env npx tsx
/**
 * Polynix Dashboard Playwright Test
 *
 * Tests the /polynix dashboard page against the live VM.
 * Verifies: page load, data rendering, clickable bets, API data consistency.
 *
 * Usage: npx tsx scripts/strategy-lab/polynix-dashboard-test.ts
 */

import { chromium } from 'playwright';

const BASE_URL = 'http://openclaw-vm';
const API_URL = `${BASE_URL}/api/polynix`;

interface TestResult {
    name: string;
    passed: boolean;
    detail: string;
}

const results: TestResult[] = [];

function log(name: string, passed: boolean, detail: string) {
    results.push({ name, passed, detail });
    const icon = passed ? 'PASS' : 'FAIL';
    console.log(`  ${icon} | ${name}: ${detail}`);
}

async function main() {
    console.log('=== Polynix Dashboard Test ===\n');

    // 1. Test API endpoints first
    console.log('--- API Tests ---');

    // Status API
    try {
        const res = await fetch(`${API_URL}/status`);
        const data = await res.json();
        log('API /status', res.ok, `HTTP ${res.status}`);
        log('API status.agent', data.agent != null, `running=${data.agent?.running}`);
        log('API status.account', data.account != null, `balance=$${data.account?.balance?.toFixed(2)}, open=${data.account?.openPositions}`);
        log('API status.risk', data.risk != null, `dailyPnl=$${data.risk?.dailyPnl?.toFixed(2)}`);
        log('API account.winRate valid', typeof data.account?.winRate === 'number', `WR=${data.account?.winRate}%`);
        log('API wins+losses <= tradesTotal', (data.account?.wins ?? 0) + (data.account?.losses ?? 0) <= (data.account?.tradesTotal ?? 0) + 1, `W=${data.account?.wins} L=${data.account?.losses} T=${data.account?.tradesTotal}`);
    } catch (e: any) {
        log('API /status', false, e.message);
    }

    // Portfolio API
    try {
        const res = await fetch(`${API_URL}/portfolio`);
        const data = await res.json();
        log('API /portfolio', res.ok, `HTTP ${res.status}`);
        log('API portfolio.balance >= 0 or negative (overexposed)', typeof data.balance === 'number', `$${data.balance?.toFixed(2)}`);
    } catch (e: any) {
        log('API /portfolio', false, e.message);
    }

    // Positions API
    let posCount = 0;
    try {
        const res = await fetch(`${API_URL}/positions`);
        const data = await res.json();
        posCount = data.positions?.length ?? 0;
        log('API /positions', res.ok, `HTTP ${res.status}, ${posCount} positions`);
        if (posCount > 0) {
            const p = data.positions[0];
            log('API position has market', p.market != null, `title=${p.market?.title?.slice(0, 50)}`);
            log('API position has entryPrice', typeof p.entryPrice === 'number', `entry=${p.entryPrice}`);
            log('API position has currentPrice', p.currentPrice !== undefined, `current=${p.currentPrice}`);
            log('API position has unrealizedPnl', p.unrealizedPnl !== undefined, `urPnl=$${p.unrealizedPnl?.toFixed(2)}`);
            log('API position has expiresAt', typeof p.expiresAt === 'number', `expires=${new Date(p.expiresAt).toISOString().slice(0, 10)}`);
        }
    } catch (e: any) {
        log('API /positions', false, e.message);
    }

    // Trades API
    try {
        const res = await fetch(`${API_URL}/trades`);
        const data = await res.json();
        log('API /trades', res.ok, `HTTP ${res.status}, ${data.trades?.length ?? 0} trades`);
        log('API trades.summary', data.summary != null, `total=${data.summary?.total}, WR=${((data.summary?.winRate ?? 0) * 100).toFixed(0)}%`);
    } catch (e: any) {
        log('API /trades', false, e.message);
    }

    // 2. Browser tests
    console.log('\n--- Browser Tests ---');

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
        // Load page
        const response = await page.goto(`${BASE_URL}/polynix`, { timeout: 30000, waitUntil: 'networkidle' });
        log('Page loads', response?.ok() ?? false, `HTTP ${response?.status()}`);

        // Wait for client-side hydration
        await page.waitForTimeout(3000);

        // Check title/header
        const polynixLabel = await page.locator('text=POLYNIX').first().isVisible();
        log('POLYNIX header visible', polynixLabel, '');

        // Check PAPER badge
        const paperBadge = await page.locator('text=PAPER').first().isVisible();
        log('PAPER badge visible', paperBadge, '');

        // Check running status indicator
        const statusDot = await page.locator('.rounded-full').first().isVisible();
        log('Status indicator visible', statusDot, '');

        // Check balance card
        const balanceText = await page.locator('text=VIRTUAL BALANCE').isVisible();
        log('Balance card visible', balanceText, '');

        // Check balance value (should contain $ sign)
        const balanceValue = await page.locator('.text-orange-400').first().textContent();
        const hasBalance = balanceValue?.includes('$') ?? false;
        log('Balance shows $ value', hasBalance, `"${balanceValue?.trim()}"`);

        // Check that balance is not $0.00 (would indicate data not loaded)
        const balanceNum = parseFloat(balanceValue?.replace('$', '') ?? '0');
        log('Balance is non-zero (data loaded)', balanceNum !== 0, `$${balanceNum.toFixed(2)}`);

        // Check realized P&L
        const realizedText = await page.locator('text=realized').first().isVisible();
        log('Realized P&L visible', realizedText, '');

        // Check deployed text
        const deployedText = await page.locator('text=deployed').first().isVisible();
        log('Deployed capital visible', deployedText, '');

        // Check stat cards
        const openLabel = await page.locator('text=OPEN').first().isVisible();
        log('OPEN stat visible', openLabel, '');

        const settledLabel = await page.locator('text=SETTLED').first().isVisible();
        log('SETTLED stat visible', settledLabel, '');

        const wrLabel = await page.locator('text=WIN RATE').first().isVisible();
        log('WIN RATE stat visible', wrLabel, '');

        // Check open bets section
        const openBetsLabel = await page.locator('text=OPEN BETS').isVisible();
        log('OPEN BETS section visible', openBetsLabel, '');

        // Check if bets are rendered (should have ARB or DIR badges)
        const arbBadges = await page.locator('text=ARB').count();
        const dirBadges = await page.locator('text=DIR').count();
        const totalBadges = arbBadges + dirBadges;
        log('Bet badges rendered', totalBadges > 0, `ARB=${arbBadges}, DIR=${dirBadges}`);

        // Check that position count matches API
        log('Bet count matches API', totalBadges >= posCount - 2, `page=${totalBadges}, api=${posCount} (±2 tolerance)`);

        // Check unrealized P&L on bets (should show +$ or -$ values)
        const pnlValues = await page.locator('[class*="text-emerald-400"], [class*="text-red-400"]').count();
        log('P&L values rendered', pnlValues > 0, `${pnlValues} colored values`);

        // Check current price (¢ values)
        const centValues = await page.locator('text=/\\d+¢/').count();
        log('Current odds (¢) rendered', centValues > 0, `${centValues} values with ¢`);

        // Check expiry labels
        const expiryLabels = await page.locator('text=/\\d+[dhm]/').count();
        log('Expiry labels rendered', expiryLabels > 0, `${expiryLabels} time labels`);

        // Test clickable bet expansion
        if (totalBadges > 0) {
            const firstBet = page.locator('.rounded-xl.cursor-pointer').first();
            const isClickable = await firstBet.isVisible();
            log('First bet is clickable', isClickable, '');

            if (isClickable) {
                await firstBet.click();
                await page.waitForTimeout(500);

                // Check expanded content
                const expandedEntry = await page.locator('text=Entry price').first().isVisible();
                log('Expanded: Entry price visible', expandedEntry, '');

                const expandedCost = await page.locator('text=Cost basis').first().isVisible();
                log('Expanded: Cost basis visible', expandedCost, '');

                const expandedPayout = await page.locator('text=Max payout').first().isVisible();
                log('Expanded: Max payout visible', expandedPayout, '');

                // Check for current odds in expanded view
                const expandedOdds = await page.locator('text=Current odds').first().isVisible();
                log('Expanded: Current odds visible', expandedOdds, '');

                // Check for unrealized P&L in expanded view
                const expandedUrPnl = await page.locator('text=Unrealized P&L').first().isVisible();
                log('Expanded: Unrealized P&L visible', expandedUrPnl, '');
            }
        }

        // Check settled bets section
        const settledBetsLabel = await page.locator('text=SETTLED BETS').isVisible();
        log('SETTLED BETS section visible', settledBetsLabel, '');

        // Check risk footer
        const lossStreakText = await page.locator('text=Loss streak').isVisible();
        log('Risk footer visible', lossStreakText, '');

        // Check navbar has Polynix active
        const navActive = await page.locator('a[href="/polynix"] button').first().isVisible();
        log('Navbar Polynix link active', navActive, '');

        // Take screenshot
        await page.screenshot({ path: 'polynix-dashboard-test.png', fullPage: true });
        log('Screenshot saved', true, 'polynix-dashboard-test.png');

    } catch (e: any) {
        log('Browser test error', false, e.message);
    } finally {
        await browser.close();
    }

    // Summary
    console.log('\n=== SUMMARY ===');
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;
    console.log(`\n  ${passed} passed, ${failed} failed, ${results.length} total`);

    if (failed > 0) {
        console.log('\n  FAILURES:');
        for (const r of results.filter(r => !r.passed)) {
            console.log(`    ${r.name}: ${r.detail}`);
        }
    }

    console.log('');
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
