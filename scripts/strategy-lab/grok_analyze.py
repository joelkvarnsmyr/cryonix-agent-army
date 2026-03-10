#!/usr/bin/env python3
"""
Grok Market Analyzer — Live market intelligence via xAI tools.

Pulls raw data from Postgres, Redis, and Telegram signals, then runs
Grok with x_search (X/Twitter) + web_search for real-time analysis.

Usage:
  python3 scripts/strategy-lab/grok_analyze.py                     # Full analysis
  python3 scripts/strategy-lab/grok_analyze.py --mode market        # Market overview
  python3 scripts/strategy-lab/grok_analyze.py --mode portfolio     # Portfolio analysis
  python3 scripts/strategy-lab/grok_analyze.py --mode social        # X/Twitter + Telegram
  python3 scripts/strategy-lab/grok_analyze.py --mode opportunity   # Find opportunities
  python3 scripts/strategy-lab/grok_analyze.py --ask "Is ETH a buy?" # Custom question
  python3 scripts/strategy-lab/grok_analyze.py --mode sentiment     # Multi-stage sentiment
"""

import os
import sys
import json
import argparse
from datetime import datetime, timedelta
from decimal import Decimal

# ── Helpers ──────────────────────────────────────────────────────────────────

def serialize(obj):
    """JSON serializer for datetime, Decimal, timedelta."""
    if isinstance(obj, datetime):
        return obj.isoformat()
    if isinstance(obj, Decimal):
        return float(obj)
    if isinstance(obj, timedelta):
        return str(obj)
    return str(obj)


def load_env():
    """Load .env file into os.environ."""
    env_file = os.path.join(os.path.dirname(__file__), "../../.env")
    if os.path.exists(env_file):
        with open(env_file) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip())


# ── Data Collectors ──────────────────────────────────────────────────────────

def get_postgres_data():
    """Pull trade history, signals, and performance from Postgres."""
    import psycopg2

    conn = psycopg2.connect(
        host=os.getenv("POSTGRES_HOST", "localhost"),
        port=int(os.getenv("POSTGRES_PORT", 5432)),
        dbname=os.getenv("POSTGRES_DB", "cryonix"),
        user=os.getenv("POSTGRES_USER", "postgres"),
        password=os.getenv("POSTGRES_PASSWORD", ""),
    )
    cur = conn.cursor()
    data = {}

    # Recent trades (7 days)
    cur.execute("""
        SELECT id, symbol, side, quantity, entry_price, exit_price, pnl,
               confidence, pattern, status, timestamp, reasoning
        FROM trades WHERE timestamp > NOW() - INTERVAL '7 days'
        ORDER BY timestamp DESC
    """)
    cols = [d[0] for d in cur.description]
    data["trades"] = [dict(zip(cols, row)) for row in cur.fetchall()]

    # Performance summary
    cur.execute("""
        SELECT
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE status = 'CLOSED' AND pnl > 0) as wins,
            COUNT(*) FILTER (WHERE status = 'CLOSED' AND pnl <= 0) as losses,
            COUNT(*) FILTER (WHERE status = 'FILLED') as open_trades,
            COALESCE(SUM(pnl) FILTER (WHERE status = 'CLOSED'), 0) as realized_pnl,
            COALESCE(AVG(pnl) FILTER (WHERE status = 'CLOSED' AND pnl > 0), 0) as avg_win,
            COALESCE(AVG(pnl) FILTER (WHERE status = 'CLOSED' AND pnl <= 0), 0) as avg_loss
        FROM trades WHERE timestamp > NOW() - INTERVAL '7 days'
    """)
    row = cur.fetchone()
    data["performance"] = dict(zip([d[0] for d in cur.description], row))

    # Per-pattern breakdown
    cur.execute("""
        SELECT pattern,
            COUNT(*) as trades,
            COUNT(*) FILTER (WHERE pnl > 0) as wins,
            COALESCE(SUM(pnl), 0) as total_pnl
        FROM trades
        WHERE timestamp > NOW() - INTERVAL '7 days' AND status = 'CLOSED'
        GROUP BY pattern ORDER BY total_pnl DESC
    """)
    data["pattern_performance"] = [
        dict(zip([d[0] for d in cur.description], row)) for row in cur.fetchall()
    ]

    # Evolution runs (last 3)
    try:
        cur.execute("""
            SELECT id, trigger_type, changes_summary, pnl_before, pnl_after, status, created_at
            FROM evolution_runs ORDER BY created_at DESC LIMIT 3
        """)
        data["evolution_runs"] = [
            dict(zip([d[0] for d in cur.description], row)) for row in cur.fetchall()
        ]
    except Exception:
        data["evolution_runs"] = []

    conn.close()
    return data


