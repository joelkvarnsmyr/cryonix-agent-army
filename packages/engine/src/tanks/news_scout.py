"""
NewsScout Tank - Market Sentiment Analysis
Scans news RSS feeds, performs sentiment analysis, and stores scores in Redis.
"""
import asyncio
import feedparser
import re
import time
from bs4 import BeautifulSoup
from redis import Redis
from typing import Dict, List, Set

from src.tanks.base import BaseTank, TankState

# --- CONFIGURATION ---

# RSS feeds from major crypto news sources
RSS_FEEDS = {
    "Cointelegraph": "https://cointelegraph.com/rss",
    "CoinDesk": "https://www.coindesk.com/arc/outboundfeeds/rss/",
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
    "integrate", "support", "growth", "optimism", "gain", "rise", "boom"
}
NEGATIVE_WORDS = {
    "bearish", "crash", "hack", "exploit", "ban", "regulation", "vulnerability",
    "lawsuit", "scam", "theft", "slump", "drop", "decline", "fear", "risk"
}

SENTIMENT_EXPIRATION_SECONDS = 3600  # 1 hour

class NewsScoutTank(BaseTank):
    """
    The 'NewsScout' Tank - The Ear to the Ground.

    Responsibilities:
    - Fetch news from RSS feeds
    - Analyze sentiment for relevant symbols
    - Store sentiment scores in Redis for other agents to use
    """

    def __init__(self, kv_url: str):
        super().__init__(name="NewsScout")
        self.redis_client = Redis.from_url(kv_url, decode_responses=True)
        self.last_run_time = 0
        self.run_interval = 900  # Run every 15 minutes

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
        """Calculate a simple sentiment score based on keywords."""
        score = 0
        words = set(re.findall(r'\b\w+\b', text))
        score += len(words.intersection(POSITIVE_WORDS))
        score -= len(words.intersection(NEGATIVE_WORDS))
        return score

    async def process(self) -> Dict:
        """Main processing loop for the tank."""
        if not self.should_run():
            print(f"[{self.name}] Skipping run, not time yet.")
            return {"status": "skipped", "reason": "run_interval"}

        print(f"[{self.name}] Starting news sentiment analysis...")
        self.last_run_time = time.time()

        sentiment_scores: Dict[str, int] = {symbol: 0 for symbol in SYMBOL_KEYWORDS}

        for source, url in RSS_FEEDS.items():
            try:
                print(f"[{self.name}] Fetching feed from {source}...")
                feed = feedparser.parse(url)
                if feed.bozo:
                    print(f"[{self.name}] Warning: Ill-formed RSS feed from {source}: {feed.bozo_exception}")

                for entry in feed.entries:
                    clean_text = self._get_clean_text(entry)
                    entry_sentiment = self._calculate_sentiment(clean_text)

                    if entry_sentiment == 0:
                        continue

                    # Check which symbols this news applies to
                    for symbol, keywords in SYMBOL_KEYWORDS.items():
                        if any(keyword in clean_text for keyword in keywords):
                            sentiment_scores[symbol] += entry_sentiment

            except Exception as e:
                print(f"[{self.name}] Error fetching or parsing {source}: {e}")

        # Store the aggregated sentiment scores in Redis
        try:
            pipeline = self.redis_client.pipeline()
            for symbol, score in sentiment_scores.items():
                redis_key = f"sentiment:{symbol}"
                pipeline.setex(redis_key, SENTIMENT_EXPIRATION_SECONDS, score)
                if score != 0:
                    print(f"[{self.name}] Stored sentiment for {symbol}: {score}")
            pipeline.execute()
            print(f"[{self.name}] Sentiment scores updated in Redis.")
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
