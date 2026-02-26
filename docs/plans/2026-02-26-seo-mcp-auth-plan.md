# Plan: Website SEO, MCP & Auth Integration (2026-02-26)

## Overview
This plan outlines the implementation of a comprehensive SEO and agent-native ecosystem for Cryonix, including expert articles, an MCP server for AI agents, and a developer-first authentication system.

## 1. Authority Hub (SEO/GEO)
Created a "Spider Web" of content to attract both human traders (Google) and AI agents (ChatGPT/Claude).

### Expert Articles Created:
- **Best Crypto Trading Signals for Telegram 2026**: A pillar page reviewing the market and positioning Cryonix as the #1 AI-powered choice.
- **AI Crypto Trading: The Fail-Closed Approach**: Explains our safety-first architecture and Grok validation.
- **Why 99% of Crypto Telegram Signals are Scams**: An educational piece to build trust and capture "scam-related" search traffic.
- **Trading the Bollinger Squeeze with AI**: A technical guide for experienced traders and strategy-focused searches.

### Optimization:
- **JSON-LD Schema**: Implemented `Article`, `FAQ`, and `BreadcrumbList` for every guide to "feed" AI agents with structured data.
- **i18n Scaling**: Automated script created to propagate all new content keys to **25 languages** with English fallbacks.
- **Sitemap**: Dynamically updated to include all new localized routes.

## 2. Agent-Native Integration (MCP)
Positioned Cryonix as the first "Agent-Ready" signal platform.

- **MCP Server**: New package `@cryonix/mcp-server` created.
- **Tools**: Exposed `get_latest_signals` and `get_signal_stats` directly to models like Claude.
- **Integration Guide**: Documentation for setting up Claude Desktop and OpenHands with Cryonix.

## 3. Developer Authentication & API Keys
Implemented a secure way for developers and agents to access private data.

- **NextAuth Integration**: Connected GitHub OAuth to the existing PostgreSQL/Drizzle database.
- **Developer Dashboard**: New UI at `/developers` for generating, labeling, and managing API keys (prefixed with `cry_`).
- **Middleware Validation**: The MCP server now validates incoming requests against the `users.api_keys` database column.

## 4. Verification & Quality
- **Smoke Tests**: Implemented Playwright tests (`apps/website/scripts/smoke-test.spec.ts`) covering all 10 core pages in both English and Swedish.
- **Documentation**: All architectural changes logged in the monorepo.

## Next Steps
1. **Evolution Engine Whitepaper**: Technical deep-dive for high-end GEO hits.
2. **Community Growth**: Automated distribution of new guides to crypto forums.
3. **API Key Usage Tiers**: Implementing limits or usage tracking in the MCP server.
