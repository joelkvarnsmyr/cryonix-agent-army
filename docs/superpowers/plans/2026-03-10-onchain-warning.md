# On-Chain Warning Detection Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect on-chain warnings (exchange deposits, whale moves, hacks) via Grok X-search and automatically protect open positions by tightening stop-loss or force-closing.

**Architecture:** Extend `x_sentiment.py` to add an `onchain_alert` field to the existing Grok prompt (no extra API call). Store result as JSON in `sentiment:alert:{SYMBOL}`. In `auto-trade/route.ts`, check alert in the position monitoring loop and act based on severity.

**Tech Stack:** Python 3.11, xAI Grok API (grok-3-mini, x_search enabled), Redis, TypeScript/Next.js, CCXT Binance

---

## File Structure

| File | Change |
|------|--------|
| `scripts/strategy-lab/x_sentiment.py` | Extend prompt + write JSON alert to Redis |
| `scripts/strategy-lab/tests/test_x_sentiment.py` | New — unit tests for alert writing logic |
| `apps/web/src/app/api/auto-trade/route.ts` | JSON alert parsing + position monitoring alert check |

---

## Task 1: Extend x_sentiment.py — on-chain detection

**Files:**
- Modify: `scripts/strategy-lab/x_sentiment.py`
- Create: `scripts/strategy-lab/tests/test_x_sentiment.py`

### Background

`x_sentiment.py` calls Grok with live X-search every 15 min. It returns per-symbol sentiment including an `alert` field (plain string like "hack reported"). We extend the prompt to also return an `onchain_alert` structured field and write it as JSON to `sentiment:alert:{SYMBOL}`.

Current write logic (lines 132-134):
```python
if info.get('alert'):
    r.setex(f'sentiment:alert:{symbol}', ALERT_TTL, str(info['alert']))
```

Target: if `onchain_alert` is present → write JSON `{"severity": "critical|warning", "reason": "...", "source": "@handle", "detected_at": "..."}`. If only plain `alert` → keep existing behavior (plain string, backward compat).

- [ ] **Step 1: Write the failing tests**

Create `scripts/strategy-lab/tests/test_x_sentiment.py`:

```python
"""Tests for on-chain alert writing logic in x_sentiment.py"""
import json
import sys
import os
from unittest.mock import MagicMock, patch
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

# Import the functions we'll test
# We test write_to_redis in isolation by passing a mock Redis client


def make_redis_mock():
    r = MagicMock()
    r.calls = {}
    def setex_side_effect(key, ttl, value):
        r.calls[key] = {'ttl': ttl, 'value': value}
    r.setex.side_effect = setex_side_effect
    r.set.side_effect = lambda key, value, ex=None: None
    return r


def test_onchain_alert_writes_json():
    """When onchain_alert present, sentiment:alert:{SYMBOL} should be JSON with severity."""
    from x_sentiment import write_to_redis
    r = make_redis_mock()
    sentiment_data = {
        'BTC': {
            'score': 1,
            'volume': 'high',
            'narrative': 'all good',
            'alert': None,
            'onchain_alert': {
                'severity': 'warning',
                'reason': 'Large exchange deposits detected',
                'source': '@lookonchain',
            }
        }
    }
    write_to_redis(r, sentiment_data, 'grok-3-mini', 100)
    assert 'sentiment:alert:BTC' in r.calls
    payload = json.loads(r.calls['sentiment:alert:BTC']['value'])
    assert payload['severity'] == 'warning'
    assert payload['reason'] == 'Large exchange deposits detected'
    assert payload['source'] == '@lookonchain'
    assert 'detected_at' in payload
    # TTL should be ONCHAIN_ALERT_TTL (3600)
    assert r.calls['sentiment:alert:BTC']['ttl'] == 3600


def test_critical_onchain_alert_writes_json():
    """Critical severity is stored correctly."""
    from x_sentiment import write_to_redis
    r = make_redis_mock()
    sentiment_data = {
        'ETH': {
            'score': -3,
            'volume': 'high',
            'narrative': 'protocol hacked',
            'alert': 'hack reported',
            'onchain_alert': {
                'severity': 'critical',
                'reason': 'Exploit draining funds',
                'source': '@rektfeed',
            }
        }
    }
    write_to_redis(r, sentiment_data, 'grok-3-mini', 100)
    payload = json.loads(r.calls['sentiment:alert:ETH']['value'])
    assert payload['severity'] == 'critical'


def test_plain_alert_writes_string_when_no_onchain():
    """When no onchain_alert, plain alert string is written (backward compat)."""
    from x_sentiment import write_to_redis
    r = make_redis_mock()
    sentiment_data = {
        'SOL': {
            'score': -1,
            'volume': 'medium',
            'narrative': 'some FUD',
            'alert': 'hack reported',
            'onchain_alert': None,
        }
    }
    write_to_redis(r, sentiment_data, 'grok-3-mini', 100)
    assert 'sentiment:alert:SOL' in r.calls
    # Should be plain string, not JSON
    value = r.calls['sentiment:alert:SOL']['value']
    assert value == 'hack reported'


def test_no_alert_writes_nothing():
    """When no alert and no onchain_alert, sentiment:alert key is not written."""
    from x_sentiment import write_to_redis
    r = make_redis_mock()
    sentiment_data = {
        'BTC': {
            'score': 2,
            'volume': 'high',
            'narrative': 'all good',
            'alert': None,
            'onchain_alert': None,
        }
    }
    write_to_redis(r, sentiment_data, 'grok-3-mini', 100)
    assert 'sentiment:alert:BTC' not in r.calls
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd scripts/strategy-lab && python -m pytest tests/test_x_sentiment.py -v
```

