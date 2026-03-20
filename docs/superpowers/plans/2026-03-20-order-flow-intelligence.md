# Order Flow Intelligence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development

**Goal:** Add 3 new intelligence sources inspired by Moon Dev's trading setup: liquidation cascades, order flow CVD, and Polynix whale detection.

**Architecture:** Each source writes to Redis. Cryonix auto-trade reads them in the multiplicative confidence model (Group B: Macro/Structural).

**Tech Stack:** Binance WebSocket (aggTrades), Coinglass API, Polymarket CLOB, Redis, TypeScript/Python

---

## Source A: Liquidation Cascade Detection

**What:** Track large liquidation events on Binance futures. $5M+ in long liquidations within 5 minutes = panic selling = potential dip-buy opportunity (after cascade ends). $5M+ in short liquidations = short squeeze = momentum signal.

**Data source:** Coinglass API (`COINGLASS_API_KEY` already in .env). Endpoint: `/api/futures/liquidation/v2/order` — real-time liquidation orders.

**Alternative:** Binance WebSocket `forceOrder` stream — free, no API key needed. Pushes every liquidation event in real-time.

**Redis keys:**
- `liquidation:cascade:{SYMBOL}` — `{ longs: $amount, shorts: $amount, netLiquidation: $amount, count: N, window: "5min", timestamp }`
- `liquidation:summary` — `{ totalLongs24h, totalShorts24h, largestEvent }`

**Cryonix integration:** In Group B of multiplicative model:
- Large long liquidations (>$5M/5min) + DIP_BUY pattern → +6% boost (capitulation buy)
- Large short liquidations (>$5M/5min) → +4% boost (squeeze momentum)
- Active cascade in progress → -8% penalty (don't buy during waterfall)

**Implementation:**
- File: `packages/engine/src/tanks/liquidation_scout.py` (NEW)
- Uses Binance WebSocket `wss://fstream.binance.com/ws/!forceOrder@arr` (free, no auth)
- Aggregates liquidations per symbol in 5-min rolling windows
- Writes to Redis every 30s

---

## Source B: Cumulative Volume Delta (CVD)

**What:** CVD = cumulative (buy volume - sell volume). When price drops but CVD rises → hidden buying (smart money accumulating) → strong dip-buy signal. When price rises but CVD drops → distribution → potential top.

**Data source:** Binance WebSocket `aggTrades` stream. Each trade has: price, qty, isBuyerMaker (true = sell, false = buy).

**Calculation:**
```
For each aggTrade:
  if isBuyerMaker == false: cvd += qty  (taker buy)
  if isBuyerMaker == true:  cvd -= qty  (taker sell)

CVD divergence = sign(price_change_5m) != sign(cvd_change_5m)
```

**Redis keys:**
- `cvd:{SYMBOL}` — `{ cvd_5m: +1234, cvd_15m: -567, price_change_5m: -0.5%, divergence: "bullish" | "bearish" | "none", timestamp }`

**Cryonix integration:** In Group A of multiplicative model (Market Sentiment):
- Bullish CVD divergence (price down, CVD up) → +8% boost
- Bearish CVD divergence (price up, CVD down) → -6% penalty

**Implementation:**
- File: `scripts/services/cvd-monitor.ts` (NEW)
- Binance WebSocket: `wss://stream.binance.com:9443/ws/btcusdt@aggTrade/ethusdt@aggTrade/solusdt@aggTrade`
- Aggregates in-memory, writes to Redis every 15s
- Docker service in docker-compose.prod.yml

---

## Source C: Polynix Whale Detection on Polymarket

**What:** Detect when whales accumulate positions on one side of a market while placing cover orders on the other side. "Classic manipulation: Whale accumulated DOWN cheap, used UP as cover."

**Detection logic:**
1. Fetch orderbook for YES and NO tokens
2. Compare bid/ask depth asymmetry
3. If one side has 10x more depth at tight spread → whale is market-making that side (their real position is the OTHER side)
4. Track large fills (>$500) and their direction

**Redis keys:**
- `polynix:whale:{conditionId}` — `{ dominantSide: "YES"|"NO", whaleSize: $amount, asymmetryRatio: 10.5, confidence: 75 }`

**Polynix integration:** In directional engine:
- If whale detected accumulating DOWN → reduce YES confidence, boost NO
- If whale detected accumulating UP → reduce NO confidence, boost YES

**Implementation:**
- File: `packages/agents/src/polynix/whale-detector.ts` (NEW)
- Called from polynix-agent.ts during market scan
- Fetches CLOB orderbook depth for both tokens
- Computes asymmetry ratio and whale signals

---

## Implementation Order

### Task 1: Liquidation Scout (Python, engine container)
- New tank: `liquidation_scout.py`
- Binance WebSocket `!forceOrder@arr`
- Aggregates in 5-min windows → Redis
- Wire into auto-trade Group B

### Task 2: CVD Monitor (TypeScript, new Docker service)
- New service: `cvd-monitor.ts`
- Binance WebSocket aggTrades for BTC/ETH/SOL
- Rolling 5m + 15m CVD + divergence detection → Redis
- Wire into auto-trade Group A

### Task 3: Polynix Whale Detector (TypeScript, polynix container)
- New module: `whale-detector.ts`
- Orderbook depth asymmetry analysis
- Wire into polynix directional engine

### Task 4: Deploy + Verify
- Docker compose update (cvd-monitor service)
- Engine rebuild (liquidation scout)
- Polynix rebuild (whale detector)
- Verify all 3 sources writing to Redis

---

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| WebSocket disconnect | Auto-reconnect with exponential backoff |
| Binance rate limits | aggTrades stream is free, no limits |
| Coinglass API limits | Fallback to Binance forceOrder stream |
| False whale signals | Require asymmetry ratio > 5x AND >$500 |
| CVD noise on low volume | Min volume threshold per 5-min window |
