"""
NewsScout Tank - Market Sentiment Analysis
Scans news RSS feeds, performs AI-powered sentiment analysis via GROK, and stores scores in Redis.
"""
import asyncio
import feedparser
import json
import os
import re
import time
from bs4 import BeautifulSoup
import redis.asyncio as aioredis
from typing import Dict, List, Set

try:
    import httpx
    HAS_HTTPX = True
except ImportError:
    HAS_HTTPX = False

from src.tanks.base import BaseTank, TankState
from src.core.config import get_toml

# --- CONFIGURATION ---

# RSS feeds — crypto + macro news sources
# Scanned every 15min. More feeds = better sentiment coverage.
# All verified free, no auth, returning valid RSS as of 2026-03-20.
RSS_FEEDS = {
    # Tier 1: Core crypto news
    "Cointelegraph": "https://cointelegraph.com/rss",
    "TheBlock": "https://www.theblock.co/rss.xml",
    "Decrypt": "https://decrypt.co/feed",
    "Blockworks": "https://blockworks.co/rss",
    # Tier 2: Supplementary crypto
    "CryptoSlate": "https://cryptoslate.com/feed/",
    "BitcoinMagazine": "https://bitcoinmagazine.com/feed",
    "DailyHodl": "https://dailyhodl.com/feed/",
    # Tier 3: Macro (Fed, rates, geopolitics → crypto correlation)
    "NYT_Business": "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml",
}

# Map trading symbols to keywords for searching in news articles
SYMBOL_KEYWORDS = {
    "BTC": {"bitcoin", "btc"},
    "ETH": {"ethereum", "eth"},
    "SOL": {"solana", "sol"},
    "BNB": {"bnb", "binance coin"},
    "XRP": {"xrp", "ripple"},
    "ADA": {"cardano", "ada"},
    "AVAX": {"avalanche", "avax"},
    "LINK": {"chainlink", "link"},
    "NEAR": {"near protocol", "near"},
    "DOGE": {"dogecoin", "doge"},
    "ARB": {"arbitrum", "arb"},
    "OP": {"optimism", "op"},
    "SUI": {"sui"},
    "ATOM": {"cosmos", "atom"},
    "ICP": {"internet computer", "icp"},
}

# Simple keyword-based sentiment analysis
POSITIVE_WORDS = {
    "bullish", "surge", "rally", "partnership", "upgrade", "launch", "adopt",
    "integrate", "support", "growth", "optimism", "gain", "rise", "boom",
    "approval", "recovery", "breakout", "accumulate", "institutional", "inflow",
    "rate cut", "dovish", "stimulus", "easing",
}
NEGATIVE_WORDS = {
    "bearish", "crash", "hack", "exploit", "ban", "regulation", "vulnerability",
    "lawsuit", "scam", "theft", "slump", "drop", "decline", "fear", "risk",
    "rug pull", "liquidation", "outflow", "dumping", "sell-off", "recession",
    "rate hike", "hawkish", "tariff", "sanction", "war", "inflation",
}

SENTIMENT_EXPIRATION_SECONDS = get_toml('sentiment', 'expiration_seconds', 3600)

