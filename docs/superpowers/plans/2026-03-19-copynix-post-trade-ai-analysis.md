# Copynix Post-Trade AI Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After every SELL trade, schedule an AI analysis (via Grok/XAI) that evaluates the trade with full market context — verdict, root cause, wallet quality, and actionable lessons — saved to Postgres and logged to console.

**Architecture:** New `PostTradeAnalyzer` class handles the delayed analysis pipeline. On each SELL, `logSell()` schedules a 5-minute delayed analysis via `setTimeout`. The analyzer fetches post-exit price from DexScreener, builds a structured prompt, calls Grok API (OpenAI-compatible), parses the response, and updates the trade's metadata JSONB in Postgres. No blocking — analysis runs in background.

**Tech Stack:** TypeScript, Grok XAI API (OpenAI-compatible SDK), DexScreener, Postgres JSONB

---

### Task 1: Create PostTradeAnalyzer Module

**Files:**
- Create: `packages/agents/src/copynix/post-trade-analyzer.ts`

- [ ] **Step 1: Create the PostTradeAnalyzer class**

```typescript
/**
 * PostTradeAnalyzer — AI-powered post-trade analysis via Grok.
 *
 * After each SELL, waits 5 minutes then:
 *   1. Fetches current price (what happened after we sold?)
 *   2. Builds structured context (entry, exit, hold time, wallets, liquidity)
 *   3. Sends to Grok for analysis (verdict, root cause, lesson)
 *   4. Saves analysis to Postgres metadata
 *   5. Logs summary to console
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
    tradeId: number | null;  // Postgres id for updating metadata
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

// Telegram alert helper (reuse pattern from copynix-agent)
async function sendTelegramAlert(message: string): Promise<void> {
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

export class PostTradeAnalyzer {
    private pg: any = null;
    private delayMs: number;

    constructor(pg: any, delayMs: number = 5 * 60_000) {
        this.pg = pg;
        this.delayMs = delayMs;
    }

    /**
     * Schedule a post-trade analysis. Non-blocking — runs after delay via setTimeout.
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
        await sendTelegramAlert(
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

        const prompt = `You are analyzing a completed copy-trade on Solana memecoins. Give a brief, actionable analysis.

TRADE DATA:
- Token: ${context.tokenSymbol} (${context.tokenMint.slice(0, 12)}...)
- Entry price: $${context.entryPrice.toFixed(8)}
- Exit price: $${context.exitPrice.toFixed(8)}
- Hold time: ${context.holdMinutes.toFixed(0)} minutes
- P/L: ${context.pnlUsd >= 0 ? '+' : ''}$${context.pnlUsd.toFixed(2)} (${context.pnlPct >= 0 ? '+' : ''}${context.pnlPct.toFixed(1)}%)
- Exit reason: ${context.exitReason}
- Consensus level: ${context.consensusLevel}
- Triggering wallets: ${context.walletScores.map(w => `${w.wallet}(score:${w.score})`).join(', ')}${afterExitInfo}

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
                    model: 'grok-3-mini',
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

            // Parse JSON from response (handle potential markdown wrapping)
            const jsonStr = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const parsed = JSON.parse(jsonStr);

            return {
                verdict: parsed.verdict ?? 'NEUTRAL',
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
}
```

- [ ] **Step 2: Commit**
```bash
git add packages/agents/src/copynix/post-trade-analyzer.ts
git commit -m "feat(copynix): add PostTradeAnalyzer — AI-powered post-trade analysis via Grok"
```

---

### Task 2: Integrate Analyzer into copynix-agent.ts

**Files:**
- Modify: `packages/agents/src/copynix/copynix-agent.ts` (import, init, trigger in logSell)

- [ ] **Step 1: Add import at top of file**

After the existing imports (around line 14), add:
```typescript
import { PostTradeAnalyzer, type TradeContext } from './post-trade-analyzer';
```

- [ ] **Step 2: Add analyzer as class member**

In the `CopynixAgent` class, after `private wsMonitor` (around line 171), add:
```typescript
    private postTradeAnalyzer: PostTradeAnalyzer | null = null;
```

- [ ] **Step 3: Initialize analyzer in initialize() method**

After the trade logger connection (around line 247 `await this.tradeLogger.connect()`), add:
```typescript
        // Initialize post-trade AI analyzer (uses Grok via XAI_API_KEY)
        if (process.env.XAI_API_KEY) {
            this.postTradeAnalyzer = new PostTradeAnalyzer(this.tradeLogger.getPg(), 5 * 60_000);
            this.log('info', 'Post-trade AI analyzer enabled (Grok, 5min delay)');
        }
