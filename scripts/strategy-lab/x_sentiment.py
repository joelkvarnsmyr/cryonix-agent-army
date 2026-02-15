#!/usr/bin/env python3
"""
X/Twitter Sentiment Scanner via Grok (xAI)

Replaces the broken HTTP-based cron that called /api/x-sentiment every 15 min.
This script connects directly to Redis, bypassing Caddy -> Docker routing issues.

Mirrors the logic in apps/web/src/app/api/x-sentiment/route.ts:
  1. Calls Grok xAI API (grok-3-mini) with live X/Twitter search
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

WATCHLIST = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'NEAR', 'SUI', 'ARB', 'OP']

CACHE_TTL = 900       # 15 min for x-sentiment:latest
SYMBOL_TTL = 3600     # 1h for individual sentiment:{SYMBOL}
ALERT_TTL = 1800      # 30 min for sentiment:alert:{SYMBOL}

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

Return JSON only:
{{
  "BTC": {{"score": 1, "volume": "high", "narrative": "...", "alert": null}},
  "ETH": {{"score": -1, "volume": "medium", "narrative": "...", "alert": "hack reported"}},
  ...
}}

Only include coins with notable sentiment. Skip coins with no meaningful X activity."""


def call_grok() -> dict:
    """Call xAI Grok API with live X/Twitter search enabled."""
    api_key = os.environ.get('XAI_API_KEY')
    if not api_key:
        print('ERROR: XAI_API_KEY not found in environment')
        sys.exit(1)

    client = OpenAI(api_key=api_key, base_url='https://api.x.ai/v1')

    print('[X-SENTIMENT] Calling Grok API (grok-3-mini with live search)...')

    response = client.chat.completions.create(
        model='grok-3-mini',
        messages=[
            {'role': 'system', 'content': SYSTEM_PROMPT},
            {'role': 'user', 'content': build_user_prompt()},
        ],
        temperature=0.2,
        max_tokens=800,
        extra_body={'search': {'mode': 'on'}},
    )

    content = response.choices[0].message.content or ''
    model_used = response.model or 'grok-3-mini'
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

    # Individual sentiment scores (used by auto-trade)
    for symbol, info in sentiment_data.items():
        if isinstance(info, dict) and info.get('score') is not None:
            r.setex(f'sentiment:{symbol}', SYMBOL_TTL, str(info['score']))

            # Alert flag for high-priority events
            if info.get('alert'):
                r.setex(f'sentiment:alert:{symbol}', ALERT_TTL, str(info['alert']))


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
