/**
 * APEX Signal Aggregator — reads all 7 trading instances + ORAKEL from Redis.
 *
 * Corrections from code review:
 * - aktienix:signals LIST doesn't exist → read aktienix:positions for sentiment proxy
 * - psinix:positions doesn't exist → read psinix:state (already done)
 * - polymarket:crypto has no delta field → compute from crypto vs crypto:prev
 * - vedic:planets path: data.planets.Venus.is_retrograde (extra nesting)
 * - Signals classified as "momentary" (5min window) or "ambient" (always-on)
 * - ORAKEL forecast signals added
 *
 * Uses a single pipeline() call to batch-read all keys.
 */

import type Redis from 'ioredis';
import type { ApexTomlConfig } from './config';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SignalDirection = 'bullish' | 'bearish';
export type SignalTemporality = 'momentary' | 'ambient';

export interface NormalizedSignal {
    symbol: string;
    direction: SignalDirection;
    source: 'cryonix' | 'copynix' | 'psinix' | 'polymarket' | 'aktienix' | 'solanix' | 'vedic' | 'cmc' | 'orakel';
    signalType: string;
    confidence: number;
    score: number;
    timestamp: number;
    temporality: SignalTemporality;
    raw?: unknown;
}

export interface AggregatorSnapshot {
    signals: NormalizedSignal[];
    staleness: Record<string, boolean>;
    timestamp: number;
}

// ---------------------------------------------------------------------------
// Pipeline slot indices
// ---------------------------------------------------------------------------

const SLOT = {
    CRYONIX: 0,
    COPYNIX: 1,
    PSINIX_STATE: 2,
    POLY_CRYPTO: 3,
    POLY_CRYPTO_PREV: 4,
    POLY_SUMMARY: 5,
    SOLANIX_POSITIONS: 6,
    SOLANIX_STATUS: 7,
    VEDIC: 8,
    CMC_FG: 9,
    CMC_GLOBAL: 10,
    AKTIENIX_POSITIONS: 11,
    ORAKEL_REGIME: 12,
    ORAKEL_VOLATILITY: 13,
} as const;

// Per-symbol ORAKEL keys are fetched in a second pipeline pass

// ---------------------------------------------------------------------------
// Symbol normalisation
// ---------------------------------------------------------------------------

function normalizeSymbol(raw: string): string {
    if (!raw) return 'UNKNOWN';
    return raw.split('/')[0].toUpperCase();
}

// ---------------------------------------------------------------------------
// SignalAggregator
// ---------------------------------------------------------------------------

export class SignalAggregator {
    constructor(
        private readonly redis: Redis,
        private readonly config: ApexTomlConfig,
    ) {}

