/**
 * Huntrix — Manipulation Scanner
 *
 * Detects manipulation campaigns across X/Twitter (via Grok live search),
 * Telegram signal clusters, and trending token anomalies.
 */

import type Redis from 'ioredis';
import type {
    ManipulationSignal,
    ManipulationType,
    PumpPhase,
    ShillActivity,
    XScanResult,
    TelegramClusterResult,
    HuntrixConfig,
} from './types';
import { GoPlusScanner } from './scanners/goplus';
import { DefiLlamaHacksScanner } from './scanners/defi-llama-hacks';
import { RSSFeedScanner } from './scanners/rss-feeds';
import { OrderBookSpoofDetector } from './scanners/orderbook';

const SYSTEM_PROMPT = `You are a crypto market manipulation detector. Your job is to identify
coordinated pump & dump campaigns, shill operations, and fake news pumps by analyzing
real-time X/Twitter activity.

You have access to live X/Twitter search. Look for:
1. COORDINATED SHILLING: Multiple accounts tweeting about the same low/mid-cap token
   within a short window, using hype language ("1000x", "moonshot", "don't miss")
2. PUMP & DUMP SETUP: Sudden burst of positive mentions for a token that was
   previously quiet, especially from new/bot-like accounts
3. WHALE GAMES: Large wallet movements combined with social media hype generation
4. FAKE NEWS: Fabricated partnership announcements, fake exchange listings

Be precise. False positives waste money. Only flag genuine manipulation campaigns.`;

function buildScanPrompt(config: HuntrixConfig, watchlist: string[]): string {
    const keywords = config.scanner.manipulation_keywords.join(', ');
    return `Scan X/Twitter RIGHT NOW for active cryptocurrency manipulation campaigns.

Focus on these indicators:
- Sudden explosion of tweets about a token (from ${config.scanner.min_shill_accounts}+ unique accounts)
- Use of pump language: ${keywords}
- Bot-like account patterns (new accounts, no followers, copy-paste tweets)
- Coordinated posting within ${config.scanner.cluster_window_minutes}-minute windows

Also check trending crypto tokens for any that look artificially pumped.

${watchlist.length > 0 ? `Known active watchlist: ${watchlist.join(', ')} — check these first.` : ''}

For EACH detected campaign, return:
{
  "campaigns": [
    {
      "symbol": "TOKEN",
      "type": "pump_and_dump" | "coordinated_shill" | "whale_accumulation" | "fake_news_pump" | "influencer_pump",
      "confidence": 0-100,
      "phase": "pre_pump" | "early_pump" | "mid_pump" | "peak" | "dump",
      "shill_accounts": 0,
      "sample_tweets": ["tweet1", "tweet2"],
      "bot_likelihood": 0-100,
      "reasoning": "why this looks like manipulation",
      "estimated_peak_minutes": null or number
    }
  ]
}

Return empty campaigns array if no manipulation detected. Only include campaigns
with confidence >= 50. JSON only, no markdown.`;
}

interface GrokCampaign {
    symbol: string;
    type: ManipulationType;
    confidence: number;
    phase: PumpPhase;
    shill_accounts: number;
    sample_tweets: string[];
    bot_likelihood: number;
    reasoning: string;
    estimated_peak_minutes: number | null;
}

export class ManipulationScanner {
    private config: HuntrixConfig;
    private redis: Redis;
    private openai: any; // OpenAI client (xAI endpoint)
    private recentSymbols: Map<string, number> = new Map(); // symbol -> last scan timestamp
    private goplusScanner: GoPlusScanner;
    private defiLlamaScanner: DefiLlamaHacksScanner;
    private rssScanner: RSSFeedScanner;
    private orderbookDetector: OrderBookSpoofDetector;
    private lastOrderbooks: Map<string, any>; // Previous orderbook snapshots

