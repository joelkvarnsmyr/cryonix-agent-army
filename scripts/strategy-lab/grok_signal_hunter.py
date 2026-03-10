#!/usr/bin/env python3
"""
Grok Signal Hunter — Auto-discovers opportunities and injects signals.

Runs Grok with x_search + web_search to find crypto opportunities,
then injects qualifying signals into Redis trades:pending for the
auto-trader to pick up (which re-validates via Grok before executing).

Usage:
  python3 scripts/strategy-lab/grok_signal_hunter.py              # Hunt + inject
  python3 scripts/strategy-lab/grok_signal_hunter.py --dry-run     # Hunt without injecting
  python3 scripts/strategy-lab/grok_signal_hunter.py --top 3       # Inject top 3 only

Cron (every 30 min):
  */30 * * * * cd ~/cryonix && python3 scripts/strategy-lab/grok_signal_hunter.py >> /tmp/signal-hunter.log 2>&1
"""

import os
import sys
import json
import re
import argparse
import time
from datetime import datetime, timedelta
from decimal import Decimal

# ── Helpers ──────────────────────────────────────────────────────────────────

VALID_PATTERNS = [
    "BOLLINGER_SQUEEZE", "VOLUME_SPIKE_UP", "RSI_OVERSOLD",
    "MACD_BULLISH_CROSS", "EMA_CROSS_UP", "DIP_BUY",
    "DEEP_VALUE_CRASH", "MOMENTUM_GAINER",
]

def serialize(obj):
    if isinstance(obj, datetime):
        return obj.isoformat()
    if isinstance(obj, Decimal):
        return float(obj)
    if isinstance(obj, timedelta):
        return str(obj)
    return str(obj)


def load_env():
    """Load .env from project root."""
    env_paths = [
        os.path.join(os.path.dirname(__file__), '..', '..', '.env'),
        '/home/azureuser/cryonix/.env',
    ]
    for p in env_paths:
        if os.path.exists(p):
            with open(p) as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith('#') and '=' in line:
                        k, v = line.split('=', 1)
                        os.environ.setdefault(k.strip(), v.strip())
            break


def get_postgres_data():
    """Pull recent trades and pattern performance."""
    import psycopg2
    conn = psycopg2.connect(
        host=os.getenv('POSTGRES_HOST', 'localhost'),
        port=os.getenv('POSTGRES_PORT', '5432'),
        dbname=os.getenv('POSTGRES_DB', 'cryonix'),
        user=os.getenv('POSTGRES_USER', 'postgres'),
        password=os.getenv('POSTGRES_PASSWORD', ''),
    )
    cur = conn.cursor()

    # Recent closed trades (7 days)
    cur.execute("""
        SELECT symbol, side, entry_price, exit_price, pnl, pattern, confidence,
               status, timestamp
        FROM trades
        WHERE timestamp > NOW() - INTERVAL '7 days'
        ORDER BY timestamp DESC LIMIT 30
    """)
    cols = [d[0] for d in cur.description]
    trades = [dict(zip(cols, row)) for row in cur.fetchall()]

    # Pattern win rates
    cur.execute("""
        SELECT pattern,
               COUNT(*) as total,
               SUM(CASE WHEN CAST(pnl AS FLOAT) > 0 THEN 1 ELSE 0 END) as wins,
               SUM(CAST(pnl AS FLOAT)) as total_pnl
        FROM trades
        WHERE status = 'CLOSED' AND timestamp > NOW() - INTERVAL '30 days'
        GROUP BY pattern
    """)
    cols2 = [d[0] for d in cur.description]
    patterns = [dict(zip(cols2, row)) for row in cur.fetchall()]

    conn.close()
    return {"trades": trades, "pattern_performance": patterns}


