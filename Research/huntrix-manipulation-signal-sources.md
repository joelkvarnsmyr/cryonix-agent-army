# Huntrix Manipulation Signal Sources — Comprehensive Research

> Research compiled from 11 parallel agents + project codebase analysis + domain expertise.
> Date: 2026-03-20 (updated 2026-03-21 with final agent results)

---

## Executive Summary

Huntrix currently uses **3 signal sources**: Grok live X search, Telegram signal clusters (Redis), and CMC volume anomalies. This document identifies **40+ additional free/freemium signal sources** across 11 categories plus **20+ open-source tools and academic research** with reusable code. Priority recommendations focus on sources that are **free, API-accessible, and directly integrate** with our existing Redis/Postgres infrastructure.

---

## Current Huntrix Scanner Capabilities

**File:** `packages/agents/src/huntrix/manipulation-scanner.ts`

| Source | What It Does | Limitation |
|--------|-------------|------------|
| Grok Live X Search | Detects coordinated shilling, bot patterns, pump language | Rate-limited, Grok context window |
| Telegram Signal Clusters | Groups `telegram:signal:*` by symbol across channels | Only sees channels we monitor |
| CMC Volume Anomaly | Flags volume/mcap > 5x | 10min refresh, no real-time |

**Existing Telegram Scraper** (`scripts/telegram-scraper/`): Full Telethon MTProto integration with multi-format parser, Redis publishing, Postgres logging, channel quality tracking. **This is our biggest untapped asset** — we can monitor P&D groups directly.

---

## Signal Source Categories

### 1. RSS Feeds & News Manipulation Detection

**All feeds verified live (March 2026). Priority ordered by manipulation signal density.**

#### Tier 1 — Blockchain Security Firms (HIGHEST VALUE)

| Priority | Source | Feed URL | Signal Type |
|----------|--------|----------|-------------|
| 1 | Protos | `https://protos.com/feed/` | On-chain forensics, manipulation exposés, wash trading |
| 2 | Halborn Disclosures | `https://halborn.com/disclosures/feed.xml` | Zero-day vulnerability disclosures |
| 3 | Halborn Blog | `https://halborn.com/blog/feed.xml` | DeFi exploit post-mortems, oracle manipulation |
| 4 | Chainalysis Blog | `https://www.chainalysis.com/blog/feed/` | OFAC sanctions, Lazarus Group, money laundering |
| 5 | Elliptic Research | `https://www.elliptic.co/blog/rss.xml` | Sanctions evasion, stablecoin compliance |
| 6 | Immunefi | `https://medium.com/feed/immunefi` | Bug bounties, protocol vulnerability signals |
| 7 | Rekt News | `https://rekt.news/rss` | Exploit/hack post-mortems |

#### Tier 2 — Regulatory Bodies

| Priority | Source | Feed URL | Signal Type |
|----------|--------|----------|-------------|
| 8 | CFTC Enforcement | `https://www.cftc.gov/RSS/RSSENF/rssenf.xml` | US enforcement actions (crypto manipulation cases) |
| 9 | CFTC General | `https://www.cftc.gov/RSS/RSSGP/rssgp.xml` | Rule changes, market surveillance |
| 10 | FCA Warnings (UK) | `https://www.fca.org.uk/news/warnings/rss.xml` | Unauthorized firms, scam warnings (HIGH signal-to-noise) |
| 11 | FCA News (UK) | `https://www.fca.org.uk/news/rss.xml` | UK enforcement |
| — | OFAC SDN | `https://home.treasury.gov/system/files/126/sdn.xml` | Sanctioned crypto addresses (XML, daily) |

> **Note:** SEC EDGAR RSS returns 403 (blocked as of March 2026). CFTC feeds are working.

#### Tier 3 — Crypto News (filtered for manipulation relevance)