    constructor(config: HuntrixConfig, redis: Redis) {
        this.config = config;
        this.redis = redis;

        // Initialize xAI client
        const OpenAI = require('openai');
        const apiKey = process.env.XAI_API_KEY;
        if (!apiKey) {
            throw new Error('[HUNTRIX] XAI_API_KEY required for manipulation scanning');
        }
        this.openai = new OpenAI({ apiKey, baseURL: 'https://api.x.ai/v1' });

        this.goplusScanner = new GoPlusScanner(redis);
        this.defiLlamaScanner = new DefiLlamaHacksScanner(redis);
        this.rssScanner = new RSSFeedScanner(redis);
        this.orderbookDetector = new OrderBookSpoofDetector();
        this.lastOrderbooks = new Map();
    }

    /**
     * Scan X/Twitter for active manipulation campaigns via Grok live search
     */
    async scanX(watchlist: string[] = []): Promise<XScanResult> {
        const prompt = buildScanPrompt(this.config, watchlist);

        console.log('[HUNTRIX] Scanning X/Twitter for manipulation campaigns...');

        try {
            const response = await this.openai.chat.completions.create({
                model: this.config.scanner.grok_model,
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user', content: prompt },
                ],
                temperature: 0.2,
                max_tokens: 1200,
                extra_body: { search: { mode: 'on' } },
            });

            const content = response.choices?.[0]?.message?.content || '';
            const model = response.model || this.config.scanner.grok_model;
            const tokens = response.usage?.total_tokens || 0;

            // Parse JSON from response
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                console.warn('[HUNTRIX] No JSON in Grok response');
                return { signals: [], model, tokens_used: tokens, scanned_at: new Date().toISOString() };
            }

            const parsed = JSON.parse(jsonMatch[0]);
            const campaigns: GrokCampaign[] = parsed.campaigns || [];

            // Convert to ManipulationSignals
            const signals: ManipulationSignal[] = campaigns
                .filter((c: GrokCampaign) => c.confidence >= 50)
                .map((c: GrokCampaign) => this.campaignToSignal(c));

            console.log(`[HUNTRIX] Found ${signals.length} manipulation campaigns`);

