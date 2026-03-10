/**
 * Curated list of high-signal X (Twitter) accounts and news sources.
 * 
 * Used by the Grok News Scanner to focus search queries on accounts
 * that historically move markets, rather than general noise.
 */

export const NEWS_SOURCES = {
    // ------------------------------------------------------------------------
    // MACRO & BREAKING NEWS (The "Terminal" alternatives)
    // ------------------------------------------------------------------------
    breaking_market: [
        "@WalterBloomberg", // Auto-posts Bloomberg terminal headlines
        "@DeItaone",        // The infamous ForexLive/Terminal leaker
        "@FirstSquawk",     // Audio squawk transcribed to text, extremely fast
        "@FinancialJuice"   // Fast breaking news and algos
    ],

    // ------------------------------------------------------------------------
    // FEDERAL RESERVE & ECONOMY
    // ------------------------------------------------------------------------
    fed_watchers: [
        "@NickTimiraos",    // WSJ Chief Economics Correspondent (The "Fed Whisperer")
        "@bespokeinvest",   // Excellent macro data and chart interpretations
        "@unusual_whales",  // Options flow, congressional insider trading
        "@LizAnnSonders"    // Charles Schwab Chief Investment Strategist
    ],

    // ------------------------------------------------------------------------
    // GEOPOLITICS
    // ------------------------------------------------------------------------
    geopolitics: [
        "@OSINTdefender",   // Open Source Intelligence (military movements)
        "@Faytuks",         // Breaking geopolitical and military news
        "@spectatorindex",  // High-level global event summaries
        "@zerohedge"        // Contrarian macro (use with caution, but often fast on macro events)
    ],

    // ------------------------------------------------------------------------
    // SECTOR SPECIFIC
    // ------------------------------------------------------------------------
    sectors: {
        energy: [
            "@EIAgov",      // US Energy Information Admin
            "@JavierBlas",  // Bloomberg Energy Columnist
            "@Amena__Bakr"  // Energy Intelligence (OPEC focus)
        ],
        semiconductors: [
            "@dnystedt",    // Dan Nystedt (Taiwan supply chain focus)
            "@SKGroupIntl"  // Semi-cap equipment tracking
        ]
    },

    // ------------------------------------------------------------------------
    // SWEDISH MARKET (Local macro)
    // ------------------------------------------------------------------------
    swedish: [
        "@newsaborsen",     // Nyhetsbyrån Direkt (Svensk makro/börs)
        "@didigital",       // Dagens Industri Tech
        "@Riksbanken"       // Sveriges Riksbank
    ]
};

/**
 * Builds an X search query targeting specific groups of accounts.
 * 
 * @param categories which groups of accounts to include in the OR query
 * @param keywords optional keywords to filter the query
 */
export function buildXSearchQuery(categories: (keyof typeof NEWS_SOURCES)[], keywords?: string): string {
    const accounts = new Set<string>();

    for (const cat of categories) {
        const group = NEWS_SOURCES[cat];
        if (Array.isArray(group)) {
            group.forEach(acc => accounts.add(acc));
        } else if (typeof group === 'object') {
            // Flatten nested groups (like sectors)
            for (const subGroup of Object.values(group)) {
                subGroup.forEach((acc: string) => accounts.add(acc));
            }
        }
    }

    // Format: (from:account1 OR from:account2) [keywords]
    const fromQuery = `(${Array.from(accounts).map(acc => `from:${acc.replace('@', '')}`).join(' OR ')})`;

    if (keywords) {
        return `${fromQuery} ${keywords}`;
    }
    return fromQuery;
}