| Priority | Source | Feed URL | Signal Type |
|----------|--------|----------|-------------|
| 12 | CoinDesk | `https://www.coindesk.com/arc/outboundfeeds/rss/?outputType=xml` | Institutional/regulatory, exchange failures |
| 13 | CoinTelegraph (regulation) | `https://cointelegraph.com/rss/tag/regulation` | Regulation-tagged news |
| 14 | Decrypt | `https://decrypt.co/feed` | Investigative reporting, exploit coverage |
| 15 | Crypto Briefing (DeFi) | `https://cryptobriefing.com/category/defi/feed/` | DeFi exploits, protocol vulnerabilities |
| — | CryptoPanic API | `cryptopanic.com/api/v1/posts/` | Aggregated news with voting (5 req/min) |

#### Tier 4 — Cybersecurity (crypto-inclusive)

| Source | Feed URL | Signal Type |
|--------|----------|-------------|
| The Hacker News | `https://feeds.feedburner.com/TheHackersNews` | Wallet-targeting malware |
| The Record | `https://therecord.media/feed` | Nation-state crypto theft |
| Dark Reading | `https://www.darkreading.com/rss.xml` | C2 implants targeting wallets |

#### Sources WITHOUT working RSS (use Telegram/X monitoring instead)

- **PeckShield** — no RSS, use `@PeckShieldAlert` Telegram
- **SlowMist** — Medium feed returns 403, use `@SlowMist_Team` X
- **BlockSec** — Medium feed empty, use `@BlockSecTeam` Telegram
- **SEC** — EDGAR feeds return 403

**Implementation:** Add RSS polling to existing `NewsScoutTank` pattern or create dedicated `ManipulationNewsTank` in Python engine. Use `feedparser` (Python) for RSS/Atom parsing.

**Cross-source deduplication:** Critical gap identified in `08-cryonix-defense-mapping.md`. When 3+ sources publish near-identical articles within 30 minutes, flag as potential coordinated narrative attack.

---

### 2. On-Chain Whale Tracking

**Free APIs for detecting whale accumulation before pumps:**

| Source | API | What It Provides | Free Tier |
|--------|-----|-------------------|-----------|
| Whale Alert | `whale-alert.io/v1/transactions` | Large transfers (BTC, ETH, stablecoins) | 10 req/min, no auth |
| Etherscan | `api.etherscan.io/api` | ERC-20 transfers, token holders, contract verification | 5 calls/sec |
| DexScreener | `api.dexscreener.com/latest/dex/tokens/{addr}` | DEX pair data, liquidity, volume, price | Free, generous |
| Moralis | `deep-index.moralis.io/api/v2.2` | Token transfers, whale wallets, holder snapshots | Free: 40k CUs/day |
| Blocknative | `api.blocknative.com` | Mempool monitoring, pending large transactions | Free: 3 req/sec |
| Binance Large Trades | `api.binance.com/api/v3/aggTrades` | Aggregated trades on Binance (filter by qty) | 1200 weight/min |
| Binance Forced Liquidations | `fapi.binance.com/fapi/v1/forceOrders` | Futures liquidation events | Public, no auth |

**Detection patterns:**
- Whale accumulation + social hype = pump incoming
- Large exchange deposits after price rise = dump incoming
- Stablecoin inflows to exchange = buying pressure coming
- Sudden holder concentration increase = accumulation before pump

---

### 3. Telegram P&D Group Detection

**We already have Telethon MTProto integration.** Key extension points:

#### A. P&D Group Monitoring (extend existing scraper)
Add channels known for P&D activity. Detection signals:
- **Countdown timers:** "Pump starts in 5 minutes!" regex patterns
- **Coin reveal format:** "TARGET: $XXX" posted at exact times
- **FOMO language:** astronomical return promises, urgency words
- **Signal velocity:** 50+ messages in <2 minutes about same token
- **Micro-cap focus:** tokens not in top 500 by market cap

**Parser additions for `scripts/telegram-scraper/parser.py`:**
```python
PUMP_INDICATORS = [
    r'pump\s*(in|starts?|at)\s*\d+\s*(min|sec|hour)',
    r'target\s*[:=]\s*\$?\w+',
    r'\d+x\s*(potential|gains?|profit)',
    r'(guaranteed|easy|free)\s*(money|profit|gains)',
    r'(buy|load|accumulate)\s*(now|fast|quick|asap)',
    r'(moon|rocket|lambo|100x)',
]
```