class NewsScoutTank(BaseTank):
    """
    The 'NewsScout' Tank - The Ear to the Ground.

    Responsibilities:
    - Fetch news from RSS feeds
    - Analyze sentiment for relevant symbols
    - Store sentiment scores in Redis for other agents to use
    """

    def __init__(self, kv_url: str):
        super().__init__(name="NewsScout", symbols=[])
        self.redis_client = aioredis.from_url(kv_url, decode_responses=True)
        self.last_run_time = 0
        self.run_interval = get_toml('engine', 'news_scan_interval_seconds', 900)

    def should_run(self) -> bool:
        """Check if it's time to run the news scan."""
        return (time.time() - self.last_run_time) > self.run_interval

    def _get_clean_text(self, entry) -> str:
        """Extract and clean text from an RSS entry."""
        text = entry.get("title", "")
        summary = entry.get("summary", "")
        if summary:
            soup = BeautifulSoup(summary, "html.parser")
            text += " " + soup.get_text()
        return text.lower()

    def _calculate_sentiment(self, text: str) -> int:
        """Keyword-based sentiment fallback."""
        score = 0
        words = set(re.findall(r'\b\w+\b', text))
        score += len(words.intersection(POSITIVE_WORDS))
        score -= len(words.intersection(NEGATIVE_WORDS))
        return score

    async def _ai_sentiment_batch(self, headlines: List[Dict[str, str]]) -> Dict[str, int]:
        """Use GROK to analyze sentiment for a batch of headlines."""
        api_key = os.environ.get('XAI_API_KEY', '')
        if not api_key or not HAS_HTTPX or not headlines:
            return {}

        headline_text = "\n".join(
            f"- [{h['symbol']}] {h['text'][:120]}" for h in headlines[:20]
        )

        prompt = f"""Analyze these crypto/macro news headlines for trading signals.

Headlines:
{headline_text}

For each relevant symbol, return:
- score: -3 (very bearish) to +3 (very bullish)
- urgency: "immediate" (act now), "developing" (watch), "background" (context)
- event_type: "hack/exploit", "regulation", "partnership", "macro/fed", "whale_move", "technical", "adoption", "other"

Return JSON only:
{{"BTC": {{"score": 1, "urgency": "developing", "event_type": "macro/fed"}}, "ETH": {{"score": -2, "urgency": "immediate", "event_type": "hack/exploit"}}}}

Only include symbols with actionable signals. Ignore old/stale news."""

        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.post(
                    "https://api.x.ai/v1/chat/completions",
                    headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                    json={
                        "model": "grok-3-mini",
                        "messages": [
                            {"role": "system", "content": "You are a crypto market sentiment analyst. Respond with JSON only."},
                            {"role": "user", "content": prompt},
                        ],
                        "temperature": 0.1,
                        "max_tokens": 150,
                    }
                )
                data = resp.json()
                content = data.get('choices', [{}])[0].get('message', {}).get('content', '')
                # Parse nested JSON response
                # Try to find the outermost JSON object
                brace_count = 0
                start = -1
                for i, c in enumerate(content):
                    if c == '{':
                        if start == -1:
                            start = i
                        brace_count += 1
                    elif c == '}':
                        brace_count -= 1
                        if brace_count == 0 and start != -1:
                            try:
                                parsed = json.loads(content[start:i+1])
                                result = {}
                                for k, v in parsed.items():
                                    if k not in SYMBOL_KEYWORDS:
                                        continue
                                    if isinstance(v, dict):
                                        result[k] = v  # Full object with score, urgency, event_type
                                    elif isinstance(v, (int, float)):
                                        result[k] = {"score": int(v), "urgency": "background", "event_type": "other"}
                                return result
                            except json.JSONDecodeError:
                                pass
                            start = -1
                # Fallback: simple score extraction
                match = re.search(r'\{[^}]+\}', content)
                if match:
                    try:
                        scores = json.loads(match.group())
                        return {k: {"score": int(v), "urgency": "background", "event_type": "other"} for k, v in scores.items() if k in SYMBOL_KEYWORDS}
                    except (json.JSONDecodeError, ValueError):
                        pass
        except Exception as e:
            print(f"[{self.name}] AI sentiment failed: {e}")
        return {}

    async def process(self) -> Dict:
        """Main processing loop for the tank."""
        if not self.should_run():
            print(f"[{self.name}] Skipping run, not time yet.")
            return {"status": "skipped", "reason": "run_interval"}

        print(f"[{self.name}] Starting news sentiment analysis...")
        self.last_run_time = time.time()

        sentiment_scores: Dict[str, int] = {symbol: 0 for symbol in SYMBOL_KEYWORDS}
        all_headlines: List[Dict[str, str]] = []

        for source, url in RSS_FEEDS.items():
            try:
                print(f"[{self.name}] Fetching feed from {source}...")
                feed = feedparser.parse(url)
                if feed.bozo:
                    print(f"[{self.name}] Warning: Ill-formed RSS feed from {source}: {feed.bozo_exception}")

                for entry in feed.entries:
                    clean_text = self._get_clean_text(entry)

                    for symbol, keywords in SYMBOL_KEYWORDS.items():
                        if any(keyword in clean_text for keyword in keywords):
                            all_headlines.append({"symbol": symbol, "text": entry.get("title", "")})

                    entry_sentiment = self._calculate_sentiment(clean_text)
                    if entry_sentiment == 0:
                        continue
                    for symbol, keywords in SYMBOL_KEYWORDS.items():
                        if any(keyword in clean_text for keyword in keywords):
                            sentiment_scores[symbol] += entry_sentiment

            except Exception as e:
                print(f"[{self.name}] Error fetching or parsing {source}: {e}")

        # Try AI sentiment (overrides keyword scores with richer data)
        ai_enriched = {}
        if all_headlines:
            ai_scores = await self._ai_sentiment_batch(all_headlines)
            if ai_scores:
                print(f"[{self.name}] AI sentiment: {ai_scores}")
                for symbol, data in ai_scores.items():
                    if isinstance(data, dict):
                        sentiment_scores[symbol] = data.get("score", 0)
                        ai_enriched[symbol] = data
                    else:
                        sentiment_scores[symbol] = int(data)

        # Store in Redis — both simple score and enriched AI data
        try:
            pipeline = self.redis_client.pipeline()
            for symbol, score in sentiment_scores.items():
                # Simple score (backward compatible — auto-trade reads this)
                redis_key = f"sentiment:{symbol}"
                pipeline.setex(redis_key, SENTIMENT_EXPIRATION_SECONDS, str(score))

                # Enriched AI data (urgency + event_type for advanced filtering)
                if symbol in ai_enriched:
                    enriched = ai_enriched[symbol]
                    enriched_key = f"sentiment:enriched:{symbol}"
                    pipeline.setex(enriched_key, SENTIMENT_EXPIRATION_SECONDS, json.dumps(enriched))

                    # Immediate urgency alerts → separate key for fast detection
                    if enriched.get("urgency") == "immediate":
                        alert_key = f"sentiment:alert:{symbol}"
                        alert_data = json.dumps({
                            "severity": "critical" if enriched.get("event_type") in ("hack/exploit", "regulation") else "warning",
                            "reason": f"News alert: {enriched.get('event_type', 'unknown')}",
                            "score": enriched.get("score", 0),
                            "confirmed_count": 1,
                            "timestamp": time.time(),
                        })
                        pipeline.setex(alert_key, 1800, alert_data)  # 30 min TTL
                        print(f"[{self.name}] ALERT {symbol}: {enriched.get('event_type')} (urgency=immediate, score={enriched.get('score')})")

                if score != 0:
                    print(f"[{self.name}] {symbol}: score={score}" + (f" urgency={ai_enriched[symbol].get('urgency')} type={ai_enriched[symbol].get('event_type')}" if symbol in ai_enriched else ""))

            await pipeline.execute()
            print(f"[{self.name}] Sentiment updated: {sum(1 for s in sentiment_scores.values() if s != 0)} active, {len(ai_enriched)} AI-enriched.")
        except Exception as e:
            print(f"[{self.name}] Error storing sentiment in Redis: {e}")
            return {"status": "error", "error": str(e)}
            
        return {"status": "success", "sentiment_scores": sentiment_scores}

    async def run_loop(self):
        """Periodically runs the sentiment analysis process."""
        print(f"[{self.name}] Starting run loop.")
        while True:
            try:
                await self.process()
                # Sleep for 1 minute between checks. The internal logic already
                # ensures the main process only runs every 15 minutes.
                await asyncio.sleep(60)
            except Exception as e:
                print(f"[{self.name}] Error in run_loop: {e}")
                # Wait longer after an error before retrying
                await asyncio.sleep(300)