            return {
                signals,
                model,
                tokens_used: tokens,
                scanned_at: new Date().toISOString(),
            };
        } catch (err) {
            console.error('[HUNTRIX] Grok scan failed:', err);
            return { signals: [], model: this.config.scanner.grok_model, tokens_used: 0, scanned_at: new Date().toISOString() };
        }
    }

    /**
     * Scan Telegram signal clusters — multiple channels pushing same token
     */
    async scanTelegramClusters(): Promise<TelegramClusterResult[]> {
        console.log('[HUNTRIX] Scanning Telegram for signal clusters...');

        try {
            // Read all telegram:signal:* keys from Redis
            const keys = await this.redis.keys('telegram:signal:*');
            if (keys.length === 0) return [];

            const pipeline = this.redis.pipeline();
            for (const key of keys) {
                pipeline.get(key);
            }
            const results = await pipeline.exec();
            if (!results) return [];

            // Group by symbol
            const symbolSignals: Map<string, Array<{ channel: string; action: string; entry: number | null; timestamp: string }>> = new Map();

            for (let i = 0; i < keys.length; i++) {
                const [err, val] = results[i] || [];
                if (err || !val) continue;

                try {
                    const signal = typeof val === 'string' ? JSON.parse(val) : val;
                    const symbol = signal.symbol || keys[i].replace('telegram:signal:', '');
                    const timestamp = signal.timestamp || signal.detected_at || new Date().toISOString();

                    if (!symbolSignals.has(symbol)) {
                        symbolSignals.set(symbol, []);
                    }
                    symbolSignals.get(symbol)!.push({
                        channel: signal.channel || 'unknown',
                        action: signal.action || 'BUY',
                        entry: signal.entry || null,
                        timestamp,
                    });
                } catch {
                    continue;
                }
            }

            // Find clusters: symbols pushed by min_channels_for_cluster+ channels within window
            const clusters: TelegramClusterResult[] = [];
            const windowMs = this.config.scanner.cluster_window_minutes * 60 * 1000;
            const now = Date.now();

            for (const [symbol, signals] of symbolSignals) {
                // Filter to recent signals only
                const recent = signals.filter(s => {
                    const ts = new Date(s.timestamp).getTime();
                    return now - ts < windowMs;
                });

                const uniqueChannels = new Set(recent.map(s => s.channel)).size;
                if (uniqueChannels >= this.config.scanner.min_channels_for_cluster) {
                    clusters.push({
                        symbol,
                        channel_count: uniqueChannels,
                        window_minutes: this.config.scanner.cluster_window_minutes,
                        signals: recent,
                    });
                }
            }

            console.log(`[HUNTRIX] Found ${clusters.length} Telegram signal clusters`);
            return clusters;
        } catch (err) {
            console.error('[HUNTRIX] Telegram cluster scan failed:', err);
            return [];
        }
    }

    /**
     * Scan trending tokens for anomalies (using CMC data already in Redis)
     */
    async scanTrendingAnomalies(): Promise<ManipulationSignal[]> {
        // Read CMC data from Redis (populated by CMCScout)
        const signals: ManipulationSignal[] = [];

        try {
            const globalRaw = await this.redis.get('cmc:global');
            if (!globalRaw) return signals;

            // Look for tokens with unusual volume spikes in CMC data
            const keys = await this.redis.keys('cmc:mcap:*');
            for (const key of keys) {
                const raw = await this.redis.get(key);
                if (!raw) continue;

                try {
                    const data = JSON.parse(raw);
                    // Flag tokens with volume > 5x market cap (unusual for legit tokens)
                    if (data.volume_24h && data.market_cap && data.market_cap > 0) {
                        const volumeToMcapRatio = data.volume_24h / data.market_cap;
                        if (volumeToMcapRatio > 5) {
                            const symbol = key.replace('cmc:mcap:', '');
                            signals.push({
                                id: `trending-${symbol}-${Date.now()}`,
                                type: 'wash_trading_pump',
                                symbol: `${symbol}/USDC`,
                                confidence: Math.min(90, 50 + volumeToMcapRatio * 5),
                                phase: 'mid_pump',
                                shill_activity: [],
                                total_shill_accounts: 0,
                                price_at_detection: data.price || 0,
                                volume_24h: data.volume_24h,
                                volume_spike_ratio: volumeToMcapRatio,
                                price_velocity: 0,
                                reasoning: `Volume/MCap ratio ${volumeToMcapRatio.toFixed(1)}x — extremely unusual, likely wash trading or pump activity`,
                                estimated_peak_minutes: null,
                                detected_at: new Date().toISOString(),
                                source: 'trending_anomaly',
                            });
                        }
                    }
                } catch {
                    continue;
                }
            }
        } catch (err) {
            console.error('[HUNTRIX] Trending anomaly scan failed:', err);
        }

        return signals;
    }

    /**
     * Scan defensive sources and write blacklist entries.
     * DeFi Llama hacks + RSS alerts → Redis blacklist keys.
     * Returns list of newly blacklisted symbols with reasons.
     */
    async scanDefensiveBlacklist(): Promise<Array<{ symbol: string; reason: string }>> {
        const sources = this.config.scanner.sources;
        const blacklisted: Array<{ symbol: string; reason: string }> = [];

        try {
            const promises: Promise<Array<{ symbol: string; reason: string }>>[] = [];

            if (sources.defi_llama_enabled) {
                promises.push(this.scanDefiLlamaBlacklist());
            }
            if (sources.rss_enabled) {
                promises.push(this.scanRSSBlacklist());
            }

            const results = await Promise.all(promises);
            for (const result of results) {
                blacklisted.push(...result);
            }
        } catch (err) {
            console.error('[HUNTRIX] Defensive blacklist scan failed:', err);
        }

        return blacklisted;
    }

    private async scanDefiLlamaBlacklist(): Promise<Array<{ symbol: string; reason: string }>> {
        const blacklisted: Array<{ symbol: string; reason: string }> = [];
        const hacks = await this.defiLlamaScanner.scan();
        for (const hack of hacks) {
            for (const symbol of hack.symbols) {
                const key = `huntrix:blacklist:${symbol}`;
                const reason = `DeFi Llama: ${hack.name} hack ($${(hack.amount / 1e6).toFixed(1)}M) — ${hack.technique}`;
                await this.redis.setex(key, 86400, JSON.stringify({
                    reason,
                    source: 'defi_llama',
                    date: hack.date,
                    added_at: new Date().toISOString(),
                }));
                blacklisted.push({ symbol, reason });
                console.log(`[HUNTRIX] Blacklisted ${symbol} — ${hack.name} hack`);
            }
        }
        return blacklisted;
    }

    private async scanRSSBlacklist(): Promise<Array<{ symbol: string; reason: string }>> {
        const blacklisted: Array<{ symbol: string; reason: string }> = [];
        const alerts = await this.rssScanner.scan();
        for (const alert of alerts) {
            for (const symbol of alert.symbols) {
                const key = `huntrix:blacklist:${symbol}`;
                const ttl = alert.severity === 'high' ? 86400 : 43200; // 24h or 12h
                const reason = `RSS (${alert.feedName}): ${alert.title}`;
                await this.redis.setex(key, ttl, JSON.stringify({
                    reason,
                    source: 'rss_alert',
                    category: alert.category,
                    severity: alert.severity,
                    added_at: new Date().toISOString(),
                }));
                blacklisted.push({ symbol, reason });
                console.log(`[HUNTRIX] Blacklisted ${symbol} — RSS: ${alert.title.slice(0, 60)}`);
            }
        }
        return blacklisted;
    }

    /**
     * Scan order books for spoofing. Requires two calls (snapshot comparison).
     */
    async scanOrderBook(exchange: any, symbols: string[]): Promise<ManipulationSignal[]> {
        if (!this.config.scanner.sources.orderbook_spoof_enabled) return [];

        const signals: ManipulationSignal[] = [];

        for (const symbol of symbols) {
            try {
                const orderbook = await exchange.fetchOrderBook(symbol, 20);
                const current = OrderBookSpoofDetector.fromCCXT(orderbook);
                const previous = this.lastOrderbooks.get(symbol);

                if (previous) {
                    const midPrice = (current.bids[0]?.price + current.asks[0]?.price) / 2 || 0;
                    const detections = this.orderbookDetector.detect(previous, current, symbol, midPrice);

                    for (const detection of detections) {
                        signals.push({
                            id: `spoof-${symbol}-${Date.now()}`,
                            type: 'wash_trading_pump',
                            symbol,
                            confidence: Math.min(85, 55 + detection.disappeared_pct / 5),
                            phase: detection.side === 'bid' ? 'early_pump' : 'mid_pump',
                            shill_activity: [],
                            total_shill_accounts: 0,
                            price_at_detection: midPrice,
                            volume_24h: 0,
                            volume_spike_ratio: 0,
                            price_velocity: 0,
                            reasoning: `${detection.side} wall of $${(detection.wall_size_usd / 1000).toFixed(0)}K at ${detection.wall_price} disappeared ${detection.disappeared_pct.toFixed(0)}% — likely spoofing`,
                            estimated_peak_minutes: null,
                            detected_at: new Date().toISOString(),
                            source: 'orderbook_spoof',
                        });
                    }
                }

                this.lastOrderbooks.set(symbol, current);
            } catch (err) {
                // Skip symbols with orderbook fetch errors
            }
        }

        return signals;
    }

    /**
     * Run full scan across all sources
     */
    async fullScan(watchlist: string[] = []): Promise<ManipulationSignal[]> {
        const [xResult, telegramClusters, trendingSignals] = await Promise.all([
            this.scanX(watchlist),
            this.scanTelegramClusters(),
            this.scanTrendingAnomalies(),
        ]);

        // Run defensive scans in background (don't block trade signals)
        this.scanDefensiveBlacklist().then(entries => {
            if (entries.length > 0) {
                this.redis.setex('huntrix:blacklist:recent', 3600, JSON.stringify(entries));
            }
        }).catch(err =>
            console.error('[HUNTRIX] Background blacklist scan error:', err)
        );

        const allSignals: ManipulationSignal[] = [...xResult.signals, ...trendingSignals];

        // Convert Telegram clusters to ManipulationSignals
        for (const cluster of telegramClusters) {
            if (cluster.channel_count >= this.config.scanner.min_channels_for_cluster) {
                allSignals.push({
                    id: `telegram-cluster-${cluster.symbol}-${Date.now()}`,
                    type: 'coordinated_shill',
                    symbol: cluster.symbol.includes('/') ? cluster.symbol : `${cluster.symbol}/USDC`,
                    confidence: Math.min(90, 50 + cluster.channel_count * 10),
                    phase: 'early_pump', // Telegram clusters usually indicate early phase
                    shill_activity: [{
                        platform: 'telegram',
                        account_count: cluster.channel_count,
                        mention_count: cluster.signals.length,
                        window_minutes: cluster.window_minutes,
                        samples: cluster.signals.map(s => `${s.channel}: ${s.action} ${cluster.symbol}`),
                        bot_likelihood: 30,
                    }],
                    total_shill_accounts: cluster.channel_count,
                    price_at_detection: cluster.signals[0]?.entry || 0,
                    volume_24h: 0,
                    volume_spike_ratio: 0,
                    price_velocity: 0,
                    reasoning: `${cluster.channel_count} Telegram channels simultaneously pushing ${cluster.symbol} within ${cluster.window_minutes} minutes`,
                    estimated_peak_minutes: null,
                    detected_at: new Date().toISOString(),
                    source: 'telegram_cluster',
                });
            }
        }

        // Deduplicate by symbol (keep highest confidence)
        const bySymbol = new Map<string, ManipulationSignal>();
        for (const signal of allSignals) {
            const existing = bySymbol.get(signal.symbol);
            if (!existing) {
                bySymbol.set(signal.symbol, signal);
            } else {
                // Merge and boost confidence
                const updated = existing.confidence >= signal.confidence ? existing : signal;
                updated.confidence = Math.min(95, Math.max(existing.confidence, signal.confidence) + 10);
                updated.source = 'combined';
                updated.shill_activity = [...existing.shill_activity, ...signal.shill_activity];
                updated.total_shill_accounts = existing.total_shill_accounts + signal.total_shill_accounts;
                bySymbol.set(updated.symbol, updated);
            }
        }

        // Filter by cooldown (don't re-scan same symbol too quickly)
        const now = Date.now();
        const cooldownMs = 30 * 60 * 1000; // 30 minutes hardcoded
        const filtered = [...bySymbol.values()].filter(signal => {
            const lastScan = this.recentSymbols.get(signal.symbol);
            if (lastScan && now - lastScan < cooldownMs) {
                console.log(`[HUNTRIX] Skipping ${signal.symbol} — scanned ${Math.round((now - lastScan) / 60000)}min ago`);
                return false;
            }
            this.recentSymbols.set(signal.symbol, now);
            return true;
        });

        // Publish scan results to Redis for dashboard
        await this.redis.setex(
            'huntrix:detections',
            3600,
            JSON.stringify({
                signals: filtered,
                x_tokens: xResult.tokens_used,
                telegram_clusters: telegramClusters.length,
                trending_anomalies: trendingSignals.length,
                scanned_at: new Date().toISOString(),
            })
        );

        return filtered;
    }

    private campaignToSignal(campaign: GrokCampaign): ManipulationSignal {
        return {
            id: `x-${campaign.symbol}-${Date.now()}`,
            type: campaign.type,
            symbol: campaign.symbol.includes('/') ? campaign.symbol : `${campaign.symbol}/USDC`,
            confidence: campaign.confidence,
            phase: campaign.phase,
            shill_activity: [{
                platform: 'x',
                account_count: campaign.shill_accounts,
                mention_count: campaign.shill_accounts, // approximate
                window_minutes: this.config.scanner.cluster_window_minutes,
                samples: campaign.sample_tweets,
                bot_likelihood: campaign.bot_likelihood,
            }],
            total_shill_accounts: campaign.shill_accounts,
            price_at_detection: 0, // Will be filled by entry validator
            volume_24h: 0,
            volume_spike_ratio: 0,
            price_velocity: 0,
            reasoning: campaign.reasoning,
            estimated_peak_minutes: campaign.estimated_peak_minutes,
            detected_at: new Date().toISOString(),
            source: 'x_scan',
        };
    }
}