#### B. CAS (Combot Anti-Spam) API
- **URL:** `api.cas.chat/check?user_id={id}`
- **Free, no auth required**
- Check if Telegram users in signal channels are known bots/spammers
- High bot ratio in a channel = low credibility

#### C. Channel Forensics
- Track message velocity per channel (Redis time-series)
- Detect coordinated posting patterns across channels
- Monitor admin changes (channel takeover indicator)
- Flag channels with high signal-to-noise ratio changes

#### D. Academic Research Integration
Academic papers like "The Anatomy of a Cryptocurrency Pump-and-Dump Scheme" have documented:
- Average time from coin reveal to price crash: **~70 seconds** for micro-caps
- Bot-driven pump groups have **10-100K+ members** providing exit liquidity
- Pumps follow predictable phases: accumulation → announcement → pump → dump
- **Key metric:** Seconds between announcement and first exchange trade = insider signal

---

### 4. Twitter/X Bot & Shill Detection

**Our existing Grok live search (`x_sentiment.py`) is the best free real-time option.** Extensions:

#### A. Grok API Enhancement (already integrated, extend prompt)
- Extend prompt to explicitly ask about coordinated posting patterns
- Ask "are multiple accounts pushing $TOKEN right now?"
- Ask about KOL shill patterns for specific tokens
- Models: `grok-3-mini` (~$0.30/M input), `grok-3` (~$3/M input)

#### B. X API v2 (paid, for deep analysis)

| Tier | Cost | Capability |
|------|------|------------|
| Free | $0 | 500 writes, limited reads, no search |
| Basic | ~$100/mo | Recent Search (7 days), 10k reads/mo |
| Pro | Pay-per-use | Full archive, filtered stream (1k rules), ~$0.15/1k tweets |

**Key endpoints for manipulation detection:**
- `GET /2/tweets/search/recent` — 450 req/15min, operators: `from:`, `has:hashtags`, `is:retweet`
- `GET /2/tweets/:id/retweeted_by` — check if amplifiers are fresh accounts
- `GET /2/users/by` — bulk lookup `created_at`, `public_metrics` for bot scoring

**Bot scoring without X API (heuristics for Grok prompt):**
- Account `created_at` < 30 days + high tweet volume = suspicious
- Identical tweet text across 5+ accounts = coordinated campaign
- High RT:reply ratio on unknown accounts = amplification bots
- Bio contains "DM for alpha" / "Signal group" / "100x gems"

#### C. Open-Source Bot Detection Tools

| Tool | Language | What It Does |
|------|----------|-------------|
| Botometer API | Python | Bot score 0-1 per account (**archived pre-June 2023**, useful for established accounts only) |
| CooRTweet | R | Detects coordinated retweet/link-sharing clusters (batch, open-source) |
| tweetbotornot | R | ML classifier, 93.8% accuracy (unmaintained since 2018) |

#### D. Paid Intelligence Feeds

| Source | Cost | What It Does |
|--------|------|-------------|
| Tree of Alpha | $500-2,500/mo | WebSocket feed monitoring 2k+ crypto X accounts in real-time |
| LunarCrush | Subscription | Social volume per token, influencer posts, AltRank |
| Social Blade | Contact for API | Follower growth patterns, spike detection |

**Key investigators to monitor (X accounts):**
- **@ZachXBT** — On-chain detective, exposes P&D schemes in real-time
- **@lookonchain** — Whale transaction tracking with context
- **@EmberCN** — Chinese market whale moves
- **@ai_9684xtpa** — Smart money flow tracking

---

### 5. DEX & DeFi Manipulation Detection

| Source | API | What It Detects |
|--------|-----|-----------------|
| GoPlus Security | `api.gopluslabs.io/api/v1/token_security/{chain}` | Honeypots, hidden mints, blacklists, proxy contracts | **Free, no auth** |
| DexScreener | `api.dexscreener.com/latest/dex/search?q={token}` | New pairs, liquidity locks, volume anomalies | **Free, generous** |
| Token Sniffer | `tokensniffer.com/api/v2/tokens/{chain}/{addr}` | Scam score (0-100), similar contracts, audit flags | Free: 20/min |
| RugCheck | `api.rugcheck.xyz/v1/tokens/{mint}` | Solana token risk assessment | Free |
| Uniswap Subgraph | `api.thegraph.com/subgraphs/name/uniswap/uniswap-v3` | Swap events, liquidity adds/removes, pool creation | Free: 100k queries/mo |
| Zeromev | `data.zeromev.org/` | MEV activity (sandwich attacks, frontrunning) | Free API |
| DeFi Llama | `api.llama.fi/` | Protocol TVL, TVL changes, yield data | **Free, no auth** |
| Forta Network | `api.forta.network/graphql` | Real-time exploit/manipulation alerts from 200+ detection bots | **Free, no auth** |