def get_redis_data():
    """Pull live state from Redis: positions, sentiment, calibration, telegram signals."""
    import redis as r

    red = r.Redis(
        host=os.getenv("REDIS_HOST", "localhost"), port=6379, decode_responses=True
    )
    data = {}

    # Open positions
    pos_raw = red.get("positions:open")
    data["positions"] = json.loads(pos_raw) if pos_raw else []

    # Sentiment scores
    sentiment = {}
    for key in red.scan_iter("sentiment:*"):
        if ":alert:" not in key:
            symbol = key.split(":")[-1]
            val = red.get(key)
            if val:
                try:
                    sentiment[symbol] = int(val)
                except (ValueError, TypeError):
                    sentiment[symbol] = val
    data["sentiment"] = sentiment

    # Sentiment alerts
    alerts = {}
    for key in red.scan_iter("sentiment:alert:*"):
        symbol = key.split(":")[-1]
        alerts[symbol] = red.get(key)
    data["alerts"] = alerts

    # X sentiment latest
    x_latest = red.get("x-sentiment:latest")
    data["x_sentiment"] = json.loads(x_latest) if x_latest else None

    # Calibration EV data
    cal_raw = red.get("calibration:patterns")
    data["calibration"] = json.loads(cal_raw) if cal_raw else None

    # Telegram signals (last 20)
    telegram_signals = []
    for key in red.scan_iter("telegram:signal:*"):
        val = red.get(key)
        if val:
            try:
                telegram_signals.append(json.loads(val))
            except (json.JSONDecodeError, TypeError):
                telegram_signals.append({"raw": val, "key": key})
    data["telegram_signals"] = telegram_signals[:20]

    # Pending trades
    pending = red.lrange("trades:pending", 0, -1)
    data["pending"] = [json.loads(p) for p in pending] if pending else []

    # Fear & Greed
    fg = red.get("cmc:fear_greed")
    data["fear_greed"] = json.loads(fg) if fg else None

    # Market regime
    data["regime"] = red.get("market:regime") or "unknown"

    # Cooldowns
    cooldowns = {}
    for key in red.scan_iter("cooldown:loss:*"):
        symbol = key.split(":")[-1]
        cooldowns[symbol] = red.get(key)
    data["cooldowns"] = cooldowns

    return data


