/**
 * Geopolitical & Macro Event Mapping
 * 
 * This file maps high-level macro events (e.g., "fed_rate_cut", "middle_east_tension")
 * to specific stock sectors, ETFs, and individual tickers.
 * 
 * Used by the StockNewsScanner to determine WHICH assets to buy/sell
 * based on the recognized global narrative.
 */

export interface MacroEventMapping {
    id: string;
    description: string;
    triggerKeywords: string[];
    bullishSectors: string[]; // e.g., 'energy', 'defense'
    bearishSectors: string[];
    bullishTickers: string[];
    bearishTickers: string[];
}

export const MACRO_EVENT_MAP: Record<string, MacroEventMapping> = {
    // ------------------------------------------------------------------------
    // GEOPOLITICAL TENSIONS
    // ------------------------------------------------------------------------
    middle_east_conflict: {
        id: 'middle_east_conflict',
        description: 'Escalation in the Middle East affecting oil supply lines.',
        triggerKeywords: ['iran', 'israel', 'strait of hormuz', 'oil facility attack', 'opec'],
        bullishSectors: ['energy', 'defense'],
        bearishSectors: ['airlines', 'consumer_discretionary'],
        bullishTickers: ['XLE', 'XOM', 'CVX', 'USO', 'LMT'], // Energy ETFs, Oil majors, Lockheed
        bearishTickers: ['UAL', 'DAL', 'AAL'] // Higher fuel costs hurt airlines
    },
    china_taiwan_tension: {
        id: 'china_taiwan_tension',
        description: 'Military posturing or economic sanctions between China and Taiwan.',
        triggerKeywords: ['taiwan', 'tsmc', 'south china sea', 'semiconductor blockade', 'sanctions'],
        bullishSectors: ['domestic_manufacturing', 'defense'],
        bearishSectors: ['semiconductors', 'consumer_electronics'],
        bullishTickers: ['LMT', 'RTX', 'INTC'], // Intel (domestic fab) might rally as hedge
        bearishTickers: ['TSM', 'AAPL', 'NVDA', 'AMD'] // Heavy reliance on Taiwan fabs
    },
    ukraine_russia_escalation: {
        id: 'ukraine_russia_escalation',
        description: 'Significant changes in the Ukraine/Russia conflict affecting European energy or global grain.',
        triggerKeywords: ['ukraine', 'putin', 'nord stream', 'nato escalation', 'gazprom'],
        bullishSectors: ['agriculture', 'natural_gas', 'defense'],
        bearishSectors: ['european_equities'],
        bullishTickers: ['UNG', 'DBA', 'ADM', 'BG', 'NOC'], // Gas ETF, Agri ETF, Archer-Daniels, Northrop
        bearishTickers: ['VGK'] // Europe ETF
    },

    // ------------------------------------------------------------------------
    // MACROECONOMIC POLICY (FED / INFLATION)
    // ------------------------------------------------------------------------
    fed_rate_cut: {
        id: 'fed_rate_cut',
        description: 'Federal Reserve cuts interest rates or signals dovish policy.',
        triggerKeywords: ['rate cut', 'powell dovish', 'fomc pivot', 'easing', 'qe'],
        bullishSectors: ['technology', 'real_estate', 'small_caps'],
        bearishSectors: ['financials'], // Lower net interest margin for banks
        bullishTickers: ['QQQ', 'ARKK', 'IWM', 'XLRE'], // Growth loves low rates, small caps benefit
        bearishTickers: ['XLF', 'JPM', 'BAC']
    },
    fed_rate_hike: {
        id: 'fed_rate_hike',
        description: 'Federal Reserve raises interest rates or signals hawkish policy to fight inflation.',
        triggerKeywords: ['rate hike', 'powell hawkish', 'inflation hot', 'cpi beat', 'tightening'],
        bullishSectors: ['financials'], // Banks profit from higher interest rates
        bearishSectors: ['technology', 'real_estate', 'utilities'],
        bullishTickers: ['XLF', 'JPM', 'BAC', 'WFC'],
        bearishTickers: ['QQQ', 'ARKK', 'XLRE', 'XLU'] // Tech multiples compress, yields hurt utilities
    },
    inflation_surge: {
        id: 'inflation_surge',
        description: 'CPI/PPI reports show surprisingly high inflation.',
        triggerKeywords: ['cpi hot', 'inflation surge', 'ppi above expectations'],
        bullishSectors: ['materials', 'energy', 'consumer_staples'],
        bearishSectors: ['consumer_discretionary', 'technology'],
        bullishTickers: ['XLB', 'XLE', 'XLP', 'GLD'], // Basic materials, gold, staples (pricing power)
        bearishTickers: ['XLY', 'AMZN', 'TSLA'] // Consumers stop buying luxury/discretionary
    },

    // ------------------------------------------------------------------------
    // REGULATORY & TRADE
    // ------------------------------------------------------------------------
    trade_war_tariffs: {
        id: 'trade_war_tariffs',
        description: 'New tariffs or trade restrictions, often US-China.',
        triggerKeywords: ['tariffs', 'trade war', 'export controls', 'wto violation'],
        bullishSectors: ['domestic_small_caps'], // Less exposed to international supply chains
        bearishSectors: ['multinationals', 'semiconductors'],
        bullishTickers: ['IWM'], // Russell 2000
        bearishTickers: ['AAPL', 'TSLA', 'BABA', 'FXI'] // Heavy China exposure or Chinese ETFs
    },
    tech_antitrust: {
        id: 'tech_antitrust',
        description: 'DOJ or EU launches massive antitrust lawsuit against Big Tech.',
        triggerKeywords: ['doj lawsuit', 'antitrust probe', 'eu fine', 'break up monopoly', 'ftc action'],
        bullishSectors: [], // Usually a drag on the whole index due to weighting
        bearishSectors: ['mega_cap_tech'],
        bullishTickers: [],
        bearishTickers: ['GOOGL', 'AAPL', 'META', 'AMZN']
    }
};

/**
 * Given a set of matched event IDs, expand them into a playable watchlist.
 */
export function expandEventsToWatchlist(eventIds: string[]): { bullish: string[], bearish: string[] } {
    const bullish = new Set<string>();
    const bearish = new Set<string>();

    for (const id of eventIds) {
        const mapping = MACRO_EVENT_MAP[id];
        if (mapping) {
            mapping.bullishTickers.forEach(t => bullish.add(t));
            mapping.bearishTickers.forEach(t => bearish.add(t));
        }
    }

    return {
        bullish: Array.from(bullish),
        bearish: Array.from(bearish)
    };
}