**GoPlus is the highest-value single source** — one API call returns:
- Is it a honeypot? Can you sell?
- Owner can mint new tokens? (infinite supply = rug)
- Has hidden transfer fees?
- Owner can modify tax/blacklist?
- Proxy contract? (can change logic)
- Top 10 holders concentration

---

### 6. Exchange Manipulation Detection (Wash Trading, Spoofing)

| Source | API | Detection |
|--------|-----|-----------|
| Binance Order Book | `api.binance.com/api/v3/depth?symbol={}&limit=1000` | Spoofing detection (large orders that disappear) |
| Binance WebSocket | `wss://stream.binance.com:9443/ws/{symbol}@depth@100ms` | Real-time order book changes |
| CoinGecko | `api.coingecko.com/api/v3/exchanges/{id}` | `trust_score_rank` per exchange | Free: 30 req/min |
| Messari | `data.messari.io/api/v1/assets/{symbol}/metrics` | `real_volume` vs reported volume | Free: 20 req/min |

**Spoofing detection algorithm (implementable with Binance WS):**
1. Monitor order book depth at 100ms intervals
2. Track large orders (>$50K) that appear and disappear within 5 seconds
3. If order disappeared without fill → spoof attempt
4. Correlate with price movement direction → manipulation intent

**Wash trading detection:**
- Volume/market cap ratio > 10x = suspicious
- Self-trade patterns (same qty buy/sell within seconds)
- Volume spikes without price movement = wash trading

---

### 7. Blockchain Exploit & Security Alerts

| Source | API/Feed | Alert Type |
|--------|----------|------------|
| Forta Network | GraphQL API | Real-time: flash loans, reentrancy, price oracle manipulation |
| PeckShield Alert | `@PeckShieldAlert` Telegram | Exploit alerts within minutes |
| BlockSec | `@BlockSecTeam` Telegram | Attack transaction analysis |
| CertiK Skynet | `skynet.certik.com` | Security scores, incident timeline |
| SlowMist | `@SlowMist_Team` Twitter | Hack alerts, stolen fund tracking |
| Immunefi | `immunefi.com/explore/` | Bug bounty programs (indicates audit status) |

**Forta Network is the most automation-friendly** — GraphQL API returns structured alerts:
```graphql
{
  alerts(input: {
    severities: [CRITICAL, HIGH],
    chainId: 1,
    first: 10
  }) {
    alerts {
      name
      description
      severity
      protocol
      source { bot { id } }
      metadata
    }
  }
}
```

---

### 8. Reddit Manipulation Detection

| Source | API | What It Detects |
|--------|-----|-----------------|
| Reddit API | `oauth.reddit.com/r/CryptoCurrency/new` | Coordinated posting, vote manipulation | Free: 100 req/min |
| Pushshift/Pullpush | `api.pullpush.io/reddit/search/submission` | Historical post/comment analysis | Free |
| LunarCrush | `lunarcrush.com/api3` | Social engagement metrics, Galaxy Score | Free: 2k credits/day |

**Detection patterns:**
- Sudden spike in posts about unknown token across multiple subreddits
- New accounts (< 7 days) posting "DD" about micro-caps
- Award bombing on promotional posts
- Cross-posting identical content to r/CryptoMoonShots + r/SatoshiStreetBets + r/altcoin

---

### 9. Sentiment Aggregation & Market Intelligence

