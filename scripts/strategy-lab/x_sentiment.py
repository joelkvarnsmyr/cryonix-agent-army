#!/usr/bin/env python3
"""
X/Twitter Sentiment Scanner via Grok (xAI)

Replaces the broken HTTP-based cron that called /api/x-sentiment every 15 min.
This script connects directly to Redis, bypassing Caddy -> Docker routing issues.

Mirrors the logic in apps/web/src/app/api/x-sentiment/route.ts:
  1. Calls Grok xAI API (grok-4-1-fast-non-reasoning) with live X/Twitter search
  2. Asks for sentiment scores (-3 to +3) for the watchlist
  3. Stores result in Redis key 'x-sentiment:latest' (900s TTL)
  4. Stores individual 'sentiment:{SYMBOL}' keys (3600s TTL)
  5. Stores 'sentiment:alert:{SYMBOL}' for breaking news (1800s TTL)

Usage:
  python3 scripts/strategy-lab/x_sentiment.py            # Run and write to Redis
  python3 scripts/strategy-lab/x_sentiment.py --dry-run   # Preview without writing
"""
import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone

# Allow running as script from project root
sys.path.insert(0, os.path.dirname(__file__))
from db import get_redis

from openai import OpenAI

WATCHLIST = ['BTC', 'ETH', 'SOL', 'XRP', 'AVAX', 'LINK', 'ADA', 'DOT', 'NEAR', 'SUI', 'ATOM', 'INJ', 'ARB', 'UNI', 'RENDER']

CACHE_TTL = 900       # 15 min for x-sentiment:latest
SYMBOL_TTL = 3600     # 1h for individual sentiment:{SYMBOL}
CONTEXT_TTL = 3600    # 1h for sentiment:context:{SYMBOL} (score + narrative)
ALERT_TTL = 1800      # 30 min for sentiment:alert:{SYMBOL} (legacy plain string)

# Severity-specific TTLs for structured on-chain alerts
SEVERITY_TTLS = {
    'info': 1800,       # 30 min
    'warning': 7200,    # 2h
    'critical': 21600,  # 6h
    'emergency': 43200, # 12h
}

# Severity ordering for comparison (higher = more severe)
SEVERITY_ORDER = {'info': 0, 'warning': 1, 'critical': 2, 'emergency': 3}

SYSTEM_PROMPT = (
    'You are a crypto market sentiment analyst with access to real-time X/Twitter data. '
    'Analyze current social sentiment for the requested cryptocurrencies. '
    'Be precise and data-driven.'
)


def build_user_prompt() -> str:
    symbols = ', '.join(WATCHLIST)
    return f"""Analyze the current X/Twitter sentiment for these cryptocurrencies: {symbols}

For each coin, provide:
1. Sentiment score (-3 to +3, where -3=extreme fear/bearish, +3=extreme greed/bullish)
2. Volume of discussion (low/medium/high)
3. Key narrative (one sentence: what are people talking about?)
4. Any breaking news or events
5. On-chain risk assessment: For each coin, search @lookonchain, @WhalAlert,
   @rektfeed, @OnchainLens for on-chain activity.

   CLASSIFICATION RULES:
   - SINGLE whale transfer to exchange = "info" (routine ~80% are benign:
     MM rebalancing, OTC settlement, cold wallet shuffling)
   - Only ESCALATE whale moves to "warning" when:
     * CLUSTER: multiple distinct wallets → same exchange within hours
     * MAGNITUDE: transfer > 5% of coin's daily volume
     * KNOWN SELLER: wallet identified as long-term holder (not MM/exchange)
   - HACK/EXPLOIT/RUG = always "critical" minimum
     * If funds actively draining = "emergency"
   - REGULATORY: SEC action, delist notice = "warning"
     * Confirmed enforcement action = "critical"

   FRESHNESS RULES:
   - Only report events from the LAST 4 HOURS
   - If a tweet references an event without clear timestamp: timing_uncertain=true
   - Old news (>4h) = "info" regardless of content

Return JSON only:
{{
  "BTC": {{"score": 1, "volume": "high", "narrative": "...", "alert": null, "onchain_alert": null}},
  "ETH": {{"score": -1, "volume": "medium", "narrative": "...", "alert": "hack reported",
           "onchain_alert": {{
             "severity": "critical",
             "reason": "Exploit reported on bridge contract",
             "source": "@rektfeed",
             "context": {{
               "direction": "to_exchange",
               "magnitude": "high",
               "wallet_type": "unknown",
               "cluster": false,
               "event_age": "minutes",
               "timing_uncertain": false
             }}
           }}
         }},
  ...
}}

onchain_alert severity rules:
- "emergency": active hack with funds draining, confirmed rug pull, exchange insolvency
- "critical": verified hack/exploit, smart contract vulnerability, confirmed fund drain
- "warning": cluster of whale deposits, SEC filing, negative regulatory news
- "info": single whale transfer, market maker rebalancing, cold wallet shuffle, old news (>4h)
- null: no on-chain concerns

For each alert, provide context:
- direction: "to_exchange" | "from_exchange" | "internal" | "unknown"
- magnitude: "low" (<1% daily vol) | "medium" (1-5%) | "high" (>5%)
- wallet_type: "exchange" | "market_maker" | "vc_fund" | "whale" | "unknown"
- cluster: true if multiple wallets making same move
- event_age: "minutes" | "hours" | "days" | "unknown"
- timing_uncertain: true if tweet doesn't have clear timestamp

Only include coins with notable sentiment. Skip coins with no meaningful X activity."""


