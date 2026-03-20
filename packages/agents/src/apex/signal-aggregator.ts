/**
 * APEX Signal Aggregator — reads all 7 trading instances from Redis.
 *
 * Uses a single pipeline() call to batch-read all keys, then parses
 * each source independently (wrapped in try/catch so one failure does
 * not affect the rest).
 *
 * Redis key layout:
 *   trades:pending       — Cryonix pending signals (JSON string, GET)
 *   copynix:signals      — Copynix whale events (JSON string, GET)
 *   psinix:positions     — Ψnix positions (JSON string, GET)
 *   psinix:status        — Ψnix status string (GET, may be plain 'running')
 *   psinix:state         — Ψnix full state with positions+coherence (JSON, GET)
 *   polymarket:crypto    — Polymarket crypto sentiment (JSON string, GET)
 *   polymarket:summary   — Polymarket overall summary (JSON string, GET)
 *   aktienix:signals     — Aktienix signals (Redis LIST, LRANGE 0 -1)
 *   solanix:status       — Solanix status (JSON string, GET)
 *   vedic:planets        — Vedic planetary data (JSON string, GET)
 *   cmc:fear_greed       — CMC Fear & Greed index (JSON or plain number, GET)
 *   cmc:global           — CMC global metrics (JSON string, GET)
 */

import type Redis from 'ioredis';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SignalDirection = 'bullish' | 'bearish';

export interface NormalizedSignal {
    /** Normalized base symbol: 'BTC', 'ETH', 'SOL', etc. */
    symbol: string;
    direction: SignalDirection;
    /** Which instance produced this signal */
    source: 'cryonix' | 'copynix' | 'psinix' | 'polymarket' | 'aktienix' | 'solanix' | 'vedic' | 'cmc';
    /** e.g. 'DEEP_VALUE_CRASH', 'whale_buy', 'venus_rx', 'extreme_fear' */
    signalType: string;
    /** 0-100 */
    confidence: number;
    /** 0-100 (whale score, sentiment score, etc.) */
    score: number;
    /** Unix ms */
    timestamp: number;
    /** Original raw data for debugging */
    raw?: unknown;
}

export interface AggregatorSnapshot {
    signals: NormalizedSignal[];
    /** source → is_stale */
    staleness: Record<string, boolean>;
    timestamp: number;
}

// ---------------------------------------------------------------------------
// Internal pipeline result slot indices
// ---------------------------------------------------------------------------

const SLOT_CRYONIX         = 0;
const SLOT_COPYNIX         = 1;
const SLOT_PSINIX_POS      = 2;
const SLOT_PSINIX_STATUS   = 3;
const SLOT_PSINIX_STATE    = 4;
const SLOT_POLY_CRYPTO     = 5;
const SLOT_POLY_SUMMARY    = 6;
const SLOT_AKTIENIX        = 7;   // LRANGE — returns string[]
const SLOT_SOLANIX         = 8;
const SLOT_VEDIC           = 9;
const SLOT_CMC_FG          = 10;
const SLOT_CMC_GLOBAL      = 11;

// ---------------------------------------------------------------------------
// Staleness thresholds
// ---------------------------------------------------------------------------

const STALE_MS_DEFAULT = 5 * 60 * 1000;          // 5 minutes
const STALE_MS_VEDIC   = 24 * 60 * 60 * 1000;    // 24 hours (planetary data changes slowly)

// ---------------------------------------------------------------------------
// Symbol normalisation helpers
// ---------------------------------------------------------------------------

/**
 * Strip exchange pair suffixes — 'BTC/USDC' → 'BTC', 'ETH/USDT' → 'ETH'.
 * If the symbol has no slash, return as-is (already a base symbol).
 */
function normalizeSymbol(raw: string): string {
    if (!raw) return 'UNKNOWN';
    return raw.split('/')[0].toUpperCase();
}

// ---------------------------------------------------------------------------
// SignalAggregator
// ---------------------------------------------------------------------------

export class SignalAggregator {
    constructor(private readonly redis: Redis) {}