    async snapshot(): Promise<AggregatorSnapshot> {
        const now = Date.now();
        const signals: NormalizedSignal[] = [];
        const staleness: Record<string, boolean> = {};
        const momentaryMs = this.config.staleness.momentary_seconds * 1000;
        const ambientMs = this.config.staleness.ambient_seconds * 1000;

        // ── Build pipeline ─────────────────────────────────────────────
        const pipe = this.redis.pipeline();
        pipe.get('trades:pending');           // 0: CRYONIX
        pipe.get('copynix:signals');          // 1: COPYNIX
        pipe.get('psinix:state');             // 2: PSINIX_STATE
        pipe.get('polymarket:crypto');        // 3: POLY_CRYPTO
        pipe.get('polymarket:crypto:prev');   // 4: POLY_CRYPTO_PREV (for delta)
        pipe.get('polymarket:summary');       // 5: POLY_SUMMARY
        pipe.get('solanix:positions');        // 6: SOLANIX_POSITIONS
        pipe.get('solanix:status');           // 7: SOLANIX_STATUS
        pipe.get('vedic:planets');            // 8: VEDIC
        pipe.get('cmc:fear_greed');           // 9: CMC_FG
        pipe.get('cmc:global');               // 10: CMC_GLOBAL
        pipe.get('aktienix:state');           // 11: AKTIENIX (state, not signals list)
        pipe.get('orakel:regime');            // 12: ORAKEL regime
        pipe.get('orakel:volatility');        // 13: ORAKEL volatility

        const results = await pipe.exec();
        if (!results) return { signals: [], staleness: {}, timestamp: now };

        const val = <T>(slot: number): T | null => {
            const entry = results[slot];
            if (!entry || entry[0]) return null;
            return entry[1] as T | null;
        };

        // ── 1. Cryonix — trades:pending (momentary) ───────────────────
        try {
            const raw = val<string>(SLOT.CRYONIX);
            if (raw) {
                const parsed = JSON.parse(raw);
                const entries: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
                let hasStale = false;

                for (const entry of entries) {
                    if (!entry || typeof entry !== 'object') continue;
                    const e = entry as Record<string, unknown>;
                    const ts = (e.timestamp as number) ?? now;
                    if (now - ts > momentaryMs) { hasStale = true; continue; }

                    const symbol = normalizeSymbol((e.symbol as string) ?? '');
                    const confidence = (e.confidence as number) ?? 0;
                    const patterns: string[] = Array.isArray(e.patterns) ? e.patterns as string[] : [];

                    for (const pattern of patterns) {
                        signals.push({
                            symbol, direction: 'bullish', source: 'cryonix',
                            signalType: String(pattern).toUpperCase(),
                            confidence, score: confidence, timestamp: ts,
                            temporality: 'momentary', raw: entry,
                        });
                    }
                }
                staleness['cryonix'] = hasStale && signals.filter(s => s.source === 'cryonix').length === 0;
            } else {
                staleness['cryonix'] = false;
            }
        } catch (err) {
            console.warn('[apex/aggregator] Cryonix parse error:', err instanceof Error ? err.message : err);
            staleness['cryonix'] = true;
        }

        // ── 2. Copynix — copynix:signals (momentary) ──────────────────
        try {
            const raw = val<string>(SLOT.COPYNIX);
            if (raw) {
                const entries: unknown[] = JSON.parse(raw);
                if (Array.isArray(entries)) {
                    let hasStale = false;
                    for (const entry of entries) {
                        if (!entry || typeof entry !== 'object') continue;
                        const e = entry as Record<string, unknown>;
                        const ts = (e.timestamp as number) ?? now;
                        if (now - ts > momentaryMs) { hasStale = true; continue; }
                        const score = (e.score as number) ?? 0;
                        if (score < 80) continue;
                        const rawSym = (e.symbol as string) ?? (e.token as string) ?? '';
                        signals.push({
                            symbol: normalizeSymbol(rawSym), direction: 'bullish', source: 'copynix',
                            signalType: 'whale_buy', confidence: Math.min(100, score), score,
                            timestamp: ts, temporality: 'momentary', raw: entry,
                        });
                    }
                    staleness['copynix'] = hasStale;
                }
            } else {
                staleness['copynix'] = false;
            }
        } catch (err) {
            console.warn('[apex/aggregator] Copynix parse error:', err instanceof Error ? err.message : err);
            staleness['copynix'] = true;
        }

        // ── 3. Ψnix — psinix:state (ambient — coherence is ongoing) ──
        try {
            const stateRaw = val<string>(SLOT.PSINIX_STATE);
            const stateObj = stateRaw ? JSON.parse(stateRaw) as Record<string, unknown> : null;
            const updatedAt = (stateObj?.updatedAt as number) ?? null;
            const isStale = updatedAt !== null ? (now - updatedAt > ambientMs) : false;
            staleness['psinix'] = isStale;

            if (!isStale && stateObj) {
                const positions: unknown[] = Array.isArray(stateObj.positions)
                    ? stateObj.positions as unknown[] : [];

                for (const pos of positions) {
                    if (!pos || typeof pos !== 'object') continue;
                    const p = pos as Record<string, unknown>;
                    const coherence = (p.coherenceAtEntry as number) ?? (p.coherence as number) ?? 0;
                    if (coherence < 0.7) continue;
                    const psi = (p.psiAtEntry as number) ?? (p.psi as number) ?? 0;
                    const side = (p.side as string) ?? '';
                    const direction: SignalDirection = psi >= 0 || side === 'LONG' ? 'bullish' : 'bearish';
                    signals.push({
                        symbol: normalizeSymbol((p.symbol as string) ?? ''),
                        direction, source: 'psinix', signalType: 'phase_convergence',
                        confidence: Math.round(coherence * 100),
                        score: Math.round(Math.abs(psi) * 100),
                        timestamp: (p.entryTime as number) ?? updatedAt ?? now,
                        temporality: 'ambient', raw: pos,
                    });
                }
            }
        } catch (err) {
            console.warn('[apex/aggregator] Ψnix parse error:', err instanceof Error ? err.message : err);
            staleness['psinix'] = true;
        }

        // ── 4. Polymarket — compute delta from crypto vs crypto:prev (ambient) ──
        try {
            const cryptoRaw = val<string>(SLOT.POLY_CRYPTO);
            const prevRaw = val<string>(SLOT.POLY_CRYPTO_PREV);
            if (cryptoRaw) {
                const current = JSON.parse(cryptoRaw) as Record<string, unknown>;
                const currentScore = (current.score as number) ?? 50;
                const ts = (current.updated_at as number) ?? (current.timestamp as number) ?? now;
                const isStale = now - ts > ambientMs;
                staleness['polymarket'] = isStale;

                if (!isStale) {
                    let delta = 0;
                    if (prevRaw) {
                        const prev = JSON.parse(prevRaw) as Record<string, unknown>;
                        const prevScore = (prev.score as number) ?? 50;
                        delta = currentScore - prevScore;
                    }

                    if (delta >= 20) {
                        signals.push({
                            symbol: 'CRYPTO', direction: 'bullish', source: 'polymarket',
                            signalType: 'sentiment_shift_bullish',
                            confidence: Math.min(100, 50 + delta), score: currentScore,
                            timestamp: ts, temporality: 'ambient', raw: { currentScore, delta },
                        });
                    } else if (delta <= -15) {
                        signals.push({
                            symbol: 'CRYPTO', direction: 'bearish', source: 'polymarket',
                            signalType: 'sentiment_shift_bearish',
                            confidence: Math.min(100, 50 + Math.abs(delta)), score: 100 - currentScore,
                            timestamp: ts, temporality: 'ambient', raw: { currentScore, delta },
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

        // ── 5. Vedic — vedic:planets (ambient) ────────────────────────
        try {
            const raw = val<string>(SLOT.VEDIC);
            if (raw) {
                const data = JSON.parse(raw) as Record<string, unknown>;
                const ts = (data.timestamp as number) ?? null;
                const isStale = ts !== null ? (now - ts > ambientMs) : false;
                staleness['vedic'] = isStale;

                if (!isStale) {
                    // Handle both { planets: { Venus: ... } } and { data: { planets: { Venus: ... } } }
                    let planets = data.planets as Record<string, Record<string, unknown>> | undefined;
                    if (!planets && data.data && typeof data.data === 'object') {
                        planets = (data.data as Record<string, unknown>).planets as Record<string, Record<string, unknown>> | undefined;
                    }

                    if (planets && typeof planets === 'object') {
                        const venus = planets['Venus'];
                        if (venus && venus.is_retrograde === true) {
                            signals.push({
                                symbol: 'MARKET', direction: 'bearish', source: 'vedic',
                                signalType: 'venus_rx', confidence: 90, score: 90,
                                timestamp: ts ?? now, temporality: 'ambient', raw: venus,
                            });
                        }
                        const mercury = planets['Mercury'];
                        if (mercury && mercury.is_retrograde === true) {
                            signals.push({
                                symbol: 'MARKET', direction: 'bearish', source: 'vedic',
                                signalType: 'mercury_rx', confidence: 60, score: 60,
                                timestamp: ts ?? now, temporality: 'ambient', raw: mercury,
                            });
                        }
                        const retrogradeCount = Object.values(planets).filter(p => p && p.is_retrograde === true).length;
                        if (retrogradeCount >= 3) {
                            signals.push({
                                symbol: 'MARKET', direction: 'bearish', source: 'vedic',
                                signalType: 'multi_retrograde',
                                confidence: Math.min(100, retrogradeCount * 15),
                                score: Math.min(100, retrogradeCount * 15),
                                timestamp: ts ?? now, temporality: 'ambient', raw: { retrogradeCount },
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

        // ── 6. CMC Fear & Greed (ambient) ──────────────────────────────
        try {
            const raw = val<string>(SLOT.CMC_FG);
            if (raw) {
                let value: number | null = null;
                let ts: number | null = null;
                const num = parseFloat(raw);
                if (!isNaN(num) && raw.trim() === String(num)) {
                    value = num;
                } else {
                    const parsed = JSON.parse(raw) as Record<string, unknown>;
                    value = (parsed.value as number) ?? null;
                    ts = (parsed.timestamp as number) ?? (parsed.updated_at as number) ?? null;
                }
                staleness['cmc'] = ts !== null ? (now - ts > ambientMs) : false;
                if (!staleness['cmc'] && value !== null && value <= 25) {
                    signals.push({
                        symbol: 'MARKET', direction: 'bullish', source: 'cmc',
                        signalType: 'extreme_fear',
                        confidence: Math.round((25 - value) * 2 + 50),
                        score: Math.round(100 - value),
                        timestamp: ts ?? now, temporality: 'ambient', raw: { fearGreed: value },
                    });
                }
            } else {
                staleness['cmc'] = false;
            }
        } catch (err) {
            console.warn('[apex/aggregator] CMC F&G parse error:', err instanceof Error ? err.message : err);
            staleness['cmc'] = true;
        }

        // ── 7. CMC Global — BTC dominance (ambient) ────────────────────
        try {
            const raw = val<string>(SLOT.CMC_GLOBAL);
            if (raw) {
                const data = JSON.parse(raw) as Record<string, unknown>;
                const btcDom = (data.btc_dominance as number) ?? null;
                const ts = (data.timestamp as number) ?? (data.updated_at as number) ?? null;
                const isStale = ts !== null ? (now - ts > ambientMs) : false;
                if (staleness['cmc'] === false || staleness['cmc'] === undefined) staleness['cmc'] = isStale;

                if (!isStale && btcDom !== null) {
                    const direction: SignalDirection = btcDom < 40 ? 'bullish' : 'bearish';
                    signals.push({
                        symbol: 'MARKET', direction, source: 'cmc', signalType: 'btc_dom',
                        confidence: 50,
                        score: direction === 'bullish' ? Math.round((40 - btcDom) * 2.5) : Math.round((btcDom - 40) * 2.5),
                        timestamp: ts ?? now, temporality: 'ambient', raw: { btcDominance: btcDom },
                    });
                }
            }
        } catch (err) {
            console.warn('[apex/aggregator] CMC Global parse error:', err instanceof Error ? err.message : err);
            staleness['cmc'] = true;
        }

        // ── 8. Aktienix — aktienix:state (ambient, sentiment proxy) ────
        // Note: aktienix:signals LIST doesn't exist. We read aktienix:state
        // and use open positions as a macro sentiment proxy.
        try {
            const raw = val<string>(SLOT.AKTIENIX_POSITIONS);
            if (raw) {
                const data = JSON.parse(raw) as Record<string, unknown>;
                const positions: unknown[] = Array.isArray(data.positions) ? data.positions as unknown[] : [];
                const ts = (data.updatedAt as number) ?? (data.timestamp as number) ?? now;
                staleness['aktienix'] = now - ts > ambientMs;

                if (!staleness['aktienix'] && positions.length > 0) {
                    // Aktienix has open positions → macro bullish sentiment (5pts)
                    signals.push({
                        symbol: 'MARKET', direction: 'bullish', source: 'aktienix',
                        signalType: 'macro_bullish', confidence: 50, score: 50,
                        timestamp: ts, temporality: 'ambient',
                        raw: { openPositions: positions.length },
                    });
                }
            } else {
                staleness['aktienix'] = false;
            }
        } catch (err) {
            console.warn('[apex/aggregator] Aktienix parse error:', err instanceof Error ? err.message : err);
            staleness['aktienix'] = true;
        }

        // ── 9. Solanix — solanix:positions + solanix:status (momentary) ──
        try {
            const posRaw = val<string>(SLOT.SOLANIX_POSITIONS);
            const statusRaw = val<string>(SLOT.SOLANIX_STATUS);

            const posData = posRaw ? JSON.parse(posRaw) as unknown[] : null;
            let statusData: Record<string, unknown> | null = null;
            try { if (statusRaw) statusData = JSON.parse(statusRaw) as Record<string, unknown>; } catch { /* plain string */ }

            const ts = statusData
                ? ((statusData.updated_at as number) ?? (statusData.updatedAt as number) ?? now)
                : now;
            staleness['solanix'] = now - ts > momentaryMs;

            if (!staleness['solanix']) {
                // Active positions as momentum signals
                const positions = Array.isArray(posData) ? posData : [];
                for (const pos of positions) {
                    if (!pos || typeof pos !== 'object') continue;
                    const p = pos as Record<string, unknown>;
                    const symbol = normalizeSymbol(String(p.symbol ?? ''));
                    const confidence = (p.confidence as number) ?? 0;
                    if (confidence > 0) {
                        signals.push({
                            symbol, direction: 'bullish', source: 'solanix',
                            signalType: 'dex_momentum',
                            confidence: Math.min(100, Math.round(confidence > 1 ? confidence : confidence * 100)),
                            score: Math.min(100, Math.round(confidence > 1 ? confidence : confidence * 100)),
                            timestamp: (p.openedAt as number) ?? (p.entryTime as number) ?? now,
                            temporality: 'momentary', raw: pos,
                        });
                    }
                }
            }
        } catch (err) {
            console.warn('[apex/aggregator] Solanix parse error:', err instanceof Error ? err.message : err);
            staleness['solanix'] = true;
        }

        // ── 10. ORAKEL — regime + volatility (ambient) ─────────────────
        try {
            if (this.config.orakel.enabled) {
                const regimeRaw = val<string>(SLOT.ORAKEL_REGIME);
                const volRaw = val<string>(SLOT.ORAKEL_VOLATILITY);

                if (regimeRaw) {
                    const regime = JSON.parse(regimeRaw) as Record<string, unknown>;
                    const regimeLabel = (regime.regime as string) ?? (regime.label as string) ?? '';
                    const ts = (regime.timestamp as number) ?? now;
                    staleness['orakel'] = now - ts > ambientMs;

                    if (!staleness['orakel']) {
                        if (regimeLabel === 'bull') {
                            signals.push({
                                symbol: 'MARKET', direction: 'bullish', source: 'orakel',
                                signalType: 'orakel_regime_bull', confidence: 70, score: 70,
                                timestamp: ts, temporality: 'ambient', raw: regime,
                            });
                        } else if (regimeLabel === 'bear') {
                            signals.push({
                                symbol: 'MARKET', direction: 'bearish', source: 'orakel',
                                signalType: 'orakel_regime_bear', confidence: 70, score: 70,
                                timestamp: ts, temporality: 'ambient', raw: regime,
                            });
                        }
                    }
                } else {
                    staleness['orakel'] = false;
                }

                // Vol spike veto
                if (volRaw && this.config.orakel.vol_spike_veto) {
                    const vol = JSON.parse(volRaw) as Record<string, unknown>;
                    if (vol.spike_warning === true) {
                        signals.push({
                            symbol: 'MARKET', direction: 'bearish', source: 'orakel',
                            signalType: 'orakel_vol_spike', confidence: 90, score: -20,
                            timestamp: (vol.timestamp as number) ?? now, temporality: 'ambient',
                            raw: vol,
                        });
                    }
                }

                // Per-symbol ORAKEL direction + fused confidence (second pipeline)
                await this.fetchOrakelPerSymbol(signals, staleness, now);
            }
        } catch (err) {
            console.warn('[apex/aggregator] ORAKEL parse error:', err instanceof Error ? err.message : err);
            staleness['orakel'] = true;
        }

        // ── Filter stale signals ───────────────────────────────────────
        const freshSignals = signals.filter(sig => !staleness[sig.source]);

        return { signals: freshSignals, staleness, timestamp: now };
    }

    /**
     * Fetch per-symbol ORAKEL direction and fused confidence.
     * Symbols come from the existing signals + venus_rx symbols.
     */
    private async fetchOrakelPerSymbol(
        signals: NormalizedSignal[],
        staleness: Record<string, boolean>,
        now: number,
    ): Promise<void> {
        const symbolSet = new Set<string>();
        for (const s of signals) {
            if (s.symbol !== 'MARKET' && s.symbol !== 'CRYPTO') symbolSet.add(s.symbol);
        }
        for (const sym of this.config.modes.venus_rx.symbols) {
            symbolSet.add(normalizeSymbol(sym));
        }

        if (symbolSet.size === 0) return;

        const symbols = [...symbolSet];
        const pipe = this.redis.pipeline();
        for (const sym of symbols) {
            pipe.get(`orakel:${sym}:direction`);
            pipe.get(`orakel:${sym}:fused`);
        }

        const results = await pipe.exec();
        if (!results) return;

        for (let i = 0; i < symbols.length; i++) {
            const sym = symbols[i];
            const dirEntry = results[i * 2];
            const fusedEntry = results[i * 2 + 1];

            // Direction
            if (dirEntry && !dirEntry[0] && dirEntry[1]) {
                try {
                    const dir = JSON.parse(dirEntry[1] as string) as Record<string, unknown>;
                    const prob = (dir.probability as number) ?? 0.5;
                    if (prob > 0.6) {
                        signals.push({
                            symbol: sym, direction: 'bullish', source: 'orakel',
                            signalType: 'orakel_direction_up', confidence: Math.round(prob * 100),
                            score: Math.round(prob * 100),
                            timestamp: (dir.timestamp as number) ?? now,
                            temporality: 'ambient', raw: dir,
                        });
                    } else if (prob < 0.4) {
                        signals.push({
                            symbol: sym, direction: 'bearish', source: 'orakel',
                            signalType: 'orakel_direction_down', confidence: Math.round((1 - prob) * 100),
                            score: Math.round((1 - prob) * 100),
                            timestamp: (dir.timestamp as number) ?? now,
                            temporality: 'ambient', raw: dir,
                        });
                    }
                } catch { /* skip malformed */ }
            }

            // Fused confidence
            if (fusedEntry && !fusedEntry[0] && fusedEntry[1]) {
                try {
                    const fused = JSON.parse(fusedEntry[1] as string) as Record<string, unknown>;
                    const conf = (fused.confidence as number) ?? (fused.fused as number) ?? 0;
                    if (conf > 0.7) {
                        const dir: SignalDirection = (fused.direction as string) === 'down' ? 'bearish' : 'bullish';
                        signals.push({
                            symbol: sym, direction: dir, source: 'orakel',
                            signalType: 'orakel_fused_high', confidence: Math.round(conf * 100),
                            score: Math.round(conf * 100),
                            timestamp: (fused.timestamp as number) ?? now,
                            temporality: 'ambient', raw: fused,
                        });
                    }
                } catch { /* skip malformed */ }
            }
        }
    }
}