def call_grok() -> dict:
    """Call xAI Grok API with live X/Twitter search enabled."""
    api_key = os.environ.get('XAI_API_KEY')
    if not api_key:
        print('ERROR: XAI_API_KEY not found in environment')
        sys.exit(1)

    client = OpenAI(api_key=api_key, base_url='https://api.x.ai/v1')

    print('[X-SENTIMENT] Calling Grok API (grok-4-1-fast-non-reasoning with live search)...')

    response = client.chat.completions.create(
        model='grok-4-1-fast-non-reasoning',
        messages=[
            {'role': 'system', 'content': SYSTEM_PROMPT},
            {'role': 'user', 'content': build_user_prompt()},
        ],
        temperature=0.2,
        max_tokens=800,
        extra_body={'search': {'mode': 'on'}},
    )

    content = response.choices[0].message.content or ''
    model_used = response.model or 'grok-4-1-fast-non-reasoning'
    tokens_used = response.usage.total_tokens if response.usage else 0

    # Extract JSON from response (may be wrapped in markdown code fences)
    json_match = re.search(r'\{[\s\S]*\}', content)
    if not json_match:
        print(f'ERROR: Failed to parse Grok response.\nRaw content:\n{content}')
        sys.exit(1)

    sentiment_data = json.loads(json_match.group(0))
    return {
        'sentiment_data': sentiment_data,
        'model': model_used,
        'tokens': tokens_used,
        'raw': content,
    }


def write_to_redis(r, sentiment_data: dict, model: str, tokens: int):
    """Write sentiment data to Redis with the same key schema as the TS route."""
    enriched = {
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'data': sentiment_data,
        'model': model,
        'tokens': tokens,
    }

    # Main key: x-sentiment:latest (900s TTL)
    r.set('x-sentiment:latest', json.dumps(enriched), ex=CACHE_TTL)

    # Individual sentiment scores + context (used by auto-trade)
    for symbol, info in sentiment_data.items():
        if isinstance(info, dict) and info.get('score') is not None:
            r.setex(f'sentiment:{symbol}', SYMBOL_TTL, str(info['score']))

            # Rich context for Grok AI validation prompt
            context = {
                'score': info['score'],
                'volume': info.get('volume', 'unknown'),
                'narrative': info.get('narrative', ''),
            }
            r.setex(f'sentiment:context:{symbol}', CONTEXT_TTL, json.dumps(context))

            # Alert flag: on-chain alert (JSON) takes priority over plain alert (string)
            onchain_alert = info.get('onchain_alert')
            plain_alert = info.get('alert')
            if onchain_alert and isinstance(onchain_alert, dict):
                new_severity = onchain_alert.get('severity', 'warning')
                context = onchain_alert.get('context', {})

                # Freshness guard: timing_uncertain → cap at info
                if isinstance(context, dict) and context.get('timing_uncertain'):
                    new_severity = 'info'

                new_severity_rank = SEVERITY_ORDER.get(new_severity, 1)
                ttl = SEVERITY_TTLS.get(new_severity, SEVERITY_TTLS['warning'])

                # Confirmation counter logic
                existing_raw = r.get(f'sentiment:alert:{symbol}')
                if existing_raw:
                    try:
                        existing = json.loads(existing_raw)
                        existing_severity = existing.get('severity', 'warning')
                        existing_rank = SEVERITY_ORDER.get(existing_severity, 1)
                        existing_count = existing.get('confirmed_count', 1)

                        if new_severity_rank == existing_rank:
                            # Same severity: increment confirmed_count, refresh TTL
                            existing['confirmed_count'] = existing_count + 1
                            existing['detected_at'] = datetime.now(timezone.utc).isoformat()
                            if context:
                                existing['context'] = context
                            r.setex(f'sentiment:alert:{symbol}', ttl, json.dumps(existing))
                            continue
                        elif new_severity_rank > existing_rank:
                            # Higher severity: replace, reset confirmed_count
                            pass  # fall through to create new alert below
                        else:
                            # Lower severity: keep existing (don't downgrade until TTL expires)
                            continue
                    except (json.JSONDecodeError, TypeError):
                        pass  # existing is plain string — overwrite with structured

                alert_payload = {
                    'severity': new_severity,
                    'reason': onchain_alert.get('reason', ''),
                    'source': onchain_alert.get('source'),
                    'detected_at': datetime.now(timezone.utc).isoformat(),
                    'confirmed_count': 1,
                    'context': context if isinstance(context, dict) else {},
                }
                r.setex(f'sentiment:alert:{symbol}', ttl, json.dumps(alert_payload))
            elif plain_alert:
                r.setex(f'sentiment:alert:{symbol}', ALERT_TTL, str(plain_alert))


