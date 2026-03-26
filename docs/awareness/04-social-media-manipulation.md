# 📱 Social Media Manipulation

> How crypto scammers weaponize Telegram, Discord, X/Twitter and other platforms to spread disinformation and steal funds.

---

## 1. Telegram Scams

Telegram is the #1 communication platform in crypto — and the #1 scam vector.

### Fake Groups & Copycat Channels
- Scammers clone official project channels (same name, same logo, same pinned messages)
- Slight spelling changes in channel name (e.g., `@BinanceOfficial` vs `@BinanceOfficiaI` — lowercase L vs uppercase I)
- Bots auto-invite users from real groups to the fake one
- Fake admins DM users asking for seed phrases or "verification"

### Pump & Dump Groups
- "VIP Signal Groups" charging monthly fees
- Coordinated buy campaigns on low-cap tokens
- Leaders buy before announcing → sell into participant demand
- Often disguised as "trading education" or "alpha groups"
- Some have 10k-100k+ members — massive liquidity for the exit

### Fake Admin Impersonation
- Scammer copies an admin's profile photo and display name
- Contacts users via DM pretending to be support
- "Your account has been flagged — click here to verify"
- "Send 0.5 ETH to this address for the airdrop"
- Real admins will NEVER DM you first

### Fake Verification Bots
- Bots in trading groups claim you need to "verify" your account
- Direct you to download software (malware)
- Steals passwords, wallet keys, browser data, session tokens

**Impact on Cryonix:**
- Our Telegram Signal Scraper (`scripts/telegram-scraper/`) ingests data from Telegram channels
- Scraper could parse signals from manipulative P&D groups
- Fake channels mimicking legitimate signal sources could inject bad signals
- **Defense:** Curate channel list carefully, never auto-add channels

---

## 2. Discord Scams

### Fake Crypto Exchanges & Giveaways
- DMs from "exchanges" offering free BTC/ETH
- Requires "deposit" or "fee" to claim
- 100% of these are scams — no exceptions

### Server Compromises
- Hacked admin accounts used to post phishing links
- Fake announcement bots posting "mint" or "claim" links
- Webhook exploits to post as the official bot
- Users trust announcements in official channels → click malicious links

### Fake Airdrop Claims
- "Connect your wallet to claim [TOKEN] airdrop"
- Wallet approval drains all approved tokens
- Often spread through compromised NFT project Discords

---

## 3. X/Twitter Manipulation

### Bot Armies
- Coordinated accounts posting identical bullish/bearish sentiments
- Used to trend hashtags, amplify narratives
- Often newly created accounts with AI-generated profile photos
- Can swing sentiment metrics significantly

### Reply Farming
- Known figure tweets about crypto
- Bot replies flood with "I just made $50k with [SCAM_TOKEN]"
- Links to fake platforms, airdrop pages, or P&D tokens
- Some replies are from hacked verified accounts for credibility

### Fake Screenshots
- Doctored PnL screenshots showing massive gains
- Fake portfolio screenshots to build credibility
- Fabricated "alpha" insider information screenshots
- Invoice/payment screenshots to suggest legitimacy

### Impersonation Accounts
- Copy of real person's account (same name, photo, bio)
- Username differs by one character
- Posts "giveaways" or "investment opportunities"
- Uses paid verification (blue checkmark) for legitimacy

### Coordinated Narrative Attacks
- Multiple accounts push the same FUD or FOMO narrative simultaneously
- Often timed with market events for maximum impact
- Can be hired as "articles for hire" or "tweet for hire" services
- Some campaigns funded by competitors or short sellers

**Impact on Cryonix:**
- X Sentiment Scanner (`scripts/strategy-lab/x_sentiment.py`) uses Grok with live X search
- Bot armies can distort our sentiment scores (-3 to +3 range)
- Coordinated campaigns can trigger false hack/exploit alerts
- **Defense:** Grok's live search helps filter, but volume of bots can overwhelm

---

## 4. Romance Scams / "Pig Butchering"

**What:** Long-term relationship manipulation to extract crypto funds.

**How it works:**
1. Scammer connects on dating app or social media
2. Builds trust over weeks/months
3. Introduces "amazing investment opportunity" in crypto
4. Shows fake platform with fake gains
5. Victim deposits more and more
6. When victim tries to withdraw, platform demands "fees" or "taxes"
7. Scammer disappears

**Scale:** One of the fastest-growing crypto fraud categories. Often run by organized crime syndicates.

**Impact on Cryonix:** Not directly relevant to our automated pipeline, but relevant context for understanding the ecosystem.

---

## 5. Giveaway Scams

**Pattern:**
> "Send 0.5 ETH and get 5 ETH back!"
> "Elon Musk is giving away 10,000 BTC!"

- Always use impersonated celebrity/project accounts
- Create urgency with countdown timers
- Use deepfake videos for "live" YouTube streams
- Social media accounts for 56% of all crypto scam cases in 2025

**Impact on Cryonix:** Can generate false social sentiment metrics; our X Scanner might pick up hype from these campaigns.

---

## Platform-Specific Red Flags Summary

| Platform | Red Flag | What To Check |
|----------|----------|---------------|
| Telegram | DM from "admin" | Admins never DM first |
| Telegram | "VIP signal group" | Who profits from the signals? |
| Discord | Announcement with "mint" link | Verify through official website |
| Discord | DM with "airdrop" | Projects don't distribute via DMs |
| X/Twitter | Identical replies across tweets | Check account creation dates |
| X/Twitter | Verified account pushing scam | Verification is purchaseable |
| All | "Guaranteed returns" | Nothing in crypto is guaranteed |
| All | Urgency/FOMO pressure | Legitimate opportunities don't expire in minutes |

---

*→ Next: [05-news-rss-weaponization.md](./05-news-rss-weaponization.md)*
