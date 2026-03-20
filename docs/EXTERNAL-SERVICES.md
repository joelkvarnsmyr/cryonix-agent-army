# External APIs & Services — Cryonix Agent Army

Last updated: 2026-03-20

## Crypto Exchanges & DEX

| Service | Subsystem | Env var | Purpose | Auth |
|---------|-----------|---------|---------|------|
| Binance (CCXT) | Cryonix | `BINANCE_API_KEY/SECRET` | Market scanning + order execution | API key |
| Jupiter | Solanix, Copynix | — | Solana DEX swap quotes | None |
| Solana RPC (Helius) | Solanix, Copynix | `SOLANA_RPC_URL`, `HELIUS_API_KEY` | Blockchain read/write | API key |
| Alpaca | Aktienix | `ALPACA_PAPER_API_KEY/SECRET` | US stock trading (paper) | API key |

## Market Data & Intelligence

| Service | Subsystem | Env var | Purpose | Rate limit |
|---------|-----------|---------|---------|------------|
| CoinMarketCap | Cryonix | `CMC_API_KEY` | F&G index, market cap, global metrics | 10k/mo (free) |
| Coinglass | Cryonix | `COINGLASS_API_KEY` | Funding rates, OI, L/S ratio | — |
| CoinGecko | Solanix, Aktienix, Vedic | — | OHLC history, rankings | ~10/s (free) |
| DexScreener | Solanix, Copynix | — | DEX token prices, trending pools | ~100/min |
| GeckoTerminal | Copynix, Solanix | — | Trending pools (Solana) | Free |
| DexCheck | Copynix | `DEXCHECK_API_KEY` | Top trader leaderboards | 20k/mo |
| Dune Analytics | Copynix | `DUNE_API_KEY` | SQL blockchain queries | Varies |
| DefiLlama | Solanix | — | Token unlocks/emissions | Free |
| Finnhub | Aktienix, Psinix | `FINNHUB_API_KEY` | Stock data, earnings, economic calendar | 60/min |
| Helius | Copynix, Solanix | `HELIUS_API_KEY` | Wallet monitoring, tx history | 1M credits/mo (free) |
| Shyft | Copynix | `SHYFT_API_KEY` | Tx history (Helius fallback) | Free tier |
| QuickNode | Copynix (planned) | `QUICKNODE_SOLANA_URL` | Solana RPC backup | 10M credits/mo (free) |

## AI / LLM

| Service | Subsystem | Env var | Purpose |
|---------|-----------|---------|---------|
| Grok (xAI) | All | `XAI_API_KEY` | Signal validation, analysis, X search |
| Claude Code CLI | Cryonix, Aktienix | `~/.claude/` (Max plan) | Evolution mutations, brain analysis |

## Prediction Markets

| Service | Subsystem | Env var | Purpose |
|---------|-----------|---------|---------|
| Polymarket (Gamma API) | Polynix, Cryonix, Aktienix | — | Event data, sentiment, market discovery |
| Polymarket (CLOB API) | Polynix | — | Orderbook pricing, spread arb |

## Communication

| Service | Subsystem | Env var | Purpose |
|---------|-----------|---------|---------|
| Telegram Bot API | All | `TELEGRAM_INTERACTIVE_BOT_TOKEN`, `TELEGRAM_BOT_TOKEN` | Notifications, commands, alerts |
| Telegram Scraper (Telethon) | Cryonix | `TELEGRAM_API_ID/HASH/SESSION` | External signal channel scraping |
| Discord Webhook | Cryonix (optional) | `DISCORD_SIGNAL_WEBHOOK_URL` | Signal forwarding |

## News Feeds (RSS)

All feeds are free, no authentication required. Scanned every 15 minutes by NewsScoutTank.

| Source | Type | Items | Purpose |
|--------|------|-------|---------|
| Cointelegraph | Crypto | ~30 | Broad crypto coverage |
| The Block | Crypto | ~19 | Institutional focus, on-chain alerts |
| Decrypt | Crypto | ~56 | High volume, DeFi + altcoin coverage |
| Blockworks | Crypto+Macro | ~50 | Fed/rates + crypto crossover |
| CryptoSlate | Crypto | ~10 | Fast on exploits/hacks |
| Bitcoin Magazine | BTC | ~10 | Bitcoin-specific deep dives |
| DailyHodl | Crypto | ~10 | Whale alerts, whale movements |
| NYT Business | Macro | ~49 | Recession, tariffs, geopolitics |

## Databases & Infrastructure

| Service | Type | Purpose |
|---------|------|---------|
| PostgreSQL 15 | Relational DB | 20 tables — trades, positions, signals, config, evolution |
| Redis 7 | Cache + pub/sub | Queues, real-time state, WebSocket |
| Caddy | Reverse proxy | HTTP → dashboard routing |
| Docker | Container runtime | 14+ microservices on Azure VM (8GB RAM) |

## Per Subsystem Summary

| Subsystem | APIs |
|-----------|------|
| **Cryonix** | Binance, CMC, Coinglass, Polymarket, Grok, Telegram, RSS (8 feeds) |
| **Aktienix** | Alpaca, Finnhub, Grok, Telegram |
| **Solanix** | Helius, Jupiter, DexScreener, GeckoTerminal, CoinGecko, DefiLlama, Grok |
| **Copynix** | Helius, Shyft, Jupiter, DexScreener, GeckoTerminal, DexCheck, Dune, Grok, Telegram |
| **Polynix** | Polymarket (Gamma + CLOB), Grok |
| **Psinix** | Finnhub (SPY/QQQ/UUP), Polymarket |
| **Vedic** | CoinGecko, Telegram |

**Total: ~22 external services + 8 RSS feeds + 2 databases + infrastructure**