def get_redis_data():
    """Pull live state: positions, calibration, sentiment."""
    import redis as r
    red = r.Redis(
        host=os.getenv('REDIS_HOST', 'localhost'),
        port=int(os.getenv('REDIS_PORT', '6379')),
        decode_responses=True,
    )
    data = {}

    # Open positions
    pos_raw = red.get('positions:open')
    data['positions'] = json.loads(pos_raw) if pos_raw else []

    # Calibration EV
    cal_raw = red.get('calibration:patterns')
    data['calibration'] = json.loads(cal_raw) if cal_raw else {}

    # Sentiment
    sentiment = {}
    for key in red.scan_iter('sentiment:*'):
        if ':alert:' not in key:
            sym = key.split(':')[-1]
            val = red.get(key)
            if val:
                try:
                    sentiment[sym] = json.loads(val)
                except (json.JSONDecodeError, TypeError):
                    sentiment[sym] = val
    data['sentiment'] = sentiment

    # Fear & Greed
    fg_raw = red.get('cmc:fear_greed')
    data['fear_greed'] = json.loads(fg_raw) if fg_raw else None

    # Telegram signals
    telegram_signals = []
    for key in red.scan_iter('telegram:signal:*'):
        val = red.get(key)
        if val:
            try:
                telegram_signals.append(json.loads(val))
            except (json.JSONDecodeError, TypeError):
                pass
    data['telegram_signals'] = telegram_signals[:15]

    # X sentiment
    x_raw = red.get('x-sentiment:latest')
    data['x_sentiment'] = json.loads(x_raw) if x_raw else None

    # Cooldowns (avoid re-hunting recently lost symbols)
    cooldowns = []
    for key in red.scan_iter('cooldown:loss:*'):
        cooldowns.append(key.split(':')[-1])
    data['loss_cooldowns'] = cooldowns

    return data, red


def build_hunt_prompt(pg_data, rd_data):
    """Build the structured prompt for Grok signal hunting."""
    positions = rd_data['positions']
    pos_summary = []
    held_symbols = []
    for p in positions:
        pnl_pct = p.get('pnlPct', 0)
        pos_summary.append(f"  {p['symbol']}: entry ${p['entryPrice']}, pnl {pnl_pct:+.1f}%, pattern {p.get('pattern','?')}")
        held_symbols.append(p['symbol'])

    pos_text = '\n'.join(pos_summary) if pos_summary else '  (no positions)'
    slots_free = max(0, 3 - len(positions))

    # Pattern performance
    pat_text = []
    for pp in pg_data['pattern_performance']:
        wr = (float(pp['wins']) / float(pp['total']) * 100) if pp['total'] else 0
        pat_text.append(f"  {pp['pattern']}: {pp['total']} trades, {wr:.0f}% WR, PnL ${float(pp['total_pnl'] or 0):.2f}")
    pat_summary = '\n'.join(pat_text) if pat_text else '  (no data)'

    # Cooldowns
    cooldown_text = ', '.join(rd_data['loss_cooldowns']) if rd_data['loss_cooldowns'] else 'none'

    return f"""You are a crypto signal hunter for an automated trading bot on Binance SPOT (USDC pairs, 15min timeframe).

CURRENT STATE:
- Open positions ({len(positions)}/3, {slots_free} slots free):
{pos_text}
- Loss cooldown (cannot trade): {cooldown_text}
- Held symbols (skip these): {', '.join(held_symbols) if held_symbols else 'none'}
- Calibration EV: {json.dumps(rd_data['calibration'], default=serialize)}
- Fear & Greed: {json.dumps(rd_data['fear_greed'], default=serialize)}
- X Sentiment: {json.dumps(rd_data.get('x_sentiment'), default=serialize)}
- Telegram signals: {json.dumps(rd_data['telegram_signals'][:5], default=serialize)}

PATTERN PERFORMANCE (last 30 days):
{pat_summary}

YOUR TASK:
Search X (Twitter) and the web RIGHT NOW for:
1. Coins with unusual volume spikes or breakouts in the last 6 hours
2. Projects with fresh catalysts (partnerships, upgrades, listings, airdrops)
3. Coins that dipped >5% and are showing mean-reversion signals
4. Strong narratives forming in crypto Twitter
5. Any Binance USDC pairs showing technical setups

RULES:
- Only suggest Binance SPOT pairs with /USDC suffix
- Do NOT suggest coins we already hold: {', '.join(held_symbols)}
- Do NOT suggest coins on cooldown: {cooldown_text}
- Confidence must be 0.60-0.95 (be realistic, not everything is a gem)
- stop_loss should be 3-7% below entry, target 5-15% above entry
- pattern must be one of: {', '.join(VALID_PATTERNS)}
- Maximum {max(slots_free, 2)} signals (prioritize quality)

RESPOND WITH ONLY THIS JSON (no markdown, no explanation before/after):
{{
  "signals": [
    {{
      "symbol": "SOL/USDC",
      "action": "BUY",
      "confidence": 0.82,
      "entry_price": 87.50,
      "stop_loss": 82.00,
      "target_price": 95.00,
      "pattern": "VOLUME_SPIKE_UP",
      "reasoning": "Brief catalyst + technical reason"
    }}
  ],
  "exit_recommendations": [
    {{
      "symbol": "ARB/USDC",
      "action": "EXIT",
      "reason": "Why exit this position"
    }}
  ],
  "market_note": "Brief overall market assessment"
}}

If no good opportunities exist right now, return {{"signals": [], "exit_recommendations": [], "market_note": "reason"}}"""