# ── Grok Analysis Engine ────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are the chief analyst for Cryonix, an autonomous crypto trading system.
You trade USDC pairs on Binance SPOT only (BUY side). 15-minute timeframe.
Patterns: BOLLINGER_SQUEEZE, VOLUME_SPIKE_UP, RSI_OVERSOLD, MACD_BULLISH_CROSS, EMA_BULLISH_CROSS, DIP_BUY.
You have access to x_search (X/Twitter real-time posts) and web_search (web browsing).
Use BOTH tools proactively to find real-time information. Always search before answering.
Be direct, actionable, data-driven. No fluff."""

WATCHLIST = "BTC, ETH, SOL, XRP, AVAX, LINK, ADA, DOT, NEAR, SUI, ATOM, INJ, ARB, UNI, RENDER"


def build_context(pg_data, rd_data):
    """Build JSON context from all data sources."""
    return json.dumps(
        {
            "timestamp": datetime.utcnow().isoformat(),
            "performance": pg_data["performance"],
            "pattern_performance": pg_data["pattern_performance"],
            "recent_trades": [
                {k: v for k, v in t.items() if k != "reasoning"}
                for t in pg_data["trades"][:15]
            ],
            "open_positions": rd_data["positions"],
            "sentiment": rd_data["sentiment"],
            "alerts": rd_data["alerts"],
            "x_sentiment": rd_data["x_sentiment"],
            "calibration_ev": rd_data["calibration"],
            "telegram_signals": rd_data["telegram_signals"],
            "fear_greed": rd_data["fear_greed"],
            "market_regime": rd_data["regime"],
            "cooldowns": rd_data["cooldowns"],
            "pending": rd_data["pending"],
            "evolution_runs": pg_data["evolution_runs"],
        },
        default=serialize,
        indent=2,
    )


def get_mode_prompt(mode, context, rd_data):
    """Get mode-specific prompt."""
    positions_summary = json.dumps(rd_data["positions"], default=serialize)
    held_coins = [p["symbol"].split("/")[0] for p in rd_data["positions"]]
    pos_pnl = [
        f"{p['symbol']} ({p.get('pnlPct', 0):+.1f}%)" for p in rd_data["positions"]
    ]

    prompts = {
        "full": f"""Analyze our complete trading system. Here is all our data:

{context}

INSTRUCTIONS — use x_search AND web_search for each section:

1. PORTFOLIO HEALTH: Check each open position. Search X for breaking news on {', '.join(held_coins)}.
   Are there catalysts, FUD, whale movements? Should we hold or exit any?

2. PATTERN PERFORMANCE: Which patterns make money? Which lose? Specific parameter recommendations.

3. LIVE SENTIMENT: Search X for real-time crypto sentiment on our held coins AND watchlist ({WATCHLIST}).
   Look for: whale alerts, exchange inflows/outflows, upcoming events, partnership announcements.

4. MACRO OUTLOOK: Web search for: Fed policy, BTC ETF flows, regulatory news, macro events.
   Check Fear & Greed trend, BTC dominance, total market cap direction.

5. MISSED OPPORTUNITIES: What coins are pumping that we aren't in? Any dip buys available?

6. TELEGRAM SIGNALS: Cross-reference our external telegram signals with your analysis.

7. ACTION ITEMS: Specific, numbered recommendations. What to do RIGHT NOW.""",

        "market": f"""Give me a real-time market overview.

Current positions: {positions_summary}
Fear & Greed: {json.dumps(rd_data['fear_greed'], default=serialize)}
Watchlist: {WATCHLIST}

Search X for:
- Breaking crypto news in the last 6-12 hours
- Whale movements and large transfers
- Exchange listing/delisting announcements
- Trending coins and narratives

Search web for:
- Fed/macro news affecting crypto
- BTC ETF inflow/outflow data
- Major exchange announcements
- Regulatory developments

For each watchlist coin, rate: BULLISH / NEUTRAL / BEARISH with 1-line reasoning.
End with: Top 3 immediate opportunities and Top 3 risks.""",

        "portfolio": f"""Deep-dive our portfolio performance.

FULL DATA:
{context}

Search X for latest news on each held coin: {', '.join(held_coins)}

Analyze:
1. Each open position: entry quality, current trajectory, SL/TP adequacy, exit timing
2. Closed trades: what worked vs failed, categorize by exit type (SL/TP/trailing/stagnation)
3. Pattern effectiveness with win rates and expectancy
4. Position sizing efficiency (are we getting enough exposure?)
5. Risk metrics: max drawdown, Sharpe-like ratio, avg win/loss ratio
6. Specific cryonix.toml parameter changes to recommend""",

        "social": f"""Social media deep-dive. Use x_search EXTENSIVELY.