def print_summary(sentiment_data: dict, model: str, tokens: int, dry_run: bool):
    """Print a formatted summary to stdout."""
    mode = 'DRY RUN' if dry_run else 'LIVE'
    now = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')

    print()
    print('=' * 65)
    print(f'  X/TWITTER SENTIMENT SCAN  [{mode}]')
    print(f'  {now}  |  Model: {model}  |  Tokens: {tokens}')
    print('=' * 65)

    if not sentiment_data:
        print('  No sentiment data returned.')
        print()
        return

    # Header
    print(f'  {"Symbol":<8} {"Score":>6} {"Volume":<8} {"Narrative"}')
    print(f'  {"-"*6:<8} {"-"*5:>6} {"-"*6:<8} {"-"*40}')

    for symbol in WATCHLIST:
        info = sentiment_data.get(symbol)
        if not info:
            continue
        score = info.get('score', '?')
        volume = info.get('volume', '?')
        narrative = info.get('narrative', '')
        alert = info.get('alert')

        # Score formatting with visual indicator
        if isinstance(score, (int, float)):
            if score > 0:
                score_str = f'+{score}'
            else:
                score_str = str(score)
        else:
            score_str = str(score)

        # Truncate narrative for display
        if len(narrative) > 55:
            narrative = narrative[:52] + '...'

        print(f'  {symbol:<8} {score_str:>6} {volume:<8} {narrative}')
        if alert:
            print(f'           ALERT: {alert}')
        onchain = info.get('onchain_alert')
        if onchain and isinstance(onchain, dict):
            sev = onchain.get('severity', '?').upper()
            reason = onchain.get('reason', '')
            src = onchain.get('source', '')
            ctx = onchain.get('context', {})
            ctx_parts = []
            if isinstance(ctx, dict):
                if ctx.get('direction'):
                    ctx_parts.append(f'dir={ctx["direction"]}')
                if ctx.get('magnitude'):
                    ctx_parts.append(f'mag={ctx["magnitude"]}')
                if ctx.get('cluster'):
                    ctx_parts.append('CLUSTER')
                if ctx.get('timing_uncertain'):
                    ctx_parts.append('TIMING_UNCERTAIN')
            ctx_str = f' ({", ".join(ctx_parts)})' if ctx_parts else ''
            print(f'           ON-CHAIN [{sev}]: {reason} {src}{ctx_str}')

    # Summary line
    scores = [
        info['score'] for info in sentiment_data.values()
        if isinstance(info, dict) and isinstance(info.get('score'), (int, float))
    ]
    if scores:
        avg = sum(scores) / len(scores)
        print()
        print(f'  Average sentiment: {avg:+.1f}  |  Coins covered: {len(scores)}/{len(WATCHLIST)}')

    # Redis key summary
    print()
    if dry_run:
        print('  [DRY RUN] Would write to Redis:')
    else:
        print('  Written to Redis:')

    print(f'    x-sentiment:latest          (TTL {CACHE_TTL}s)')
    for symbol, info in sentiment_data.items():
        if isinstance(info, dict) and info.get('score') is not None:
            print(f'    sentiment:{symbol:<6}              (TTL {SYMBOL_TTL}s) = {info["score"]}')
            if info.get('alert'):
                print(f'    sentiment:alert:{symbol:<6}        (TTL {ALERT_TTL}s) = {info["alert"]}')
            if info.get('onchain_alert') and isinstance(info.get('onchain_alert'), dict):
                sev = info['onchain_alert'].get('severity', '?')
                ttl = SEVERITY_TTLS.get(sev, SEVERITY_TTLS['warning'])
                print(f'    sentiment:alert:{symbol:<6} (on-chain [{sev}]) (TTL {ttl}s)')

    print()


def main():
    parser = argparse.ArgumentParser(description='X/Twitter Sentiment Scanner via Grok')
    parser.add_argument('--dry-run', action='store_true',
                        help='Show what would be written without touching Redis')
    args = parser.parse_args()

    # Call Grok API (always, even in dry-run, to test the API call)
    result = call_grok()
    sentiment_data = result['sentiment_data']
    model = result['model']
    tokens = result['tokens']

    print(f'[X-SENTIMENT] Grok returned sentiment for {len(sentiment_data)} coins')

    if not args.dry_run:
        r = get_redis()
        write_to_redis(r, sentiment_data, model, tokens)
        r.close()
        print(f'[X-SENTIMENT] Updated {len(sentiment_data)} coins in Redis')
    else:
        print('[X-SENTIMENT] Dry run — skipping Redis writes')

    # Print formatted summary
    print_summary(sentiment_data, model, tokens, args.dry_run)

    # Also print the compact log line matching the TS format
    scores_str = ', '.join(
        f'{k}:{v.get("score", "?")}'
        for k, v in sentiment_data.items()
        if isinstance(v, dict)
    )
    print(f'[X-SENTIMENT] Updated {len(sentiment_data)} coins: {scores_str}')


if __name__ == '__main__':
    main()