def parse_grok_response(text):
    """Extract JSON from Grok's response (may have markdown wrapping)."""
    # Try direct parse first
    try:
        return json.loads(text.strip())
    except json.JSONDecodeError:
        pass

    # Try extracting from ```json ... ``` blocks
    match = re.search(r'```(?:json)?\s*(\{.*?\})\s*```', text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError:
            pass

    # Try finding first { to last }
    start = text.find('{')
    end = text.rfind('}')
    if start >= 0 and end > start:
        try:
            return json.loads(text[start:end + 1])
        except json.JSONDecodeError:
            pass

    return None


def validate_signal(sig, held_symbols, cooldowns):
    """Validate a single signal before injection."""
    errors = []

    if not sig.get('symbol', '').endswith('/USDC'):
        errors.append(f"invalid symbol: {sig.get('symbol')}")
    if sig.get('action') != 'BUY':
        errors.append(f"not a BUY signal: {sig.get('action')}")
    if sig.get('symbol') in held_symbols:
        errors.append(f"already holding {sig['symbol']}")

    # Check cooldowns (symbol format: SOL/USDC vs cooldown key: SOL/USDC)
    sym = sig.get('symbol', '')
    if sym in cooldowns or sym.replace('/USDC', '') in cooldowns:
        errors.append(f"{sym} on loss cooldown")

    conf = sig.get('confidence', 0)
    if not (0.55 <= conf <= 0.99):
        errors.append(f"confidence out of range: {conf}")

    pattern = sig.get('pattern', '')
    if pattern not in VALID_PATTERNS:
        errors.append(f"invalid pattern: {pattern}")

    entry = sig.get('entry_price', 0)
    sl = sig.get('stop_loss', 0)
    tp = sig.get('target_price', 0)
    if entry <= 0 or sl <= 0 or tp <= 0:
        errors.append("missing price levels")
    elif sl >= entry:
        errors.append(f"SL ({sl}) >= entry ({entry})")
    elif tp <= entry:
        errors.append(f"TP ({tp}) <= entry ({entry})")

    return errors


def inject_signal(red, sig):
    """Inject a validated signal into Redis trades:pending."""
    signal_payload = {
        "symbol": sig['symbol'],
        "action": "BUY",
        "confidence": sig['confidence'],
        "entry_price": sig['entry_price'],
        "stop_loss": sig['stop_loss'],
        "target_price": sig['target_price'],
        "pattern": sig['pattern'],
        "patterns": [sig['pattern']],
        "reasoning": f"[GROK-HUNTER] {sig.get('reasoning', 'AI-discovered opportunity')}",
        "indicators": {
            "rsi": 50.0,
            "adx": 30.0,
            "volume_ratio": 1.5,
            "market_regime": "trending",
        },
        "timestamp": int(time.time() * 1000),
        "source": "grok_signal_hunter",
    }
    red.rpush('trades:pending', json.dumps(signal_payload))
    return signal_payload


def run_hunt(dry_run=False, top_n=3):
    """Main hunt loop: analyze → parse → validate → inject."""
    from xai_sdk import Client
    from xai_sdk.chat import user, system
    from xai_sdk.tools import x_search, web_search

    print(f"\n{'='*60}", flush=True)
    print(f"[HUNTER] Signal hunt started at {datetime.utcnow().isoformat()}", flush=True)
    print(f"[HUNTER] Mode: {'DRY RUN' if dry_run else 'LIVE INJECTION'}", flush=True)

    # Collect data
    print("[HUNTER] Fetching market data...", flush=True)
    pg_data = get_postgres_data()
    rd_data, red = get_redis_data()

    held_symbols = [p['symbol'] for p in rd_data['positions']]
    slots_free = max(0, 3 - len(rd_data['positions']))
    print(f"[HUNTER] {len(rd_data['positions'])} positions, {slots_free} free slots", flush=True)

    if slots_free == 0:
        print("[HUNTER] All slots full — will still hunt for rotation candidates", flush=True)

    # Build prompt and call Grok
    prompt = build_hunt_prompt(pg_data, rd_data)

    x_tool = x_search(from_date=datetime.utcnow() - timedelta(hours=12))
    web_tool = web_search()

    model = "grok-4-1-fast-reasoning"
    print(f"[HUNTER] Calling {model} with x_search + web_search...", flush=True)

    client = Client(api_key=os.getenv("XAI_API_KEY"))
    chat = client.chat.create(model=model, tools=[x_tool, web_tool])
    chat.append(system("You are a crypto signal hunter. Return ONLY valid JSON. No markdown wrapping."))
    chat.append(user(prompt))

    full_response = ""
    for response, chunk in chat.stream():
        for tool_call in chunk.tool_calls:
            args_preview = tool_call.function.arguments[:80]
            print(f"  🔍 {tool_call.function.name}({args_preview}...)", flush=True)
        if chunk.content:
            full_response += chunk.content

    # Usage stats
    try:
        u = response.usage
        tokens = []
        for attr in ["prompt_tokens", "completion_tokens", "reasoning_tokens"]:
            val = getattr(u, attr, None)
            if val:
                tokens.append(f"{attr}={val}")
        if tokens:
            print(f"[HUNTER] Tokens: {', '.join(tokens)}", flush=True)
    except Exception:
        pass

    # Parse response
    parsed = parse_grok_response(full_response)
    if not parsed:
        print(f"[HUNTER] ERROR: Could not parse Grok response:", flush=True)
        print(full_response[:500], flush=True)
        return {"injected": 0, "errors": ["parse_failed"]}

    signals = parsed.get('signals', [])
    exits = parsed.get('exit_recommendations', [])
    market_note = parsed.get('market_note', '')

    print(f"\n[HUNTER] Market note: {market_note}", flush=True)
    print(f"[HUNTER] Found {len(signals)} signals, {len(exits)} exit recommendations", flush=True)

    # Validate and inject signals
    injected = []
    rejected = []

    for sig in signals[:top_n]:
        errors = validate_signal(sig, held_symbols, rd_data['loss_cooldowns'])
        if errors:
            print(f"  ❌ {sig.get('symbol', '?')}: {', '.join(errors)}", flush=True)
            rejected.append({"symbol": sig.get('symbol'), "errors": errors})
            continue

        print(f"  ✅ {sig['symbol']}: conf={sig['confidence']:.0%}, "
              f"entry=${sig['entry_price']}, SL=${sig['stop_loss']}, TP=${sig['target_price']}, "
              f"pattern={sig['pattern']}", flush=True)
        print(f"     Reason: {sig.get('reasoning', 'n/a')}", flush=True)

        if not dry_run:
            payload = inject_signal(red, sig)
            print(f"  💉 Injected into trades:pending (auto-trader picks up in ~30s)", flush=True)
            injected.append(payload)
        else:
            print(f"  🏜️ DRY RUN — not injected", flush=True)
            injected.append(sig)

    # Log exit recommendations
    if exits:
        print(f"\n[HUNTER] Exit recommendations:", flush=True)
        for ex in exits:
            print(f"  ⚠️ EXIT {ex.get('symbol', '?')}: {ex.get('reason', 'n/a')}", flush=True)
            if not dry_run:
                # Store exit recs in Redis for rotation engine to consume
                red.set(
                    f"hunter:exit:{ex.get('symbol', 'UNKNOWN')}",
                    json.dumps({"reason": ex.get('reason'), "timestamp": time.time()}),
                    ex=1800,  # 30min TTL
                )

    # Summary
    result = {
        "timestamp": datetime.utcnow().isoformat(),
        "injected": len(injected),
        "rejected": len(rejected),
        "exit_recommendations": len(exits),
        "market_note": market_note,
        "signals": injected,
        "dry_run": dry_run,
    }

    # Store hunt result in Redis for dashboard/monitoring
    if not dry_run:
        red.set('hunter:last_run', json.dumps(result, default=serialize), ex=3600)

    print(f"\n[HUNTER] Done: {len(injected)} injected, {len(rejected)} rejected", flush=True)
    print(f"{'='*60}\n", flush=True)

    return result


# ── CLI ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Grok Signal Hunter")
    parser.add_argument("--dry-run", action="store_true", help="Analyze without injecting")
    parser.add_argument("--top", type=int, default=3, help="Max signals to inject (default: 3)")
    args = parser.parse_args()

    load_env()

    if not os.getenv("XAI_API_KEY"):
        print("[HUNTER] ERROR: XAI_API_KEY not set", file=sys.stderr)
        sys.exit(1)

    result = run_hunt(dry_run=args.dry_run, top_n=args.top)
    print(json.dumps(result, default=serialize, indent=2))