Expected: FAIL — `write_to_redis` does not yet handle `onchain_alert`.

- [ ] **Step 3: Implement the changes in x_sentiment.py**

**3a. Add ONCHAIN_ALERT_TTL constant** (after line 37):
```python
ONCHAIN_ALERT_TTL = 3600  # 1h for structured on-chain alerts
```

**3b. Extend `build_user_prompt()`** — add `onchain_alert` to the response schema. Replace the return statement with:

```python
def build_user_prompt() -> str:
    symbols = ', '.join(WATCHLIST)
    return f"""Analyze the current X/Twitter sentiment for these cryptocurrencies: {symbols}

For each coin, provide:
1. Sentiment score (-3 to +3, where -3=extreme fear/bearish, +3=extreme greed/bullish)
2. Volume of discussion (low/medium/high)
3. Key narrative (one sentence: what are people talking about?)
4. Any breaking news or events
5. On-chain warnings: search for suspicious large exchange deposits, whale wallet moves to
   exchanges, hack/exploit/rug alerts. Check accounts like @lookonchain, @rektfeed,
   @OnchainLens, @WhalAlert for each coin.

Return JSON only:
{{
  "BTC": {{"score": 1, "volume": "high", "narrative": "...", "alert": null, "onchain_alert": null}},
  "ETH": {{"score": -1, "volume": "medium", "narrative": "...", "alert": "hack reported",
           "onchain_alert": {{"severity": "critical", "reason": "Exploit reported", "source": "@rektfeed"}}}},
  ...
}}

onchain_alert severity rules:
- "critical": hack, exploit, rug pull, contract vulnerability, funds drained
- "warning": large exchange deposits, whale moves to exchanges, suspicious transfers
- null: no on-chain concerns

Only include coins with notable sentiment. Skip coins with no meaningful X activity."""
```

**3c. Update `write_to_redis()`** — replace lines 132-134 with:

```python
            # Alert flag: on-chain alert (JSON) takes priority over plain alert (string)
            onchain_alert = info.get('onchain_alert')
            plain_alert = info.get('alert')
            if onchain_alert and isinstance(onchain_alert, dict):
                alert_payload = {
                    'severity': onchain_alert.get('severity', 'warning'),
                    'reason': onchain_alert.get('reason', ''),
                    'source': onchain_alert.get('source'),
                    'detected_at': datetime.now(timezone.utc).isoformat(),
                }
                r.setex(f'sentiment:alert:{symbol}', ONCHAIN_ALERT_TTL, json.dumps(alert_payload))
            elif plain_alert:
                r.setex(f'sentiment:alert:{symbol}', ALERT_TTL, str(plain_alert))
```

**3d. Update `print_summary()`** — after the existing `if alert:` line (line 181), add:

```python
        onchain = info.get('onchain_alert')
        if onchain and isinstance(onchain, dict):
            sev = onchain.get('severity', '?').upper()
            reason = onchain.get('reason', '')
            src = onchain.get('source', '')
            print(f'           ON-CHAIN [{sev}]: {reason} {src}')
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd scripts/strategy-lab && python -m pytest tests/test_x_sentiment.py -v
```

Expected: 4/4 PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/strategy-lab/x_sentiment.py scripts/strategy-lab/tests/test_x_sentiment.py
git commit -m "feat: add on-chain warning detection to x_sentiment.py"
```

---

## Task 2: Update auto-trade/route.ts — position protection

**Files:**
- Modify: `apps/web/src/app/api/auto-trade/route.ts`

### Background

Two changes needed:
1. **BUY-block** (lines 1340-1351): currently reads `sentiment:alert:{SYMBOL}` as a plain string. Must now parse JSON with string fallback (backward compat).
2. **Position monitoring loop** (after line 733): add on-chain alert check per open position. If severity=critical → force close. If severity=warning → tighten SL to entry price (once per alert, idempotent via Redis flag).

No new Telegram infrastructure: add a `sendTelegramAlert()` helper using Node's built-in `fetch`.

- [ ] **Step 1: Add `sendTelegramAlert` helper**

Find the section near the top of the file where other helper functions are defined (around the `addDailyPnl` function area). Add this helper:

```typescript
async function sendTelegramAlert(message: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message.slice(0, 4096),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
  } catch { /* non-critical */ }
}
```

- [ ] **Step 2: Update BUY-block to parse JSON alert (backward compat)**

Find lines 1340-1351 (the `// X sentiment alert check` block). Replace with:

```typescript
  // X sentiment alert check — reject if breaking negative news
  try {
    const baseAsset = signal.symbol.split('/')[0];
    const alertRaw = await redis.get(`sentiment:alert:${baseAsset}`) as string | null;
    if (alertRaw && signal.action === 'BUY') {
      let alertText = alertRaw;
      try {
        const parsed = JSON.parse(alertRaw);
        alertText = parsed.reason ?? alertRaw;
      } catch { /* not JSON — use as-is */ }
      const alertLower = alertText.toLowerCase();
      const alertKeywords = TOML?.sentiment?.alert_keywords ?? ['hack', 'exploit', 'rug', 'sec', 'crash', 'delist', 'lawsuit', 'ban', 'scam', 'fraud', 'investigation', 'vulnerability'];
      if (alertKeywords.some((kw: string) => alertLower.includes(kw))) {
        return { pass: false, reason: `X alert: ${alertText}` };
      }
    }
  } catch { }
```

- [ ] **Step 3: Add on-chain alert check in position monitoring loop**

Find the position monitoring loop. After the trailing stop check block (the `else if (pnl > 0 && currentPrice <= pos.trailingStop ...)` block, around line 729-732) and BEFORE `if (shouldSell) {`, add:

```typescript
      // On-chain alert check — tighten SL (warning) or force close (critical)
      if (!shouldSell) {
        try {
          const baseAsset = pos.symbol.split('/')[0];
          const alertRaw = await redis.get(`sentiment:alert:${baseAsset}`) as string | null;
          if (alertRaw) {
            let severity = 'warning';
            let reason = alertRaw;
            let source: string | null = null;
            try {
              const parsed = JSON.parse(alertRaw);
              severity = parsed.severity ?? 'warning';
              reason = parsed.reason ?? alertRaw;
              source = parsed.source ?? null;
            } catch { /* not JSON — treat as warning */ }

            const sourceLabel = source ? ` (${source})` : '';
            const notifiedKey = `onchain:notified:${pos.symbol}`;
            const alreadyNotified = await redis.get(notifiedKey);

            if (severity === 'critical') {
              shouldSell = true;
              exitReason = `On-chain alert (critical): ${reason}`;
              if (!alreadyNotified) {
                await redis.set(notifiedKey, '1', 'EX', 3600);
                await sendTelegramAlert(
                  `🚨 <b>Kritisk on-chain varning: ${pos.symbol}</b>\n\nKälla: ${source ?? 'okänd'}${sourceLabel}\nVarning: ${reason}\nÅtgärd: Position stängd (market sell)`
                );
              }
            } else {
              // warning: tighten SL to breakeven (entry - 0.05% for fees)
              const newSl = pos.entryPrice * 0.9995;
              if (newSl > pos.stopLoss && !alreadyNotified) {
                const oldSl = pos.stopLoss;
                pos.stopLoss = newSl;
                await redis.set(notifiedKey, '1', 'EX', 3600);
                console.log(`[MONITOR] On-chain warning ${pos.symbol}: SL ${oldSl.toFixed(4)} → ${newSl.toFixed(4)}`);
                await sendTelegramAlert(
                  `⚠️ <b>On-chain varning: ${pos.symbol}</b>\n\nKälla: ${source ?? 'okänd'}${sourceLabel}\nVarning: ${reason}\nÅtgärd: Stop-loss dragit till entry (${newSl.toFixed(4)})`
                );
              }
            }
          }
        } catch { /* non-critical — never block normal position monitoring */ }
      }
```

**Important:** The `if (!shouldSell)` guard prevents the alert check from interfering with a forced close that's already in progress.

- [ ] **Step 4: TypeScript type-check**

```bash
cd apps/web && pnpm type-check 2>&1 | head -30
```

Expected: no new errors related to the changes.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/api/auto-trade/route.ts
git commit -m "feat: on-chain alert position protection in auto-trade (tighten SL / force close)"
```

---

## Deployment

No new containers or services. The changes are live on next deploy:

```bash
# Deploy code
git archive --format=tar HEAD | ssh azureuser@openclaw-vm "cd ~/cryonix && tar xf -"

# Rebuild web container (auto-trade route changed)
ssh azureuser@openclaw-vm "cd ~/cryonix && docker compose -f docker-compose.prod.yml up -d --build web"

# x_sentiment.py runs as cron on VM host — no rebuild needed
```

### Verify

```bash
# Check x_sentiment dry-run shows on-chain field in output
python3 scripts/strategy-lab/x_sentiment.py --dry-run

# Check Redis after a live run
docker exec cryonix-redis-1 redis-cli GET sentiment:alert:BTC
```
