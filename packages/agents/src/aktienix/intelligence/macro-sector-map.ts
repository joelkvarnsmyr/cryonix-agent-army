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
    },

    // ------------------------------------------------------------------------
    // ENERGY SPECIFIC
    // ------------------------------------------------------------------------
    oil_supply_shock: {
        id: 'oil_supply_shock',
        description: 'OPEC production cuts, SPR release, or major supply disruption causing oil price spike.',
        triggerKeywords: ['opec cut', 'spr release', 'oil inventory draw', 'brent spike', 'wti surge', 'crude supply'],
        bullishSectors: ['energy'],
        bearishSectors: ['airlines', 'transport', 'consumer_discretionary'],
        bullishTickers: ['XOM', 'CVX', 'OXY', 'XLE', 'USO', 'SLB', 'COP'],
        bearishTickers: ['UAL', 'DAL', 'AAL', 'FDX', 'UPS', 'LUV'],
    },
    gas_price_surge: {
        id: 'gas_price_surge',
        description: 'Natural gas price spike due to supply disruption or extreme weather demand.',
        triggerKeywords: ['natural gas spike', 'lng shortage', 'henry hub surge', 'gas storage draw'],
        bullishSectors: ['natural_gas', 'utilities_bearish'],
        bearishSectors: ['utilities', 'chemicals'],
        bullishTickers: ['UNG', 'AR', 'LNG', 'EQT'],
        bearishTickers: ['DOW', 'LYB', 'WEC', 'SO'],
    },

    // ------------------------------------------------------------------------
    // TRANSPORT & SHIPPING
    // ------------------------------------------------------------------------
    port_strike: {
        id: 'port_strike',
        description: 'Major US port strike disrupting import/export supply chains.',
        triggerKeywords: ['port strike', 'longshoremen', 'dock workers', 'ila strike', 'ilwu strike'],
        bullishSectors: ['domestic_transport', 'air_freight'],
        bearishSectors: ['retail', 'consumer_electronics', 'automotive'],
        bullishTickers: ['FDX', 'UPS', 'XPO', 'JBHT'],
        bearishTickers: ['WMT', 'TGT', 'HD', 'F', 'GM'],
    },
    airline_fuel_shock: {
        id: 'airline_fuel_shock',
        description: 'Jet fuel cost surge materially impacting airline profitability guidance.',
        triggerKeywords: ['jet fuel', 'airline fuel cost', 'kerosene price', 'carrier hedging'],
        bullishSectors: [],
        bearishSectors: ['airlines'],
        bullishTickers: [],
        bearishTickers: ['UAL', 'DAL', 'AAL', 'LUV', 'JBLU'],
    },

    // ------------------------------------------------------------------------
    // HEALTHCARE
    // ------------------------------------------------------------------------
    pandemic_fear: {
        id: 'pandemic_fear',
        description: 'New pathogen or virus outbreak triggering global health emergency concerns.',
        triggerKeywords: ['pandemic', 'novel virus', 'who emergency', 'outbreak spreading', 'bird flu', 'h5n1'],
        bullishSectors: ['healthcare', 'biotech', 'staples'],
        bearishSectors: ['travel', 'hospitality', 'consumer_discretionary'],
        bullishTickers: ['PFE', 'MRNA', 'BNTX', 'GILD', 'ABBV', 'XLP'],
        bearishTickers: ['UAL', 'DAL', 'MAR', 'HLT', 'ABNB', 'MGM'],
    },
    drug_approval_major: {
        id: 'drug_approval_major',
        description: 'FDA approves or rejects a major blockbuster drug with >$5B market potential.',
        triggerKeywords: ['fda approved', 'fda approval', 'fda rejected', 'pdufa', 'new drug application'],
        bullishSectors: ['biotech'],
        bearishSectors: [],
        bullishTickers: [],
        bearishTickers: [],
    },

    // ------------------------------------------------------------------------
    // CONSUMER & RETAIL
    // ------------------------------------------------------------------------
    consumer_confidence_drop: {
        id: 'consumer_confidence_drop',
        description: 'Consumer confidence index falls sharply, signaling reduced discretionary spending.',
        triggerKeywords: ['consumer confidence miss', 'sentiment plunges', 'michigan sentiment below'],
        bullishSectors: ['consumer_staples', 'discount_retail'],
        bearishSectors: ['consumer_discretionary', 'luxury'],
        bullishTickers: ['WMT', 'COST', 'DG', 'DLTR', 'XLP'],
        bearishTickers: ['AMZN', 'TGT', 'SBUX', 'NKE', 'BKNG'],
    },
    housing_slowdown: {
        id: 'housing_slowdown',
        description: 'Housing starts, permits, or existing home sales fall sharply.',
        triggerKeywords: ['housing starts miss', 'existing home sales drop', 'mortgage rates surge', 'housing permits'],
        bullishSectors: [],
        bearishSectors: ['homebuilders', 'real_estate', 'home_improvement'],
        bullishTickers: [],
        bearishTickers: ['HD', 'LOW', 'DHI', 'LEN', 'PHM', 'XLRE'],
    },

    // ------------------------------------------------------------------------
    // EARNINGS (SECTOR-WIDE)
    // ------------------------------------------------------------------------
    sector_earnings_miss: {
        id: 'sector_earnings_miss',
        description: 'Multiple companies in the same sector miss earnings, indicating structural sector weakness.',
        triggerKeywords: ['earnings miss', 'eps below', 'revenue miss', 'guidance cut', 'warns on earnings'],
        bullishSectors: [],
        bearishSectors: [],
        bullishTickers: [],
        bearishTickers: [],
    },
    recession_fear: {
        id: 'recession_fear',
        description: 'GDP contraction, yield curve inversion, or major bank forecasts recession.',
        triggerKeywords: ['recession', 'gdp contraction', 'yield curve inverted', 'soft landing fails', 'hard landing'],
        bullishSectors: ['consumer_staples', 'utilities', 'healthcare'],
        bearishSectors: ['financials', 'consumer_discretionary', 'industrials'],
        bullishTickers: ['XLP', 'XLU', 'XLV', 'GLD', 'TLT'],
        bearishTickers: ['XLF', 'XLY', 'XLI', 'JPM', 'BAC'],
    },
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