Held coins: {held_coins}
Watchlist: {WATCHLIST}
Our sentiment scores: {json.dumps(rd_data['sentiment'], default=serialize)}
Our X sentiment data: {json.dumps(rd_data['x_sentiment'], default=serialize)}
Telegram signals: {json.dumps(rd_data['telegram_signals'], default=serialize)}

Search X for EACH held coin — find:
- Latest news and announcements
- Whale wallet movements
- Influencer opinions (search for posts from crypto KOLs)
- FUD, hack rumors, regulatory threats
- Upcoming catalysts (upgrades, airdrops, token unlocks)

Then search X broadly for:
- What coins are trending RIGHT NOW on crypto Twitter?
- Any narratives gaining momentum (AI coins, RWA, DePIN, memecoins)?
- Compare our system sentiment vs actual X sentiment — are we calibrated?

Analyze Telegram signals — any strong external calls we should consider?""",

        "opportunity": f"""You are a crypto opportunity hunter. Search aggressively.

Our state:
- Capital: ~$50
- Open: {pos_pnl}
- Max 3 positions (all full)
- Patterns: BOLLINGER_SQUEEZE, VOLUME_SPIKE_UP, RSI_OVERSOLD, MACD_BULLISH_CROSS, DIP_BUY
- Binance SPOT, USDC pairs, 15min TF
- Calibration EV: {json.dumps(rd_data['calibration'], default=serialize)}

SEARCH X for:
- Coins with unusual volume spikes in last 6h
- Projects announcing partnerships, upgrades, or listings
- Coins that just had significant dips (>5%) — mean reversion plays
- New narratives forming (check what crypto Twitter is excited about)

SEARCH WEB for:
- Binance new listings or delistings
- Token unlock schedules this week
- DeFi TVL changes, protocol revenue trends
- Any coins breaking technical levels

Rank top 5 opportunities with:
- Symbol, entry zone, SL/TP levels
- Why now (catalyst)
- Risk assessment
- Which of our patterns would catch it

Also: any coins we should REMOVE from watchlist?""",

        "sentiment": f"""Multi-stage sentiment analysis for our portfolio.

STEP 1: Search X for posts about each of these coins in the last 12h:
{', '.join(held_coins + ['BTC', 'ETH', 'SOL'])}

For each coin, classify the X discussion:
- Volume: LOW / MEDIUM / HIGH (how much are people talking?)
- Tone: VERY_BEARISH (-2) / BEARISH (-1) / NEUTRAL (0) / BULLISH (+1) / VERY_BULLISH (+2)
- Key themes: what are people discussing?
- Notable accounts: any whales/KOLs posting about it?
- Red flags: hack rumors, SEC mentions, rug pull concerns?

STEP 2: Search web for macro sentiment:
- Crypto Fear & Greed trend (rising/falling?)
- BTC dominance trend
- Total market cap direction
- Risk-on vs risk-off in tradfi

STEP 3: Compare with our system data:
Our sentiment scores: {json.dumps(rd_data['sentiment'], default=serialize)}
Our alerts: {json.dumps(rd_data['alerts'], default=serialize)}

Are our scores accurate? Where do we disagree with X consensus?

STEP 4: Actionable output — for each held coin:
HOLD / ADD / REDUCE / EXIT with confidence level and reasoning.""",
    }
    return prompts.get(mode, prompts["full"])


def run_analysis(mode: str, custom_question: str = None):
    """Run Grok analysis with x_search + web_search tools."""
    from xai_sdk import Client
    from xai_sdk.chat import user, system
    from xai_sdk.tools import x_search, web_search

    # Collect data
    print("[DATA] Fetching Postgres data...", file=sys.stderr, flush=True)
    pg_data = get_postgres_data()
    print(
        f"[DATA] {len(pg_data['trades'])} trades, "
        f"{len(pg_data['pattern_performance'])} patterns",
        file=sys.stderr,
        flush=True,
    )

    print("[DATA] Fetching Redis data...", file=sys.stderr, flush=True)
    rd_data = get_redis_data()
    print(
        f"[DATA] {len(rd_data['positions'])} positions, "
        f"{len(rd_data['telegram_signals'])} telegram signals",
        file=sys.stderr,
        flush=True,
    )

    context = build_context(pg_data, rd_data)

    # Build prompt
    if custom_question:
        prompt = f"""Here is our complete trading system data:

{context}

QUESTION: {custom_question}

Use x_search and web_search to find real-time data before answering."""
    else:
        prompt = get_mode_prompt(mode, context, rd_data)

    # Configure tools with 24h lookback for X search
    x_tool = x_search(
        from_date=datetime.utcnow() - timedelta(hours=24),
    )
    web_tool = web_search()

    # Use grok-3-mini-fast for cost efficiency with reasoning
    model = "grok-4-1-fast-reasoning"
    print(
        f"\n[GROK] Calling {model} with x_search + web_search (mode: {mode})...",
        file=sys.stderr,
        flush=True,
    )

    client = Client(api_key=os.getenv("XAI_API_KEY"))
    chat = client.chat.create(
        model=model,
        tools=[x_tool, web_tool],
    )

    chat.append(system(SYSTEM_PROMPT))
    chat.append(user(prompt))

    # Stream response
    print("\n" + "=" * 80, flush=True)
    full_response = ""
    is_thinking = True

    for response, chunk in chat.stream():
        # Log tool calls
        for tool_call in chunk.tool_calls:
            args_preview = tool_call.function.arguments[:100]
            print(
                f"\n  🔍 {tool_call.function.name}({args_preview}...)",
                file=sys.stderr,
                flush=True,
            )

        # Show thinking progress
        if response.usage.reasoning_tokens and is_thinking:
            print(
                f"\r  🧠 Thinking... ({response.usage.reasoning_tokens} tokens)",
                end="",
                file=sys.stderr,
                flush=True,
            )

        # Transition from thinking to response
        if chunk.content and is_thinking:
            print("\n" + "=" * 80, file=sys.stderr, flush=True)
            is_thinking = False

        # Print response content
        if chunk.content:
            print(chunk.content, end="", flush=True)
            full_response += chunk.content

    # Citations
    if response.citations:
        print("\n\n📎 Sources:", flush=True)
        for i, c in enumerate(response.citations[:15], 1):
            print(f"  [{i}] {c}", flush=True)

    # Usage stats
    try:
        u = response.usage
        parts = []
        for attr in ["input_tokens", "prompt_tokens", "output_tokens", "completion_tokens", "reasoning_tokens"]:
            val = getattr(u, attr, None)
            if val:
                parts.append(f"{attr}={val}")
        if parts:
            print(f"\n\n📊 Usage: {', '.join(parts)}", file=sys.stderr, flush=True)
    except Exception:
        pass
    print("=" * 80, flush=True)

    return full_response


# ── Quick data dump (no Grok call) ───────────────────────────────────────���──

def dump_raw_data():
    """Dump raw data from all sources without calling Grok."""
    print("[DATA] Fetching all raw data...", file=sys.stderr, flush=True)
    pg_data = get_postgres_data()
    rd_data = get_redis_data()
    output = {
        "timestamp": datetime.utcnow().isoformat(),
        "postgres": pg_data,
        "redis": rd_data,
    }
    print(json.dumps(output, default=serialize, indent=2))


# ── CLI ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Grok Market Analyzer — Live xAI intelligence for Cryonix"
    )
    parser.add_argument(
        "--mode",
        choices=["full", "market", "portfolio", "social", "opportunity", "sentiment"],
        default="full",
        help="Analysis mode",
    )
    parser.add_argument("--ask", type=str, help="Custom question for Grok")
    parser.add_argument(
        "--raw", action="store_true", help="Dump raw data without Grok analysis"
    )
    args = parser.parse_args()

    load_env()

    if args.raw:
        dump_raw_data()
    else:
        run_analysis(args.mode, args.ask)
