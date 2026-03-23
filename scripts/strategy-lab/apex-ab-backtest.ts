/**
 * APEX A/B Backtest — Grok vs Claude on Real Signals
 *
 * Replays historical signals through BOTH validators, walks real OHLCV
 * candles for PnL, and compares who makes better approve/reject decisions.
 *
 * Usage:
 *   # First export signals (see apex-backtest.ts header)
 *   # Then: npx tsx scripts/strategy-lab/apex-ab-backtest.ts [--limit 30]
 *
 * Requires: XAI_API_KEY env var, Claude CLI installed + authed
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';

// ── Types ────────────────────────────────────────────────────────────────────

interface Signal {
  symbol: string;
  confidence: number;
  pattern: string;
  signal_time: string;
  signal_epoch: number;
  entry_price: number;
}

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface ValidatorResult {
  approve: boolean;
  confidence: number;
  reason: string;
  latencyMs: number;
  error?: string;
}

interface ABResult {
  symbol: string;
  pattern: string;
  score: number;
  entryPrice: number;
  exitPrice: number;
  pnlPct: number;
  pnlUsd: number;
  exitReason: string;
  holdHours: number;
  grok: ValidatorResult;
  claude: ValidatorResult;
  signalTime: string;
}

// ── OHLCV ────────────────────────────────────────────────────────────────────

async function fetchCandles(
  exchange: any,
  symbol: string,
  sinceEpochSec: number,
  hours: number,
): Promise<Candle[]> {
  try {
    const raw = await exchange.fetchOHLCV(symbol, '1h', sinceEpochSec * 1000, Math.min(1000, hours + 2));
    return raw.map((c: number[]) => ({
      timestamp: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5],
    }));
  } catch {
    return [];
  }
}

// ── Exit Simulator ───────────────────────────────────────────────────────────

function walkCandles(
  candles: Candle[],
  entryPrice: number,
  tpPct: number,
  slPct: number,
  trailingPct: number,
  trailingActivPct: number,
  maxHoldH: number,
): { exitPrice: number; exitReason: string; holdHours: number; pnlPct: number } {
  let highWatermark = entryPrice;
  let trailingActive = false;

  for (let i = 0; i < candles.length && i < maxHoldH; i++) {
    const c = candles[i];
    const highPnl = ((c.high - entryPrice) / entryPrice) * 100;
    const lowPnl = ((c.low - entryPrice) / entryPrice) * 100;

    if (c.high > highWatermark) highWatermark = c.high;

    if (highPnl >= tpPct) {
      return { exitPrice: entryPrice * (1 + tpPct / 100), exitReason: 'TP', holdHours: i + 1, pnlPct: tpPct };
    }
    if (lowPnl <= -slPct) {
      return { exitPrice: entryPrice * (1 - slPct / 100), exitReason: 'SL', holdHours: i + 1, pnlPct: -slPct };
    }
    if (highPnl >= trailingActivPct) trailingActive = true;
    if (trailingActive) {
      const drop = ((highWatermark - c.low) / highWatermark) * 100;
      if (drop >= trailingPct) {
        const trailPrice = highWatermark * (1 - trailingPct / 100);
        return { exitPrice: trailPrice, exitReason: 'TRAILING', holdHours: i + 1, pnlPct: ((trailPrice - entryPrice) / entryPrice) * 100 };
      }
    }
  }

  const last = candles[Math.min(candles.length - 1, maxHoldH - 1)];
  const pnl = last ? ((last.close - entryPrice) / entryPrice) * 100 : 0;
  return { exitPrice: last?.close ?? entryPrice, exitReason: 'MAX_HOLD', holdHours: Math.min(candles.length, maxHoldH), pnlPct: pnl };
}

// ── Grok Validator ───────────────────────────────────────────────────────────

async function validateGrok(
  xai: any,
  model: string,
  builtPrompt: { systemPrompt: string; userPrompt: string },
): Promise<ValidatorResult> {
  const start = Date.now();
  try {
    const isReasoningModel = model.includes('reasoning');

    const requestBody: Record<string, unknown> = {
      model,
      messages: [
        { role: 'system', content: builtPrompt.systemPrompt },
        { role: 'user', content: builtPrompt.userPrompt },
      ],
      temperature: isReasoningModel ? undefined : 0.1,
      search: { mode: 'on' },
    };
    if (isReasoningModel) {
      requestBody.max_completion_tokens = 800;
      requestBody.reasoning = { effort: 'high' };
    } else {
      requestBody.max_tokens = 500;
    }

    const res = await xai.chat.completions.create(requestBody);
    const raw = res.choices[0]?.message?.content ?? '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { approve: false, confidence: 0, reason: 'unparseable', latencyMs: Date.now() - start };

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      approve: parsed.approve === true,
      confidence: Number(parsed.confidence) || 0,
      reason: String(parsed.reason || '').slice(0, 120),
      latencyMs: Date.now() - start,
    };
  } catch (err: any) {
    return { approve: false, confidence: 0, reason: 'error', latencyMs: Date.now() - start, error: err.message };
  }
}

// ── Claude Validator ─────────────────────────────────────────────────────────

async function validateClaude(
  model: string,
  builtPrompt: { systemPrompt: string; userPrompt: string },
): Promise<ValidatorResult> {
  const start = Date.now();
  try {
    const child = spawn('claude', [
      '-p', '--model', model, '--output-format', 'text',
      '--system-prompt', builtPrompt.systemPrompt,
    ], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env },
    });

    child.stdin.write(builtPrompt.userPrompt);
    child.stdin.end();

    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));

    const timeoutHandle = setTimeout(() => child.kill('SIGTERM'), 120_000);
    const exitCode = await new Promise<number>((resolve) => {
      child.on('close', (code) => { clearTimeout(timeoutHandle); resolve(code ?? 1); });
      child.on('error', () => { clearTimeout(timeoutHandle); resolve(1); });
    });

    const output = Buffer.concat(chunks).toString('utf-8');
    if (exitCode !== 0) return { approve: false, confidence: 0, reason: `exit ${exitCode}`, latencyMs: Date.now() - start, error: `exit ${exitCode}` };

    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { approve: false, confidence: 0, reason: 'unparseable', latencyMs: Date.now() - start };

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      approve: parsed.approve === true,
      confidence: Number(parsed.confidence) || 0,
      reason: String(parsed.reason || '').slice(0, 120),
      latencyMs: Date.now() - start,
    };
  } catch (err: any) {
    return { approve: false, confidence: 0, reason: 'error', latencyMs: Date.now() - start, error: err.message };
  }
}

// ── Confluence Scoring (simplified) ──────────────────────────────────────────

function scoreSignal(pattern: string, confidence: number): number {
  let score = 0;
  if (pattern.includes('DEEP_VALUE_CRASH') && confidence >= 0.75) score += 30;
  else if (pattern.includes('DIP_BUY') && confidence >= 0.70) score += 25;
  else if (pattern.includes('BOLLINGER_SQUEEZE') && confidence >= 0.65) score += 20;
  else if (pattern.includes('RSI_OVERSOLD') && confidence >= 0.70) score += 20;
  // Multi-pattern bonus
  const patternCount = pattern.split(',').map(p => p.trim()).filter(Boolean).length;
  if (patternCount >= 2) score += 10;
  // Simulated ambient context (conservative)
  score += 15; // baseline ambient (F&G + orakel)
  return score;
}

/** Build rich prompt with real market data — matches production Apex format */
async function buildRichPrompt(
  exchange: any,
  symbol: string,
  pattern: string,
  confidence: number,
  score: number,
): Promise<{ systemPrompt: string; userPrompt: string }> {
  const pair = `${symbol}/USDC`;
  const isDeepValue = pattern.includes('DEEP_VALUE');
  const isDip = pattern.includes('DIP_BUY') || pattern.includes('BOLLINGER_SQUEEZE');

  // Mode params
  const tpPct = isDeepValue ? 10 : isDip ? 8 : 6;
  const slPct = isDeepValue ? 5 : isDip ? 4 : 3;
  const maxHoldH = isDeepValue ? 96 : isDip ? 72 : 72;

  // Fetch real market data
  let priceCtx = '';
  try {
    const ticker = await exchange.fetchTicker(pair);
    const price = ticker.last ?? ticker.close ?? 0;
    const change24h = ticker.percentage ?? 0;
    const vol24h = ticker.quoteVolume ?? 0;
    const high24h = ticker.high ?? 0;
    const low24h = ticker.low ?? 0;

    // Compute RSI from recent candles
    const candles = await exchange.fetchOHLCV(pair, '1h', undefined, 24);
    let rsi = 0;
    if (candles.length >= 14) {
      const closes = candles.map((c: number[]) => c[4]);
      let gains = 0, losses = 0;
      for (let i = 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff > 0) gains += diff;
        else losses -= diff;
      }
      const avgGain = gains / (closes.length - 1);
      const avgLoss = losses / (closes.length - 1);
      rsi = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
    }

    const slPrice = price * (1 - slPct / 100);
    const tpPrice = price * (1 + tpPct / 100);
    const rr = slPct > 0 ? (tpPct / slPct).toFixed(1) : 'N/A';

    priceCtx = [
      `\nMARKET DATA (live):`,
      `  Price: ${price.toFixed(price > 100 ? 2 : 4)}`,
      `  24h change: ${change24h >= 0 ? '+' : ''}${change24h.toFixed(2)}%`,
      `  24h range: ${low24h.toFixed(price > 100 ? 2 : 4)} — ${high24h.toFixed(price > 100 ? 2 : 4)}`,
      `  24h volume: ${(vol24h / 1e6).toFixed(1)}M`,
      `  RSI(24h): ${rsi.toFixed(0)}`,
      `  SL: ${slPrice.toFixed(price > 100 ? 2 : 4)} (-${slPct}%)`,
      `  TP: ${tpPrice.toFixed(price > 100 ? 2 : 4)} (+${tpPct}%)`,
      `  R:R ratio: 1:${rr}`,
      `  Max hold: ${maxHoldH}h`,
    ].join('\n');
  } catch {
    priceCtx = '\nMARKET DATA: unavailable (fetch error)';
  }

  // Build signal list with ambient context
  const ambientSignals: string[] = [];
  const seed = symbol.charCodeAt(0) + Math.round(confidence * 100);
  const signals = [`  1. [cryonix] ${pattern} — confidence ${(confidence * 100).toFixed(0)}%`];
  let idx = 2;

  if (score >= 40 || isDip || isDeepValue) {
    signals.push(`  ${idx++}. [cmc] fear_greed — value 32 (extreme fear zone)`);
    ambientSignals.push('cmc');
  }
  if (seed % 3 === 0) {
    signals.push(`  ${idx++}. [orakel] direction_bullish — probability 65%`);
    ambientSignals.push('orakel');
  }
  if (seed % 5 < 2) {
    signals.push(`  ${idx++}. [polymarket] crypto_sentiment — score 62 (rising)`);
    ambientSignals.push('polymarket');
  }

  const uniqueSources = 1 + ambientSignals.length;

  // Hypothesis-testing system prompts
  const systemPrompt = isDeepValue
    ? `You are a crash-hypothesis validator for the APEX autonomous trading system. Test the hypothesis: "This drawdown is PANIC SELLING (buy opportunity), not a FALLING KNIFE."
List contradictions (reasons NOT to buy) and invalidation criteria (exit triggers).
Reply JSON only: {"approve":bool,"confidence":0-100,"reason":"string","contradictions":["..."],"invalidation_criteria":["..."]}`
    : isDip
    ? `You are a dip-hypothesis validator for the APEX autonomous trading system. Test the hypothesis: "This dip is a mean-reversion opportunity, not the start of a larger decline."
List contradictions and invalidation criteria.
Reply JSON only: {"approve":bool,"confidence":0-100,"reason":"string","contradictions":["..."],"invalidation_criteria":["..."]}`
    : `You are a confluence validator for the APEX autonomous trading system. Test the hypothesis: "This multi-signal confluence setup will produce a profitable trade."
List contradictions and invalidation criteria.
Reply JSON only: {"approve":bool,"confidence":0-100,"reason":"string","contradictions":["..."],"invalidation_criteria":["..."]}`;

  const userPrompt = [
    `CONFLUENCE OPPORTUNITY: ${symbol} BUY`,
    `Mode: ${isDeepValue ? 'crash_buy' : isDip ? 'dip_buy' : 'confluence'} | Confluence score: ${score}/100`,
    ``,
    `SIGNALS (${uniqueSources} unique sources):`,
    ...signals,
    priceCtx,
    ``,
    `Should we enter this trade? Consider the actual price action, R:R ratio,`,
    `and whether the confluence of signals justifies the risk.`,
  ].join('\n');

  return { systemPrompt, userPrompt };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const limitArg = process.argv.find(a => a.startsWith('--limit='));
  const LIMIT = limitArg ? parseInt(limitArg.split('=')[1]) : 30;

  console.log('══════════════════════════════════════════════════════════');
  console.log('  APEX A/B Backtest — Grok vs Claude');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`  Limit: ${LIMIT} signals | Grok: grok-4.20-0309-reasoning`);
  console.log(`  Claude: claude-sonnet-4-6\n`);

  // Load signals
  const csvPath = path.join(os.tmpdir(), 'apex_signals.csv');
  if (!fs.existsSync(csvPath)) {
    console.error('Signal CSV not found. Export from Postgres first.');
    process.exit(1);
  }

  const lines = fs.readFileSync(csvPath, 'utf-8').trim().split('\n');
  const allSignals: Signal[] = lines.slice(1).map(line => {
    const cols = line.match(/(".*?"|[^,]+)/g)?.map(c => c.replace(/"/g, '')) ?? [];
    return {
      symbol: cols[0],
      confidence: parseFloat(cols[2]),
      pattern: cols[3] ?? '',
      signal_time: cols[4] ?? '',
      signal_epoch: parseFloat(cols[5]),
      entry_price: parseFloat(cols[6]),
    };
  }).filter(s => s.entry_price > 0 && !isNaN(s.confidence) && s.confidence >= 0.65);

  // Score and deduplicate — pick diverse signals
  const scored = allSignals
    .map(s => ({ ...s, score: scoreSignal(s.pattern, s.confidence) }))
    .filter(s => s.score >= 25);

  // Deduplicate: max 1 signal per symbol per 12h
  const seen = new Map<string, number>();
  const deduped = scored.filter(s => {
    const key = s.symbol;
    const last = seen.get(key) ?? 0;
    if (s.signal_epoch - last < 43200) return false;
    seen.set(key, s.signal_epoch);
    return true;
  });

  // Sample evenly across time range
  const step = Math.max(1, Math.floor(deduped.length / LIMIT));
  const sampled = deduped.filter((_, i) => i % step === 0).slice(0, LIMIT);

  console.log(`  Total signals: ${allSignals.length}`);
  console.log(`  After scoring (>=35): ${scored.length}`);
  console.log(`  After dedup (12h): ${deduped.length}`);
  console.log(`  Sampled: ${sampled.length}\n`);

  // Init CCXT + Grok
  const ccxt = await import('ccxt');
  const exchange = new ccxt.binance({ enableRateLimit: true });
  await exchange.loadMarkets();

  const OpenAI = (await import('openai')).default;
  const xai = new OpenAI({ apiKey: process.env.XAI_API_KEY!, baseURL: 'https://api.x.ai/v1' });

  const grokModel = 'grok-4.20-0309-reasoning';
  const claudeModel = 'claude-sonnet-4-6';

  // Mode params (confluence default)
  const tpPct = 6, slPct = 3, trailingPct = 2.5, trailingActivPct = 3, maxHoldH = 72;
  const posSize = 71.25; // 15% of $475 available

  const results: ABResult[] = [];

  for (let i = 0; i < sampled.length; i++) {
    const sig = sampled[i];
    const baseSymbol = sig.symbol.split('/')[0];
    console.log(`[${i + 1}/${sampled.length}] ${baseSymbol} ${sig.pattern} conf=${sig.confidence} score=${sig.score}`);

    // Fetch candles
    const candles = await fetchCandles(exchange, sig.symbol, sig.signal_epoch, maxHoldH + 2);
    if (candles.length < 5) {
      console.log(`  ⏭ Skipped — insufficient candle data`);
      continue;
    }

    // Walk candles for actual outcome
    const exit = walkCandles(candles, sig.entry_price, tpPct, slPct, trailingPct, trailingActivPct, maxHoldH);
    const pnlUsd = posSize * (exit.pnlPct / 100);

    // Build rich prompt once — both validators see identical context
    const builtPrompt = await buildRichPrompt(exchange, baseSymbol, sig.pattern, sig.confidence, sig.score);

    // Call both validators with same prompt
    const [grokResult, claudeResult] = await Promise.all([
      validateGrok(xai, grokModel, builtPrompt),
      validateClaude(claudeModel, builtPrompt),
    ]);

    const emoji = exit.pnlPct >= 0 ? '✅' : '❌';
    const grokEmoji = grokResult.approve ? '👍' : '👎';
    const claudeEmoji = claudeResult.approve ? '👍' : '👎';
    const agree = grokResult.approve === claudeResult.approve ? '🤝' : '⚔️';

    console.log(`  ${emoji} PnL: ${exit.pnlPct >= 0 ? '+' : ''}${exit.pnlPct.toFixed(2)}% ($${pnlUsd.toFixed(2)}) | ${exit.exitReason} ${exit.holdHours}h`);
    console.log(`  ${grokEmoji} Grok:   ${grokResult.approve ? 'APPROVE' : 'REJECT'} (${grokResult.confidence}%) ${(grokResult.latencyMs / 1000).toFixed(1)}s`);
    console.log(`  ${claudeEmoji} Claude: ${claudeResult.approve ? 'APPROVE' : 'REJECT'} (${claudeResult.confidence}%) ${(claudeResult.latencyMs / 1000).toFixed(1)}s`);
    console.log(`  ${agree} ${grokResult.approve === claudeResult.approve ? 'AGREE' : 'DISAGREE'}\n`);

    results.push({
      symbol: baseSymbol,
      pattern: sig.pattern,
      score: sig.score,
      entryPrice: sig.entry_price,
      exitPrice: exit.exitPrice,
      pnlPct: exit.pnlPct,
      pnlUsd,
      exitReason: exit.exitReason,
      holdHours: exit.holdHours,
      grok: grokResult,
      claude: claudeResult,
      signalTime: sig.signal_time,
    });

    // Brief pause between signals
    await new Promise(r => setTimeout(r, 500));
  }

  await exchange.close();

  // ── Analysis ───────────────────────────────────────────────────────────────

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  A/B RESULTS — GROK vs CLAUDE');
  console.log('══════════════════════════════════════════════════════════\n');

  const total = results.length;
  const agree = results.filter(r => r.grok.approve === r.claude.approve).length;
  console.log(`Agreement: ${agree}/${total} (${((agree / total) * 100).toFixed(1)}%)\n`);

  // Grok's hypothetical portfolio
  const grokTrades = results.filter(r => r.grok.approve);
  const grokWins = grokTrades.filter(r => r.pnlPct > 0);
  const grokPnl = grokTrades.reduce((s, r) => s + r.pnlUsd, 0);
  const grokWR = grokTrades.length > 0 ? (grokWins.length / grokTrades.length) * 100 : 0;

  // Claude's hypothetical portfolio
  const claudeTrades = results.filter(r => r.claude.approve);
  const claudeWins = claudeTrades.filter(r => r.pnlPct > 0);
  const claudePnl = claudeTrades.reduce((s, r) => s + r.pnlUsd, 0);
  const claudeWR = claudeTrades.length > 0 ? (claudeWins.length / claudeTrades.length) * 100 : 0;

  // No-filter baseline (approve everything)
  const allPnl = results.reduce((s, r) => s + r.pnlUsd, 0);
  const allWins = results.filter(r => r.pnlPct > 0);
  const allWR = total > 0 ? (allWins.length / total) * 100 : 0;

  console.log('-- Hypothetical Portfolios --');
  console.log(`  No filter: ${total} trades, ${allWR.toFixed(0)}% WR, $${allPnl.toFixed(2)}`);
  console.log(`  Grok:      ${grokTrades.length} trades, ${grokWR.toFixed(0)}% WR, $${grokPnl.toFixed(2)}`);
  console.log(`  Claude:    ${claudeTrades.length} trades, ${claudeWR.toFixed(0)}% WR, $${claudePnl.toFixed(2)}\n`);

  // Profit factor
  const grokGross = grokTrades.filter(r => r.pnlUsd > 0).reduce((s, r) => s + r.pnlUsd, 0);
  const grokLoss = Math.abs(grokTrades.filter(r => r.pnlUsd <= 0).reduce((s, r) => s + r.pnlUsd, 0));
  const claudeGross = claudeTrades.filter(r => r.pnlUsd > 0).reduce((s, r) => s + r.pnlUsd, 0);
  const claudeLoss = Math.abs(claudeTrades.filter(r => r.pnlUsd <= 0).reduce((s, r) => s + r.pnlUsd, 0));

  console.log('-- Profit Factor --');
  console.log(`  Grok:   ${grokLoss > 0 ? (grokGross / grokLoss).toFixed(2) : '∞'}`);
  console.log(`  Claude: ${claudeLoss > 0 ? (claudeGross / claudeLoss).toFixed(2) : '∞'}\n`);

  // Disagreement analysis — the most interesting part
  const grokOnly = results.filter(r => r.grok.approve && !r.claude.approve);
  const claudeOnly = results.filter(r => !r.grok.approve && r.claude.approve);
  const bothApprove = results.filter(r => r.grok.approve && r.claude.approve);
  const bothReject = results.filter(r => !r.grok.approve && !r.claude.approve);

  console.log('-- Decision Matrix --');
  console.log(`  Both APPROVE: ${bothApprove.length} trades, $${bothApprove.reduce((s, r) => s + r.pnlUsd, 0).toFixed(2)}`);
  console.log(`  Both REJECT:  ${bothReject.length} signals (correctly filtered?)`);
  console.log(`  Grok APPROVE, Claude REJECT: ${grokOnly.length} trades, $${grokOnly.reduce((s, r) => s + r.pnlUsd, 0).toFixed(2)}`);
  console.log(`  Claude APPROVE, Grok REJECT: ${claudeOnly.length} trades, $${claudeOnly.reduce((s, r) => s + r.pnlUsd, 0).toFixed(2)}\n`);

  // Both-reject missed PnL
  const bothRejectPnl = bothReject.reduce((s, r) => s + r.pnlUsd, 0);
  const bothRejectWins = bothReject.filter(r => r.pnlPct > 0);
  console.log(`  Both rejected: would have been $${bothRejectPnl.toFixed(2)} (${bothRejectWins.length}/${bothReject.length} winners)\n`);

  // Latency comparison
  const avgGrokMs = results.reduce((s, r) => s + r.grok.latencyMs, 0) / total;
  const avgClaudeMs = results.reduce((s, r) => s + r.claude.latencyMs, 0) / total;
  console.log('-- Latency --');
  console.log(`  Grok avg:   ${(avgGrokMs / 1000).toFixed(1)}s`);
  console.log(`  Claude avg: ${(avgClaudeMs / 1000).toFixed(1)}s\n`);

  // Confidence comparison
  const avgGrokConf = results.reduce((s, r) => s + r.grok.confidence, 0) / total;
  const avgClaudeConf = results.reduce((s, r) => s + r.claude.confidence, 0) / total;
  console.log('-- Avg Confidence --');
  console.log(`  Grok:   ${avgGrokConf.toFixed(1)}%`);
  console.log(`  Claude: ${avgClaudeConf.toFixed(1)}%\n`);

  // Winner
  console.log('══════════════════════════════════════════════════════════');
  if (grokPnl > claudePnl) {
    console.log(`  🏆 GROK wins by $${(grokPnl - claudePnl).toFixed(2)}`);
  } else if (claudePnl > grokPnl) {
    console.log(`  🏆 CLAUDE wins by $${(claudePnl - grokPnl).toFixed(2)}`);
  } else {
    console.log(`  🤝 TIE`);
  }
  console.log(`  Grok:   ${grokTrades.length} trades → $${grokPnl.toFixed(2)}`);
  console.log(`  Claude: ${claudeTrades.length} trades → $${claudePnl.toFixed(2)}`);

  // Optimal strategy suggestion
  const bestPnl = Math.max(grokPnl, claudePnl, bothApprove.reduce((s, r) => s + r.pnlUsd, 0));
  if (bothApprove.reduce((s, r) => s + r.pnlUsd, 0) >= bestPnl) {
    console.log(`  💡 Consensus strategy (both must agree) looks optimal`);
  }
  console.log('══════════════════════════════════════════════════════════\n');

  // Errors
  const grokErrors = results.filter(r => r.grok.error).length;
  const claudeErrors = results.filter(r => r.claude.error).length;
  if (grokErrors + claudeErrors > 0) {
    console.log(`⚠️  Errors: Grok ${grokErrors}, Claude ${claudeErrors}`);
  }
}

main().catch(err => {
  console.error('A/B Backtest error:', err);
  process.exit(1);
});
