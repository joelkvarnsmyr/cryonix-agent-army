/**
 * PostTradeAnalyzer — AI-powered post-trade analysis via Grok.
 *
 * After each SELL, waits 5 minutes then:
 *   1. Fetches current price (what happened after we sold?)
 *   2. Builds structured context (entry, exit, hold time, wallets, liquidity)
 *   3. Sends to Grok for analysis (verdict, root cause, lesson)
 *   4. Saves analysis to Postgres metadata
 *   5. Logs summary to console + Telegram
 */

export interface TradeContext {
    tokenMint: string;
    tokenSymbol: string;
    entryPrice: number;
    exitPrice: number;
    holdMinutes: number;
    pnlUsd: number;
    pnlPct: number;
    exitReason: string;
    consensusLevel: string;
    walletAddresses: string[];
    walletScores: Array<{ wallet: string; score: number }>;
    tradeId: number | null;
}

export interface AIAnalysis {
    verdict: 'GOOD_EXIT' | 'BAD_EXIT' | 'NEUTRAL';
    summary: string;
    rootCause: string;
    latencyAssessment: string;
    walletQuality: string;
    lesson: string;
    priceAfter5min: number | null;
    priceChangeAfterExit: number | null;
    analyzedAt: string;
}

const VALID_VERDICTS = ['GOOD_EXIT', 'BAD_EXIT', 'NEUTRAL'] as const;

export class PostTradeAnalyzer {
    private pg: any = null;
    private delayMs: number;

    constructor(pg: any, delayMs: number = 5 * 60_000) {
        this.pg = pg;
        this.delayMs = delayMs;
    }

    /**
     * Schedule a post-trade analysis. Non-blocking — runs after delay via setTimeout.
     * Note: pending analyses are lost on container restart — acceptable for non-critical analytics.
     */
    scheduleAnalysis(context: TradeContext): void {
        const delay = this.delayMs;
        console.log(`[AI-ANALYSIS] Scheduled for ${context.tokenSymbol} in ${(delay / 60_000).toFixed(0)}min`);

        setTimeout(async () => {
            try {
                await this.analyze(context);
            } catch (err) {
                console.warn(`[AI-ANALYSIS] Failed for ${context.tokenSymbol}:`, err instanceof Error ? err.message : String(err));
            }
        }, delay);
    }

    private async analyze(context: TradeContext): Promise<void> {
        // Step 1: Fetch current price (5 min after our exit)
        const postExitPrice = await this.fetchCurrentPrice(context.tokenMint);
        const priceChangeAfterExit = postExitPrice && context.exitPrice > 0
            ? ((postExitPrice - context.exitPrice) / context.exitPrice) * 100
            : null;

        // Step 2: Build prompt and call Grok
        const analysis = await this.callGrok(context, postExitPrice, priceChangeAfterExit);
        if (!analysis) return;

        // Step 3: Save to Postgres
        await this.saveAnalysis(context.tradeId, analysis);

        // Step 4: Log summary
        const emoji = analysis.verdict === 'GOOD_EXIT' ? '✅' :
                      analysis.verdict === 'BAD_EXIT' ? '❌' : '➖';
        const afterStr = priceChangeAfterExit != null
            ? ` | After exit: ${priceChangeAfterExit >= 0 ? '+' : ''}${priceChangeAfterExit.toFixed(1)}%`
            : '';
        console.log(
            `[AI-ANALYSIS] ${emoji} ${context.tokenSymbol} — ${analysis.verdict}\n` +
            `  ${analysis.summary}\n` +
            `  Lesson: ${analysis.lesson}${afterStr}`,
        );

        // Step 5: Telegram alert
        await this.sendAlert(
            `${emoji} <b>AI TRADE ANALYSIS: ${context.tokenSymbol}</b>\n\n` +
            `<b>Verdict:</b> ${analysis.verdict}\n` +
            `<b>P/L:</b> ${context.pnlUsd >= 0 ? '+' : ''}$${context.pnlUsd.toFixed(2)} (${context.pnlPct.toFixed(1)}%)\n` +
            `<b>Exit:</b> ${context.exitReason} after ${context.holdMinutes.toFixed(0)}min\n` +
            (priceChangeAfterExit != null ? `<b>After exit:</b> ${priceChangeAfterExit >= 0 ? '+' : ''}${priceChangeAfterExit.toFixed(1)}%\n` : '') +
            `\n<b>Root cause:</b> ${analysis.rootCause}\n` +
            `<b>Lesson:</b> ${analysis.lesson}`,
        );
    }