    /**
     * Take a snapshot of all instances. Reads all Redis keys in a single
     * pipeline call, then parses each source independently.
     */
    async snapshot(): Promise<AggregatorSnapshot> {
        const now = Date.now();
        const signals: NormalizedSignal[] = [];
        const staleness: Record<string, boolean> = {};

        // ── Build pipeline ───────────────────────────────────────────────────
        const pipe = this.redis.pipeline();
        pipe.get('trades:pending');       // SLOT_CRYONIX
        pipe.get('copynix:signals');      // SLOT_COPYNIX
        pipe.get('psinix:positions');     // SLOT_PSINIX_POS
        pipe.get('psinix:status');        // SLOT_PSINIX_STATUS
        pipe.get('psinix:state');         // SLOT_PSINIX_STATE
        pipe.get('polymarket:crypto');    // SLOT_POLY_CRYPTO
        pipe.get('polymarket:summary');   // SLOT_POLY_SUMMARY
        pipe.lrange('aktienix:signals', 0, -1); // SLOT_AKTIENIX — LIST!
        pipe.get('solanix:status');       // SLOT_SOLANIX
        pipe.get('vedic:planets');        // SLOT_VEDIC
        pipe.get('cmc:fear_greed');       // SLOT_CMC_FG
        pipe.get('cmc:global');           // SLOT_CMC_GLOBAL

        const results = await pipe.exec();
        if (!results) {
            return { signals: [], staleness: {}, timestamp: now };
        }

        // Helper to extract the value from a pipeline result entry.
        // Each entry is [error, value].
        const val = <T>(slot: number): T | null => {
            const entry = results[slot];
            if (!entry || entry[0]) return null;
            return entry[1] as T | null;
        };

        // ── Parse each source ────────────────────────────────────────────────

        // 1. Cryonix — trades:pending
        try {
            const raw = val<string>(SLOT_CRYONIX);
            if (raw) {
                const parsed = JSON.parse(raw);
                const entries: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
                let isStale = false;

                for (const entry of entries) {
                    if (!entry || typeof entry !== 'object') continue;
                    const e = entry as Record<string, unknown>;
                    const ts = (e.timestamp as number) ?? now;
                    if (now - ts > STALE_MS_DEFAULT) { isStale = true; continue; }

                    const symbol = normalizeSymbol((e.symbol as string) ?? '');
                    const confidence = (e.confidence as number) ?? 0;
                    const patterns: string[] = Array.isArray(e.patterns) ? e.patterns as string[] : [];

                    for (const pattern of patterns) {
                        const patternStr = String(pattern).toUpperCase();
                        // All patterns from trades:pending are bullish BUY signals
                        signals.push({
                            symbol,
                            direction: 'bullish',
                            source: 'cryonix',
                            signalType: patternStr,
                            confidence,
                            score: confidence,
                            timestamp: ts,
                            raw: entry,
                        });
                    }
                }

                staleness['cryonix'] = isStale && signals.filter(s => s.source === 'cryonix').length === 0;
            } else {
                staleness['cryonix'] = false; // No data — not stale, just quiet
            }
        } catch (err) {
            console.warn('[apex/aggregator] Cryonix parse error:', err instanceof Error ? err.message : err);
            staleness['cryonix'] = true;
        }

        // 2. Copynix — copynix:signals
        try {
            const raw = val<string>(SLOT_COPYNIX);
            if (raw) {
                const entries: unknown[] = JSON.parse(raw);
                if (Array.isArray(entries)) {
                    let isStale = false;
                    for (const entry of entries) {
                        if (!entry || typeof entry !== 'object') continue;
                        const e = entry as Record<string, unknown>;
                        const ts = (e.timestamp as number) ?? now;
                        if (now - ts > STALE_MS_DEFAULT) { isStale = true; continue; }

                        const score = (e.score as number) ?? 0;
                        if (score < 80) continue; // Filter: only strong whale signals

                        // symbol field preferred; fall back to token field
                        const rawSym = (e.symbol as string) ?? (e.token as string) ?? '';
                        const symbol = normalizeSymbol(rawSym);
                        const direction: SignalDirection = 'bullish'; // Buys are always bullish

                        signals.push({
                            symbol,
                            direction,
                            source: 'copynix',
                            signalType: 'whale_buy',
                            confidence: Math.min(100, score),
                            score,
                            timestamp: ts,
                            raw: entry,
                        });
                    }
                    staleness['copynix'] = isStale;
                }
            } else {
                staleness['copynix'] = false;
            }
        } catch (err) {
            console.warn('[apex/aggregator] Copynix parse error:', err instanceof Error ? err.message : err);
            staleness['copynix'] = true;
        }

        // 3. Ψnix — psinix:state (preferred) + psinix:positions + psinix:status
        // Note: psinix:status is a plain string 'running', not JSON.
        //       psinix:state is a full JSON state object with positions + updatedAt.
        //       psinix:positions may be null (not published by current implementation).
        try {
            // Prefer psinix:state (the actual full state object)
            const stateRaw = val<string>(SLOT_PSINIX_STATE);
            const posRaw   = val<string>(SLOT_PSINIX_POS);

            const stateObj = stateRaw ? (JSON.parse(stateRaw) as Record<string, unknown>) : null;
            const posObj   = posRaw ? (JSON.parse(posRaw) as Record<string, unknown>) : null;

            // Determine staleness from updatedAt
            const updatedAt = (stateObj?.updatedAt as number) ?? (posObj?.updatedAt as number) ?? null;
            const isStale = updatedAt !== null ? (now - updatedAt > STALE_MS_DEFAULT) : false;
            staleness['psinix'] = isStale;

            if (!isStale) {
                // Extract coherence and regime from state object
                // psinix:state has: { status, positions, ... updatedAt }
                // positions array items have: { coherenceAtEntry, psiAtEntry, ... }
                // We emit a signal per active position if coherence is high enough
                const positions: unknown[] = Array.isArray(stateObj?.positions)
                    ? stateObj!.positions as unknown[]
                    : Array.isArray(posObj?.positions)
                        ? posObj!.positions as unknown[]
                        : [];

                for (const pos of positions) {
                    if (!pos || typeof pos !== 'object') continue;
                    const p = pos as Record<string, unknown>;
                    const coherence = (p.coherenceAtEntry as number) ?? (p.coherence as number) ?? 0;
                    if (coherence < 0.7) continue; // Threshold: only high-coherence positions

                    const psi = (p.psiAtEntry as number) ?? (p.psi as number) ?? 0;
                    const side = (p.side as string) ?? '';
                    // psi > 0 = LONG (bullish), psi < 0 = SHORT (bearish)
                    const direction: SignalDirection = psi >= 0 || side === 'LONG' ? 'bullish' : 'bearish';
                    const symbol = normalizeSymbol((p.symbol as string) ?? '');
                    const ts = (p.entryTime as number) ?? updatedAt ?? now;

                    signals.push({
                        symbol,
                        direction,
                        source: 'psinix',
                        signalType: 'phase_convergence',
                        confidence: Math.round(coherence * 100),
                        score: Math.round(Math.abs(psi) * 100),
                        timestamp: ts,
                        raw: pos,
                    });
                }

                // If no positions but state exists, emit a global regime signal
                // based on the overall Ψnix status (running + last coherence)
                if (positions.length === 0 && stateObj) {
                    // Emit a low-weight market-regime signal indicating Ψnix is live
                    signals.push({
                        symbol: 'MARKET',
                        direction: 'bullish',
                        source: 'psinix',
                        signalType: 'psinix_online',
                        confidence: 50,
                        score: 50,
                        timestamp: updatedAt ?? now,
                        raw: { status: stateObj.status },
                    });
                }
            }
        } catch (err) {
            console.warn('[apex/aggregator] Ψnix parse error:', err instanceof Error ? err.message : err);
            staleness['psinix'] = true;
        }

        // 4. Polymarket — polymarket:crypto
        try {
            const raw = val<string>(SLOT_POLY_CRYPTO);
            if (raw) {
                const data = JSON.parse(raw) as Record<string, unknown>;
                const updatedAt = (data.updated_at as number) ?? (data.timestamp as number) ?? null;
                const isStale = updatedAt !== null ? (now - updatedAt > STALE_MS_DEFAULT) : false;
                staleness['polymarket'] = isStale;

                if (!isStale) {
                    const sentiment = (data.sentiment as number) ?? 50;
                    const delta = (data.delta as number) ?? 0;

                    if (delta >= 20) {
                        signals.push({
                            symbol: 'CRYPTO',
                            direction: 'bullish',
                            source: 'polymarket',
                            signalType: 'sentiment_shift_bullish',
                            confidence: Math.min(100, 50 + delta),
                            score: sentiment,
                            timestamp: updatedAt ?? now,
                            raw: data,
                        });
                    } else if (delta <= -15) {
                        signals.push({
                            symbol: 'CRYPTO',
                            direction: 'bearish',
                            source: 'polymarket',
                            signalType: 'sentiment_shift_bearish',
                            confidence: Math.min(100, 50 + Math.abs(delta)),
                            score: 100 - sentiment,
                            timestamp: updatedAt ?? now,
                            raw: data,
                        });
                    }
                }
            } else {
                staleness['polymarket'] = false;
            }
        } catch (err) {
            console.warn('[apex/aggregator] Polymarket parse error:', err instanceof Error ? err.message : err);
            staleness['polymarket'] = true;
        }

        // 5. Vedic — vedic:planets
        // Structure: { planets: { Venus: { is_retrograde: bool, ... }, Mercury: { ... }, ... }, timestamp: ..., ayanamsa: ... }
        try {
            const raw = val<string>(SLOT_VEDIC);
            if (raw) {
                const data = JSON.parse(raw) as Record<string, unknown>;
                const ts = (data.timestamp as number) ?? null;
                const isStale = ts !== null ? (now - ts > STALE_MS_VEDIC) : false;
                staleness['vedic'] = isStale;

                if (!isStale) {
                    const planets = data.planets as Record<string, Record<string, unknown>> | undefined;
                    if (planets && typeof planets === 'object') {
                        // Venus Rx — primary APEX bearish gate
                        const venus = planets['Venus'];
                        if (venus && venus.is_retrograde === true) {
                            signals.push({
                                symbol: 'MARKET',
                                direction: 'bearish',
                                source: 'vedic',
                                signalType: 'venus_rx',
                                confidence: 90,
                                score: 90,
                                timestamp: ts ?? now,
                                raw: venus,
                            });
                        }

                        // Mercury Rx — additional bearish signal (tech/comms disruption)
                        const mercury = planets['Mercury'];
                        if (mercury && mercury.is_retrograde === true) {
                            signals.push({
                                symbol: 'MARKET',
                                direction: 'bearish',
                                source: 'vedic',
                                signalType: 'mercury_rx',
                                confidence: 60,
                                score: 60,
                                timestamp: ts ?? now,
                                raw: mercury,
                            });
                        }

                        // Count total retrograde planets — more retrogrades = more bearish pressure
                        const retrogradeCount = Object.values(planets).filter(
                            p => p && p.is_retrograde === true,
                        ).length;
                        if (retrogradeCount >= 3) {
                            signals.push({
                                symbol: 'MARKET',
                                direction: 'bearish',
                                source: 'vedic',
                                signalType: 'multi_retrograde',
                                confidence: Math.min(100, retrogradeCount * 15),
                                score: Math.min(100, retrogradeCount * 15),
                                timestamp: ts ?? now,
                                raw: { retrogradeCount },
                            });
                        }
                    }
                }
            } else {
                staleness['vedic'] = false;
            }
        } catch (err) {
            console.warn('[apex/aggregator] Vedic parse error:', err instanceof Error ? err.message : err);
            staleness['vedic'] = true;
        }

        // 6. CMC Fear & Greed — cmc:fear_greed
        try {
            const raw = val<string>(SLOT_CMC_FG);
            if (raw) {
                // Can be a plain number string or JSON: { value: 25, label: 'Extreme Fear', timestamp: ... }
                let value: number | null = null;
                let ts: number | null = null;

                const num = parseFloat(raw);
                if (!isNaN(num)) {
                    value = num;
                } else {
                    const parsed = JSON.parse(raw) as Record<string, unknown>;
                    value = (parsed.value as number) ?? null;
                    ts = (parsed.timestamp as number) ?? (parsed.updated_at as number) ?? null;
                }

                const isStale = ts !== null ? (now - ts > STALE_MS_DEFAULT) : false;
                staleness['cmc'] = isStale;

                if (!isStale && value !== null) {
                    if (value <= 25) {
                        // Extreme fear — contrarian bullish signal
                        signals.push({
                            symbol: 'MARKET',
                            direction: 'bullish',
                            source: 'cmc',
                            signalType: 'extreme_fear',
                            confidence: Math.round((25 - value) * 2 + 50), // 50-100 range
                            score: Math.round(100 - value),
                            timestamp: ts ?? now,
                            raw: { fearGreed: value },
                        });
                    }
                    // Also emit btc_dom context signal from cmc:global (handled below)
                }
            } else {
                staleness['cmc'] = false;
            }
        } catch (err) {
            console.warn('[apex/aggregator] CMC Fear&Greed parse error:', err instanceof Error ? err.message : err);
            staleness['cmc'] = true;
        }

        // 7. CMC Global — cmc:global (BTC dominance context signal)
        try {
            const raw = val<string>(SLOT_CMC_GLOBAL);
            if (raw) {
                const data = JSON.parse(raw) as Record<string, unknown>;
                const btcDominance = (data.btc_dominance as number) ?? null;
                const ts = (data.timestamp as number) ?? (data.updated_at as number) ?? null;
                const isStale = ts !== null ? (now - ts > STALE_MS_DEFAULT) : false;

                // Merge cmc staleness (don't override if already set from fear_greed)
                if (staleness['cmc'] === false || staleness['cmc'] === undefined) {
                    staleness['cmc'] = isStale;
                }

                if (!isStale && btcDominance !== null) {
                    // Emit BTC dominance as a context signal
                    // High BTC dom (>55%) → BTC strong, alts weak (bearish for alts)
                    // Low BTC dom (<40%) → altcoin season (bullish for alts)
                    const direction: SignalDirection = btcDominance < 40 ? 'bullish' : 'bearish';
                    signals.push({
                        symbol: 'MARKET',
                        direction,
                        source: 'cmc',
                        signalType: 'btc_dom',
                        confidence: 50, // Context signal — moderate confidence
                        score: direction === 'bullish'
                            ? Math.round((40 - btcDominance) * 2.5)   // 0-25 range
                            : Math.round((btcDominance - 40) * 2.5),  // 0-38 range
                        timestamp: ts ?? now,
                        raw: { btcDominance },
                    });
                }
            }
        } catch (err) {
            console.warn('[apex/aggregator] CMC Global parse error:', err instanceof Error ? err.message : err);
        }

        // 8. Aktienix — aktienix:signals (Redis LIST)
        // Each list entry is a JSON string of PublishableSignal:
        //   { symbol, action, confidence, reasoning, timestamp }
        try {
            const entries = val<string[]>(SLOT_AKTIENIX);
            if (entries && entries.length > 0) {
                let latestTs: number | null = null;

                for (const entry of entries) {
                    if (!entry) continue;
                    try {
                        const sig = JSON.parse(entry) as Record<string, unknown>;
                        const ts = (sig.timestamp as number) ?? now;
                        if (now - ts > STALE_MS_DEFAULT) continue; // Skip stale individual entries

                        if (!latestTs || ts > latestTs) latestTs = ts;

                        const action = String(sig.action ?? '').toUpperCase();
                        if (action !== 'BUY') continue; // Only interested in bullish macro signals

                        const symbol = normalizeSymbol(String(sig.symbol ?? ''));
                        const confidence = (sig.confidence as number) ?? 0;

                        // Filter: only signals with meaningful confidence
                        if (confidence < 50) continue;

                        signals.push({
                            symbol,
                            direction: 'bullish',
                            source: 'aktienix',
                            signalType: 'macro_bullish',
                            confidence,
                            score: confidence,
                            timestamp: ts,
                            raw: sig,
                        });
                    } catch {
                        // Malformed entry — skip
                    }
                }

                // Determine staleness from the most recent entry's timestamp
                const isStale = latestTs !== null ? (now - latestTs > STALE_MS_DEFAULT) : false;
                staleness['aktienix'] = isStale;
            } else {
                staleness['aktienix'] = false;
            }
        } catch (err) {
            console.warn('[apex/aggregator] Aktienix parse error:', err instanceof Error ? err.message : err);
            staleness['aktienix'] = true;
        }

        // 9. Solanix — solanix:status
        // Structure varies: may be a plain string ('running') or a JSON status object.
        try {
            const raw = val<string>(SLOT_SOLANIX);
            if (raw) {
                // Try to parse as JSON first
                let data: Record<string, unknown> | null = null;
                try {
                    data = JSON.parse(raw) as Record<string, unknown>;
                } catch {
                    // Plain string status — e.g. 'running'
                    data = null;
                }

                const updatedAt = data
                    ? ((data.updated_at as number) ?? (data.updatedAt as number) ?? (data.timestamp as number) ?? null)
                    : null;
                const isStale = updatedAt !== null ? (now - updatedAt > STALE_MS_DEFAULT) : false;
                staleness['solanix'] = isStale;

                if (!isStale && data) {
                    // Look for volume spike indicators in positions or signals arrays
                    const positions: unknown[] = Array.isArray(data.positions) ? data.positions as unknown[] : [];
                    const signalsArr: unknown[] = Array.isArray(data.signals) ? data.signals as unknown[] : [];

                    // Check active positions for volume-spike entries
                    for (const pos of positions) {
                        if (!pos || typeof pos !== 'object') continue;
                        const p = pos as Record<string, unknown>;
                        const symbol = normalizeSymbol(String(p.symbol ?? ''));
                        const confidence = (p.confidence as number) ?? 0;
                        const ts = (p.openedAt as number) ?? (p.entryTime as number) ?? now;

                        if (confidence > 0) {
                            signals.push({
                                symbol,
                                direction: 'bullish',
                                source: 'solanix',
                                signalType: 'dex_momentum',
                                confidence: Math.round(confidence * 100), // normalize 0-1 → 0-100
                                score: Math.round(confidence * 100),
                                timestamp: ts,
                                raw: pos,
                            });
                        }
                    }

                    // Check signals array for volume spike entries
                    for (const sig of signalsArr) {
                        if (!sig || typeof sig !== 'object') continue;
                        const s = sig as Record<string, unknown>;
                        const action = String(s.action ?? s.direction ?? '').toUpperCase();
                        if (action !== 'BUY' && action !== 'BULLISH') continue;

                        const symbol = normalizeSymbol(String(s.symbol ?? ''));
                        const confidence = (s.confidence as number) ?? 50;
                        const ts = (s.timestamp as number) ?? now;

                        signals.push({
                            symbol,
                            direction: 'bullish',
                            source: 'solanix',
                            signalType: 'volume_spike',
                            confidence,
                            score: confidence,
                            timestamp: ts,
                            raw: sig,
                        });
                    }
                }
            } else {
                staleness['solanix'] = false;
            }
        } catch (err) {
            console.warn('[apex/aggregator] Solanix parse error:', err instanceof Error ? err.message : err);
            staleness['solanix'] = true;
        }

        // ── Remove signals from stale sources ───────────────────────────────
        const freshSignals = signals.filter(sig => !staleness[sig.source]);

        return {
            signals: freshSignals,
            staleness,
            timestamp: now,
        };
    }
}