| Source | API | Data Type | Free Tier |
|--------|-----|-----------|-----------|
| Alternative.me Fear & Greed | `api.alternative.me/fng/` | Market sentiment index (0-100) | **Free, no auth** |
| Santiment | `api.santiment.net/graphql` | Social volume, dev activity, whale alerts | Free: basic queries |
| CryptoQuant | `cryptoquant.com/` | Exchange flows, miner flows, stablecoin supply | Free: limited |
| Glassnode | `api.glassnode.com/v1/metrics` | On-chain metrics, SOPR, NUPL | Free: 26 basic metrics |
| Coinglass | `coinglass.com/` (scrape) | Liquidation data, open interest, funding rates | Limited free |
| Augmento | `api.augmento.ai/v0.1/` | 93 sentiment dimensions from social data | Free: 50 req/day |

**Key aggregation:** When Fear & Greed hits "Extreme Greed" (>80) AND social volume spikes for micro-caps → P&D risk elevated.

---

### 10. Regulatory & Governance Feeds

| Source | URL | Content |
|--------|-----|---------|
| SEC EDGAR Litigation | `efts.sec.gov/LATEST/search-index?q=cryptocurrency&dateRange=custom` | Enforcement actions |
| SEC Press Releases | `sec.gov/news/pressreleases.rss` | Regulatory announcements |
| CFTC Enforcement | `cftc.gov/PressRoom/PressReleases` | Crypto manipulation cases |
| OFAC SDN List | `home.treasury.gov/policy-issues/financial-sanctions/specially-designated-nationals-and-blocked-persons-list-sdn-human-readable-lists` | Sanctioned crypto addresses |
| ESMA Warnings | `esma.europa.eu/databases-library/warnings` | EU investor warnings |

**Historical case studies for detection pattern development:**
- **Save The Kids (2021):** Influencer token, team dumped on followers
- **John McAfee ICO pumps:** "Coin of the day" paid promotions → SEC charges
- **EthereumMax (Kim Kardashian):** Celebrity-promoted P&D
- **Atlas Trading / Zack Morris:** Discord-based penny stock/crypto pump scheme → SEC prosecution
- **Common pattern:** All followed accumulation → promotion → dump lifecycle

---

### 11. Open-Source Tools & Academic Research

#### A. Pump & Dump Detection (GitHub repos with code)

