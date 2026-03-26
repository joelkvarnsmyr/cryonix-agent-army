# 🏦 Market Manipulation

> Systematic tactics used to artificially distort crypto asset prices and trading volumes.

---

## 1. Pump and Dump

**What:** Coordinated buying campaign + social media hype to inflate a token's price, followed by mass sell-off by insiders.

**How it works:**
1. Insiders quietly accumulate a low-cap, low-liquidity token
2. Hype campaign launches across Telegram, X, Discord, YouTube
3. Retail investors FOMO in, driving price up 200-2000%
4. Insiders dump their bags at peak, price collapses 80-99%
5. Retail holders left with worthless tokens

**Scale:** ~3.59% of all tokens launched in 2024 showed P&D patterns. FBI's "Operation Token Mirrors" exposed a $25M P&D ring (18 charged).

**Red flags for Cryonix:**
- Sudden volume spike with no fundamental news
- Token appeared < 72h ago on DEX
- Only promoted in private Telegram groups
- Top 10 wallets hold > 50% of supply
- No locked liquidity

**Impact on us:** MarketScoutTank could detect false breakout patterns from a P&D. GainerScanner might boost a P&D token. X Sentiment could read fake hype as genuine sentiment.

---

## 2. Wash Trading

**What:** An entity buys and sells the same asset to itself to fake high volume.

**How it works:**
- Controlled wallets trade back and forth
- Creates illusion of demand and liquidity
- Often done by exchanges or market makers to inflate rankings
- Estimated $704M–$1.87B wash trading on ETH/BNB/Base in 2024
- ~25% of Polymarket trades were wash trades (peaked at 60% in Dec 2024)

**Red flags for Cryonix:**
- High volume but price barely moves (volume/price divergence)
- Volume concentrated in very few large equal-sized trades
- Volume spikes with no corresponding order book depth changes
- Token has high "reported" volume but low market cap

**Impact on us:** Our volume spike pattern detector in QuantGuild could be triggered by fake volume. CoinMarketCap data we ingest might reflect inflated volumes.

---

## 3. Spoofing

**What:** Placing large buy/sell orders with no intention to execute — just to trick other traders.

**How it works:**
1. Spoofer places massive buy order at $1.00 (creating "buy wall")
2. Other traders see strong support, buy above $1.00
3. Price rises, spoofer cancels the fake buy order
4. Spoofer sells at the higher price
5. Reverse scenario with "sell walls" to accumulate cheaply

**Red flags for Cryonix:**
- Large orders appearing and disappearing from order book
- Walls that move as price approaches them
- Order book depth that doesn't match actual fill rates

**Impact on us:** Our order book spread filter (max 0.3%) might pass a spoofed book that looks liquid but isn't.

---

## 4. Layering

**What:** Advanced version of spoofing — multiple fake orders placed at different price levels.

**How it works:**
- Multiple phantom orders stacked at various prices
- Creates convincing ramp of support/resistance
- More sophisticated and harder to detect than single spoofing
- Often automated by bots

**Red flags for Cryonix:**
- Symmetrical order stacks that appear/disappear in sync
- Orders that are consistently pulled before fill

---

## 5. Bear Raids

**What:** Intentional coordinated selling + FUD spreading to crash a token's price.

**How it works:**
1. Short positions or puts are opened
2. Large sell orders placed (real or spoofed)
3. Negative rumors/news spread across social media
4. Stop-losses triggered, panic selling ensues
5. Attackers buy back at lower prices or profit from shorts

**Red flags for Cryonix:**
- Simultaneous negative sentiment spike + volume surge
- FUD articles from unknown sources appearing at the same time
- Price drop without any verifiable fundamental catalyst

**Impact on us:** X Sentiment Scanner could see the artificial FUD and reject valid signals. NewsScoutTank could amplify bear raid FUD.

---

## 6. Cornering the Market

**What:** Accumulating enough supply of a token to control its price.

**How it works:**
- Whale quietly buys large % of circulating supply
- Restricts supply, driving price up
- Can set any ask price — no competition
- Rare in top coins, common in low-cap tokens

**Red flags for Cryonix:**
- Token with single wallet holding > 30% supply
- Unusual accumulation pattern on-chain
- Extremely thin order book despite moderate market cap

---

## Regulatory Landscape

- **EU MiCAR (Dec 2024):** Explicitly bans pump and dump, wash trading in crypto
- **US SEC:** Charged market makers for "market-manipulation-as-a-service" in 2024
- **FBI Operation Token Mirrors:** 18 charged, $25M seized (Oct 2024)
- **FATF 2025 guidance:** Blockchain analytics + public-private partnerships for enforcement

---

*→ Next: [02-whale-tactics.md](./02-whale-tactics.md)*