```

- [ ] **Step 4: Expose pg client from CopynixTradeLogger**

Add a getter to `CopynixTradeLogger` class (around line 153):
```typescript
    getPg(): any { return this.pg; }
```

- [ ] **Step 5: Trigger analysis at end of logSell()**

At the end of `logSell()` method (after the Telegram alert, around line 795), add:
```typescript
        // Schedule AI post-trade analysis (runs 5 min after exit)
        if (this.postTradeAnalyzer) {
            // Get the trade ID from Postgres (most recent SELL for this token)
            let tradeId: number | null = null;
            try {
                const pgClient = this.tradeLogger.getPg();
                if (pgClient) {
                    const { rows } = await pgClient.query(
                        `SELECT id FROM copynix_trades WHERE token_mint = $1 AND side = 'SELL' ORDER BY id DESC LIMIT 1`,
                        [pos.tokenMint],
                    );
                    tradeId = rows[0]?.id ?? null;
                }
            } catch { /* non-critical */ }

            const tradeContext: TradeContext = {
                tokenMint: pos.tokenMint,
                tokenSymbol: pos.tokenSymbol,
                entryPrice: pos.avgEntryPrice,
                exitPrice,
                holdMinutes: (Date.now() - pos.entryTime) / 60_000,
                pnlUsd: pnl,
                pnlPct,
                exitReason: reason,
                consensusLevel: pos.consensusLevel,
                walletAddresses: pos.copiedFrom,
                walletScores: pos.copiedFrom.map(a => ({
                    wallet: a.slice(0, 8),
                    score: Math.round(this.bayesian.getScore(a)),
                })),
                tradeId,
            };
            this.postTradeAnalyzer.scheduleAnalysis(tradeContext);
        }
```

- [ ] **Step 6: Commit**
```bash
git add packages/agents/src/copynix/copynix-agent.ts
git commit -m "feat(copynix): integrate PostTradeAnalyzer into logSell() — 5min delayed AI analysis"
```

---

### Task 3: Add XAI_API_KEY to Docker + Deploy

**Files:**
- Modify: `docker-compose.prod.yml` (add XAI_API_KEY env var to copynix service)

- [ ] **Step 1: Add XAI_API_KEY to copynix service environment**

In `docker-compose.prod.yml`, find the copynix service environment block (has HELIUS_API_KEY, SHYFT_API_KEY, etc.) and add:
```yaml
      - XAI_API_KEY=${XAI_API_KEY:-}
```

Note: `openai` npm package is NOT needed — we use raw `fetch()` against the OpenAI-compatible Grok API. No Dockerfile changes required.

- [ ] **Step 2: Commit**
```bash
git add docker-compose.prod.yml
git commit -m "feat(copynix): add XAI_API_KEY to copynix Docker env for AI analysis"
```

---

### Task 4: Deploy + Verify

- [ ] **Step 1: Push code to VM**
```bash
git archive --format=tar HEAD -- packages/agents/src/copynix/ docker-compose.prod.yml | \
  ssh azureuser@openclaw-vm "cd ~/cryonix && tar xf -"
```

- [ ] **Step 2: Rebuild + restart copynix container**
```bash
ssh azureuser@openclaw-vm "cd ~/cryonix && docker compose -f docker-compose.prod.yml up -d --no-deps --build copynix"
```

- [ ] **Step 3: Verify startup logs**
```bash
ssh azureuser@openclaw-vm "sleep 15 && docker logs cryonix-copynix-1 --tail 10"
```

Expected: `Post-trade AI analyzer enabled (Grok, 5min delay)` in logs.

- [ ] **Step 4: Verify after next SELL trade**

When a SELL occurs, check logs 5 minutes later for:
```
[AI-ANALYSIS] Scheduled for TOKEN in 5min
[AI-ANALYSIS] ✅ TOKEN — GOOD_EXIT
  One sentence summary...
  Lesson: actionable insight
```

---

### Expected Behavior

After each SELL trade:
1. `[AI-ANALYSIS] Scheduled for TOKEN in 5min` — logged immediately
2. 5 minutes later: DexScreener fetch for post-exit price
3. Grok API call with full trade context
4. `[AI-ANALYSIS] ✅/❌/➖ TOKEN — VERDICT` with summary + lesson
5. Postgres `copynix_trades.metadata` updated with `ai_analysis` JSONB
6. Telegram alert with full analysis (if bot token configured)

**Cost estimate:** ~$0.001 per analysis (Grok-3-mini, 500 tokens). At 10 trades/day = $0.01/day.
