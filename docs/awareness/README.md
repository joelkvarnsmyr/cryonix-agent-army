# 🛡️ Cryonix Awareness Module

> **"Vet the signal, not the hype."**

This module documents **every known manipulation tactic, scam technique, and disinformation vector** used in the crypto ecosystem. The purpose is to make Cryonix's autonomous agents — and the humans behind them — fully aware of how markets are gamed, so we never act on poisoned data.

## Why This Exists

Cryonix ingests data from RSS feeds, Telegram channels, X/Twitter, CoinMarketCap, and on-chain sources. Every single one of these channels can be — and regularly is — weaponized by bad actors. This module serves as our **threat encyclopedia**: a living reference that informs how we build filters, validate signals, and protect capital.

## Structure

| Category | File | What It Covers |
|----------|------|----------------|
| 🏦 Market Manipulation | [01-market-manipulation.md](./01-market-manipulation.md) | Pump & dump, wash trading, spoofing, layering, bear raids |
| 🐋 Whale Tactics | [02-whale-tactics.md](./02-whale-tactics.md) | Order book walls, stop hunts, liquidity grabs, fake breakouts |
| 🔗 On-Chain Exploits | [03-onchain-exploits.md](./03-onchain-exploits.md) | Rug pulls, honeypots, snipers, MEV, sandwich attacks |
| 📱 Social Media Manipulation | [04-social-media-manipulation.md](./04-social-media-manipulation.md) | Telegram, Discord, X scams, impersonation, fake groups |
| 📰 News & RSS Weaponization | [05-news-rss-weaponization.md](./05-news-rss-weaponization.md) | Fake news, SEO spam, coordinated narrative attacks |
| 🤖 AI-Powered Fraud | [06-ai-powered-fraud.md](./06-ai-powered-fraud.md) | Deepfakes, fake trading bots, AI-generated FUD/FOMO |
| 💰 Influencer & KOL Manipulation | [07-influencer-kol-manipulation.md](./07-influencer-kol-manipulation.md) | Paid shills, undisclosed promotions, shill thread playbook |
| 🧠 Cryonix Defense Mapping | [08-cryonix-defense-mapping.md](./08-cryonix-defense-mapping.md) | How each threat maps to our pipeline and what defenses exist |

## How To Use

1. **Before building any new data ingestion** — check this module for known attack vectors on that data source.
2. **When a suspicious signal appears** — cross-reference patterns described here.
3. **During Evolution Engine runs** — the AI Brain should be aware of these manipulation patterns when analyzing trade performance.
4. **For new team members** — read end to end as onboarding material.

## Key Statistics (2024-2025)

- **$9B+** lost to crypto fraud in 2024 (66% increase YoY)
- **3.59%** of all launched tokens showed pump-and-dump patterns
- **$1.87B** in suspected wash trading volume on ETH/BNB/Base
- **1,400%** growth in AI deepfake impersonation attacks
- **70-80%** of crypto trading volume is from automated bots
- **25%** of all Polymarket trades estimated as wash trades

---

*Last updated: 2026-03-20*
*Maintainer: Cryonix Core Team*