    private async callGrok(
        context: TradeContext,
        postExitPrice: number | null,
        priceChangeAfterExit: number | null,
    ): Promise<AIAnalysis | null> {
        const apiKey = process.env.XAI_API_KEY;
        if (!apiKey) {
            console.warn('[AI-ANALYSIS] No XAI_API_KEY — skipping AI analysis');
            return null;
        }

        const afterExitInfo = postExitPrice != null && priceChangeAfterExit != null
            ? `\n- Price 5 min after our exit: $${postExitPrice.toFixed(8)} (${priceChangeAfterExit >= 0 ? '+' : ''}${priceChangeAfterExit.toFixed(1)}% since exit)`
            : '\n- Post-exit price: unavailable';

        const walletInfo = context.walletScores.map(w => `${w.wallet}(score:${w.score})`).join(', ');

        const prompt = `You are analyzing a completed copy-trade on Solana memecoins. Give a brief, actionable analysis.

TRADE DATA:
- Token: ${context.tokenSymbol} (${context.tokenMint.slice(0, 16)}...)
- Entry price: $${context.entryPrice.toFixed(8)}
- Exit price: $${context.exitPrice.toFixed(8)}
- Hold time: ${context.holdMinutes.toFixed(0)} minutes
- P/L: ${context.pnlUsd >= 0 ? '+' : ''}$${context.pnlUsd.toFixed(2)} (${context.pnlPct >= 0 ? '+' : ''}${context.pnlPct.toFixed(1)}%)
- Exit reason: ${context.exitReason}
- Consensus level: ${context.consensusLevel}
- Triggering wallets (${context.walletAddresses.length}): ${walletInfo}${afterExitInfo}

Respond in this exact JSON format (no markdown, no code blocks):
{
  "verdict": "GOOD_EXIT" or "BAD_EXIT" or "NEUTRAL",
  "summary": "One sentence summary of what happened",
  "rootCause": "Why did this trade win/lose? Be specific.",
  "latencyAssessment": "Was the signal stale? Did we enter too late?",
  "walletQuality": "Should we trust these wallets more or less based on this trade?",
  "lesson": "One actionable lesson for future trades"
}`;

        try {
            const res = await fetch('https://api.x.ai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: 'grok-4-1-fast-non-reasoning',
                    messages: [{ role: 'user', content: prompt }],
                    temperature: 0.3,
                    max_tokens: 500,
                }),
                signal: AbortSignal.timeout(30_000),
            });

            if (!res.ok) {
                console.warn(`[AI-ANALYSIS] Grok API HTTP ${res.status}`);
                return null;
            }

            const data = await res.json() as {
                choices?: Array<{ message?: { content?: string } }>;
            };

            const content = data.choices?.[0]?.message?.content;
            if (!content) return null;

            // Extract JSON — try raw first, then regex extraction
            let parsed: any;
            try {
                const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
                parsed = JSON.parse(cleaned);
            } catch {
                // Fallback: extract first JSON object with regex
                const match = content.match(/\{[\s\S]*\}/);
                if (!match) return null;
                parsed = JSON.parse(match[0]);
            }

            // Validate verdict against union type
            const verdict = VALID_VERDICTS.includes(parsed.verdict) ? parsed.verdict : 'NEUTRAL';

            return {
                verdict,
                summary: parsed.summary ?? '',
                rootCause: parsed.rootCause ?? '',
                latencyAssessment: parsed.latencyAssessment ?? '',
                walletQuality: parsed.walletQuality ?? '',
                lesson: parsed.lesson ?? '',
                priceAfter5min: postExitPrice,
                priceChangeAfterExit,
                analyzedAt: new Date().toISOString(),
            };
        } catch (err) {
            console.warn(`[AI-ANALYSIS] Grok call failed: ${err instanceof Error ? err.message : String(err)}`);
            return null;
        }
    }

    private async fetchCurrentPrice(tokenMint: string): Promise<number | null> {
        try {
            const url = `https://api.dexscreener.com/tokens/v1/solana/${tokenMint}`;
            const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
            if (!res.ok) return null;

            const pairs = await res.json() as Array<{
                chainId: string; priceUsd: string; liquidity?: { usd: number };
            }>;

            if (!Array.isArray(pairs)) return null;
            const solanaPair = pairs.find(p => p.chainId === 'solana');
            return solanaPair ? parseFloat(solanaPair.priceUsd) : null;
        } catch {
            return null;
        }
    }

    private async saveAnalysis(tradeId: number | null, analysis: AIAnalysis): Promise<void> {
        if (!this.pg || !tradeId) return;
        try {
            await this.pg.query(
                `UPDATE copynix_trades
                 SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
                 WHERE id = $2`,
                [JSON.stringify({ ai_analysis: analysis }), tradeId],
            );
        } catch (err: any) {
            console.warn('[AI-ANALYSIS] Postgres save failed:', err.message);
        }
    }

    private async sendAlert(message: string): Promise<void> {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        const chatId = process.env.TELEGRAM_CHAT_ID;
        if (!token || !chatId) return;
        try {
            await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
                signal: AbortSignal.timeout(5_000),
            });
        } catch { /* non-critical */ }
    }
}