| Repo | Stars | Language | What It Does |
|------|-------|----------|-------------|
| [SystemsLab-Sapienza/pump-and-dump-dataset](https://github.com/SystemsLab-Sapienza/pump-and-dump-dataset) | 115 | Python | Rush order velocity, volume spikes, 5/15/25s windows. **Most cited P&D research.** Binance + Telegram data |
| [Bayi-Hu/Pump-and-Dump-Detection-on-Cryptocurrency](https://github.com/Bayi-Hu/Pump-and-Dump-Detection-on-Cryptocurrency) | 63 | Python | Sequence modeling: predicts next pump target from 50 prior P&Ds. SIGMOD 2023. 1,335 samples, 709 confirmed P&Ds |
| [Derposoft/crypto_pump_and_dump_with_deep_learning](https://github.com/Derposoft/crypto_pump_and_dump_with_deep_learning) | 56 | Python | CLSTM, Transformer, AnomalyTransformer. Outperforms La Morgia 2020 |
| [Robert-Ciborowski/PumpBot](https://github.com/Robert-Ciborowski/PumpBot) | 27 | Python+JS | TensorFlow neural net, Discord alerts. Incomplete but architecture useful |

**Best paper (no code yet):** [arxiv:2412.18848](https://arxiv.org/html/2412.18848v1) — BERTweet Telegram classifier (F1=0.982 on 91K messages) + Z-score order book + XGBoost. 55% top-5 accuracy 20s before pump.

#### B. Order Book & Spoofing Detection

| Repo | Stars | Language | What It Does |
|------|-------|----------|-------------|
| [Ayushk-05/order-book-trap-detector](https://github.com/Ayushk-05/order-book-trap-detector) | 1 | Python | Spoofing, buy/sell walls, bull/bear traps. **Uses CCXT (same as our engine!)** |
| [iuliagroza/spoof.io](https://github.com/iuliagroza/spoof.io) | 7 | Python+TS | PPO reinforcement learning on L3 order book. Rolling-statistics feature set is extractable |
| [rapmd73/fwoba](https://github.com/rapmd73/fwoba) | 17 | Shell | Frequency-weighted order book analysis. P&D + spoofing + spread widening |
| [orderbooktools/crobat](https://github.com/orderbooktools/crobat) | 54 | Python | Order Flow Imbalance (OFI) — academic-grade microstructure |

#### C. Anomaly Detection Frameworks

| Repo | Stars | Language | What It Does |
|------|-------|----------|-------------|
| [yzhao062/pyod](https://github.com/yzhao062/pyod) | 9,800+ | Python | **45+ algorithms** (IForest, LOF, AutoEncoder, LSTM-AE). Scikit-learn API. Production-ready |
| [awatson246/crypto-anomaly-detection-policy](https://github.com/awatson246/crypto-anomaly-detection-policy) | 3 | Python | GNN on Elliptic++ dataset + LLM explanations |

#### D. Wash Trading & Sybil Detection

| Repo | Stars | Language | What It Does |
|------|-------|----------|-------------|
| [Bill0412/nft-wash-trading-detection](https://github.com/Bill0412/nft-wash-trading-detection) | 2 | Python | DFS cycle detection for circular trading (O(E) complexity) |
| [NethermindEth/wash-trade-detection-bot](https://github.com/NethermindEth/wash-trade-detection-bot) | — | TypeScript | Forta bot: buyer funded by seller = circular. **Native TS!** |
| [ArbitrumFoundation/sybil-detection](https://github.com/ArbitrumFoundation/sybil-detection) | 270 | Python | Louvain community detection for coordinated wallet clusters |

#### E. Bot Detection & Network Analysis

| Repo | Stars | Language | What It Does |
|------|-------|----------|-------------|
| [forta-network/forta-bot-sdk](https://github.com/forta-network/forta-bot-sdk) | 73 | TypeScript | On-chain anomaly detection SDK. `handleTransaction`/`handleBlock` pattern |
| [NethermindEth/Forta-Agents](https://github.com/NethermindEth/Forta-Agents) | — | TypeScript | 50+ bots: MEV tracker, flash loan detector, Tornado Cash monitor |
| [graphsense](https://github.com/graphsense) | 130 | Python | Full cryptoasset analytics platform (heavy infra) |
| [git-disl/EllipticPlusPlus](https://github.com/git-disl/EllipticPlusPlus) | 135 | Notebook | 203K Bitcoin transactions labeled illicit/licit. Training dataset for GNN |

#### F. Sentiment Analysis

| Repo | Stars | Language | What It Does |
|------|-------|----------|-------------|
| [cjhutto/vaderSentiment](https://github.com/cjhutto/vaderSentiment) | 4,500+ | Python | Rule-based sentiment (-1 to +1). No training needed. Works on short social text |

#### Integration Priority Matrix

| Tool | Effort | Value | Best Target |
|------|--------|-------|-------------|
| `order-book-trap-detector` (CCXT spoofing) | **Low** | **High** | QuantGuild new detector |
| `PyOD` IForest (anomaly scoring) | **Low** | **High** | RiskGate pre-filter |
| `pump-and-dump-dataset` (rush order features) | **Low** | **High** | QuantGuild confidence modifier |
| `BERTweet` Telegram classifier | Medium | **High** | telegram-scraper filter |
| `sybil-detection` Louvain clustering | Medium | **High** | Copynix leader wallet vetting |
| `vaderSentiment` | **Low** | Medium | Augment `x_sentiment.py` |
| `wash-trade-detection-bot` (TypeScript) | Medium | Medium | Solanix/Copynix on-chain |
| `Forta SDK` + MEV Tracker | Medium | Medium | Solanix sandwich detection |
| `Elliptic++` + GNN | High | High (long-term) | Copynix wallet classification |

---

## Priority Implementation Roadmap

### Phase 1: Free, Immediate (Week 1)

**Highest ROI additions to Huntrix scanner:**

1. **GoPlus Security API** — Token safety check before any entry
   - No auth, free, instant
   - One call tells us: honeypot, hidden mint, proxy, holder concentration
   - **Integration:** Add to `manipulation-scanner.ts` pre-trade check

2. **DexScreener API** — Real-time DEX pair data
   - No auth, free, generous limits
   - New pair detection, liquidity depth, volume anomalies
   - **Integration:** New scanner function in `manipulation-scanner.ts`

3. **Forta Network** — Exploit/manipulation alerts
   - No auth, free GraphQL API
   - Real-time alerts from 200+ community detection bots
   - **Integration:** Poll every 60s, publish to `huntrix:forta_alerts` Redis key

4. **Extend Telegram Scraper** — P&D group monitoring
   - We already have Telethon integration
   - Add P&D keyword detection to parser.py
   - Add countdown timer / coin reveal pattern matching
   - Add channel velocity tracking (messages/minute)
   - **Integration:** New Redis keys `huntrix:telegram:pump_alerts`

5. **Alternative.me Fear & Greed** — Already partially integrated via CMCScout
   - Cross-reference with social volume for extreme greed + micro-cap hype detection

### Phase 2: Moderate Effort (Week 2-3)

6. **Binance WebSocket Order Book** — Spoofing detection
   - Monitor depth changes at 100ms for tracked symbols
   - Flag large orders that appear/disappear without fills

7. **CryptoPanic API** — News aggregation with voting
   - Free tier (5 req/min) provides community-voted sentiment
   - Compare with our RSS sentiment for divergence detection

8. **Whale Alert** — Large transaction tracking
   - 10 req/min, no auth
   - Correlate large exchange inflows with social hype

9. **Reddit API** — Coordinated promotion detection
   - Track sudden post volume for unknown tokens
   - Cross-reference with Telegram/X signals

10. **Regulatory RSS feeds** — SEC/CFTC enforcement alerts
    - Zero cost, pure RSS polling
    - Early warning on regulatory action affecting tokens

### Phase 3: Advanced (Month 2+)

11. **Binance Order Book Spoofing ML** — Historical pattern learning
12. **On-chain Holder Analysis** — Wallet concentration tracking via Etherscan/Moralis
13. **Academic P&D detection models** — Implement research paper algorithms
14. **Cross-platform correlation engine** — RSS + X + Telegram + Reddit + on-chain convergence scoring
15. **MEV detection** — Sandwich attack monitoring via Zeromev/Flashbots

---

## Existing Infrastructure Leverage

### What We Already Have (reuse, don't rebuild)

| Component | Location | Reuse For |
|-----------|----------|-----------|
| Telegram MTProto client | `scripts/telegram-scraper/scraper.py` | P&D group monitoring, extend parser |
| Multi-format signal parser | `scripts/telegram-scraper/parser.py` | Add pump indicators, countdown detection |
| Redis pub/sub infrastructure | `packages/engine/`, `apps/web/` | All new signals publish to Redis |
| Postgres signal storage | `telegram_signals` table | Store manipulation alerts |
| Grok AI analysis | `manipulation-scanner.ts` | Validate suspicious signals with AI |
| CMC market data | `cmc:mcap:*` Redis keys | Market cap/volume baseline for anomaly detection |
| Channel quality tracking | `telegram_channels` table | Track P&D group accuracy |
| CCXT Binance connection | `packages/engine/src/core/market_data.py` | Order book data, large trade detection |

### New Redis Key Schema

```
huntrix:goplus:{symbol}          — Token security data (1h TTL)
huntrix:dexscreener:{pair}       — DEX pair data (5min TTL)
huntrix:forta:alerts             — Recent Forta alerts (1h TTL)
huntrix:telegram:pump_alerts     — P&D detection alerts (30min TTL)
huntrix:whale:transfers          — Large transfer alerts (15min TTL)
huntrix:spoofing:{symbol}        — Order book spoofing flags (10min TTL)
huntrix:regulatory:alerts        — SEC/CFTC enforcement (24h TTL)
huntrix:social:velocity:{symbol} — Cross-platform mention velocity (15min TTL)
```

---

## Key Investigators & Monitors

Sources to follow/scrape for real-time manipulation exposure:

| Who | Platform | Why |
|-----|----------|-----|
| ZachXBT | X/Twitter | On-chain detective, exposes P&D in real-time |
| Coffeezilla | YouTube | Deep investigative reports on crypto fraud |
| @lookonchain | X/Twitter | Whale transaction tracking with context |
| @PeckShieldAlert | Telegram/X | Exploit alerts within minutes |
| @BlockSecTeam | Telegram/X | Attack analysis |
| @EmberCN | X/Twitter | Chinese market whale moves |
| @ai_9684xtpa | X/Twitter | Smart money flow tracking |

**Actionable:** Add these to Huntrix's Grok live search queries as context sources.

---

## Architecture Decision

**Recommended approach:** Extend `manipulation-scanner.ts` with modular scanner functions rather than building separate services. Each source gets its own async function:

```
ManipulationScanner
├── scanGrokLive()          ← existing
├── scanTelegramClusters()  ← existing
├── scanCMCVolumeAnomaly()  ← existing
├── scanGoPlusSecurity()    ← NEW Phase 1
├── scanDexScreener()       ← NEW Phase 1
├── scanFortaAlerts()       ← NEW Phase 1
├── scanTelegramPumps()     ← NEW Phase 1 (extend scraper)
├── scanWhaleTransfers()    ← NEW Phase 2
├── scanOrderBookSpoofing() ← NEW Phase 2
├── scanRedditCoordination()← NEW Phase 2
└── scanRegulatoryFeeds()   ← NEW Phase 2
```

All scanners publish to Redis. Huntrix runner aggregates and scores across all sources.

---

---

## P&D Warning Signs — Detection Patterns

Based on observed manipulation tactics across platforms:

### Platforms Where Manipulation Originates
1. **Telegram VIP Groups** — Closed groups selling "premium signals" (often P&D coordination)
2. **Discord Alpha Groups** — Server-based pump coordination with tiered access
3. **Crypto Twitter/X** — KOL paid promotions, bot amplification rings
4. **TikTok/Instagram** — "Lifestyle" accounts promoting micro-cap tokens

### Red Flags (detectable via Huntrix scanners)

| Red Flag | Detection Method | Scanner |
|----------|-----------------|---------|
| Astronomical return promises ("100x guaranteed") | Regex on Telegram/X text | `scanTelegramPumps()` |
| Micro-cap focus (tokens not in top 500) | CMC market cap check | `scanCMCVolumeAnomaly()` |
| FOMO language ("last chance", "don't miss out") | NLP sentiment + keyword matching | `scanGrokLive()` |
| Countdown timers ("pump in 5 minutes") | Regex pattern detection | `scanTelegramPumps()` |
| No fundamental analysis (pure hype, no tech/team discussion) | Content quality scoring via Grok | `scanGrokLive()` |
| Coordinated posting (same message across channels) | Cross-channel dedup + velocity tracking | `scanTelegramClusters()` |
| Sudden volume spike without news catalyst | Volume/news correlation | `scanCMCVolumeAnomaly()` + RSS |

### Detection Tools Already Available (free)

| Tool | Purpose | Integration Status |
|------|---------|-------------------|
| DexScreener | New pair detection, liquidity depth | Phase 1 (planned) |
| DEXTools | Chart patterns, trading history | Manual only |
| Whale Alert | Large transfers preceding pumps | Phase 2 (planned) |
| Token Sniffer | Contract audit score (0-100) | Phase 1 (planned) |
| RugCheck | Solana token risk assessment | Phase 1 (Solanix) |
| GoPlus Security | Honeypot detection, hidden mints | Phase 1 (planned) |

---

## Summary Statistics

- **Total verified signal sources:** 60+
- **Free/no-auth APIs:** 15+ (GoPlus, DexScreener, Forta, DeFi Llama, Alternative.me, CFTC RSS, FCA RSS, etc.)
- **Verified RSS feeds:** 20+ (15 confirmed working, 5 blocked/stale)
- **Open-source GitHub repos:** 20+ with reusable code
- **Academic papers with code:** 5+ (P&D detection, order book analysis, sybil detection)
- **Immediate integration candidates (low effort, high value):** 6 (GoPlus, DexScreener, Forta, PyOD IForest, order-book-trap-detector, VADER)

---

*This research document should be updated as new sources are discovered or API availability changes.*
*Last updated: 2026-03-21*
