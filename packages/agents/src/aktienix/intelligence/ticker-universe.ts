// packages/agents/src/aktienix/intelligence/ticker-universe.ts

/**
 * Static set of valid NYSE/NASDAQ-listed tickers.
 * Covers S&P 500 + key Russell 1000 constituents (~500 tickers here, expand to ~1500 for prod).
 * Update quarterly on index rebalancing (next: June 2026).
 *
 * Source for full list: https://en.wikipedia.org/wiki/List_of_S%26P_500_companies
 * or download from https://github.com/datasets/s-and-p-500-companies
 */
export const VALID_TICKERS = new Set<string>([
    // ── Mega-cap Tech ──────────────────────────────────────────────
    'AAPL', 'MSFT', 'GOOGL', 'GOOG', 'AMZN', 'NVDA', 'META', 'TSLA', 'AVGO', 'ORCL',
    'ADBE', 'CRM', 'AMD', 'INTC', 'QCOM', 'TXN', 'MU', 'AMAT', 'KLAC', 'LRCX',
    'SNPS', 'CDNS', 'MRVL', 'NXPI', 'ON', 'STX', 'WDC', 'SWKS', 'QRVO', 'MPWR',
    // ── ETFs (sector + broad market) ─────────────────────────────
    'SPY', 'QQQ', 'IWM', 'DIA', 'VTI', 'VOO', 'XLK', 'XLE', 'XLF', 'XLV',
    'XLY', 'XLP', 'XLU', 'XLB', 'XLRE', 'XLI', 'XLC', 'GLD', 'SLV', 'USO',
    'UNG', 'DBA', 'ARKK', 'VGK',
    // ── Financials ────────────────────────────────────────────────
    'JPM', 'BAC', 'WFC', 'GS', 'MS', 'C', 'BLK', 'SCHW', 'AXP', 'V', 'MA',
    'COF', 'DFS', 'SYF', 'USB', 'TFC', 'PNC', 'FITB', 'KEY', 'RF', 'CFG',
    // ── Healthcare ────────────────────────────────────────────────
    'JNJ', 'UNH', 'LLY', 'PFE', 'MRK', 'ABBV', 'TMO', 'ABT', 'DHR', 'BMY',
    'AMGN', 'GILD', 'BIIB', 'VRTX', 'REGN', 'ISRG', 'SYK', 'MDT', 'EW', 'ZTS',
    'HCA', 'CVS', 'CI', 'HUM', 'CNC', 'MOH', 'ANTM', 'CAH', 'MCK', 'ABC',
    'MRNA', 'BNTX',
    // ── Energy ────────────────────────────────────────────────────
    'XOM', 'CVX', 'COP', 'EOG', 'SLB', 'PSX', 'VLO', 'MPC', 'OXY', 'DVN',
    'HAL', 'BKR', 'PXD', 'HES', 'FANG', 'APA', 'MRO', 'OKE', 'KMI', 'WMB',
    'ET', 'EPD', 'TRGP', 'LNG', 'AR', 'EQT',
    // ── Consumer Discretionary ────────────────────────────────────
    'HD', 'MCD', 'NKE', 'SBUX', 'LOW', 'TJX', 'BKNG', 'MAR',
    'HLT', 'CMG', 'ABNB', 'EXPE', 'LYFT', 'UBER', 'F', 'GM', 'RIVN', 'LCID',
    'TGT', 'AMZN',
    // ── Consumer Staples ──────────────────────────────────────────
    'WMT', 'PG', 'KO', 'PEP', 'COST', 'MDLZ', 'PM', 'MO', 'KHC', 'GIS',
    'K', 'CPB', 'SJM', 'HRL', 'TSN', 'CAG', 'MKC', 'CLX', 'CL', 'EL',
    'DG', 'DLTR',
    // ── Industrials ───────────────────────────────────────────────
    'GE', 'BA', 'HON', 'RTX', 'LMT', 'NOC', 'GD', 'HII', 'TDG',
    'CAT', 'DE', 'MMM', 'EMR', 'ETN', 'PH', 'ROK', 'DOV', 'IR', 'XYL',
    // ── Airlines & Transport ──────────────────────────────────────
    'UAL', 'DAL', 'AAL', 'LUV', 'JBLU', 'ALK', 'SAVE',
    'FDX', 'UPS', 'XPO', 'JBHT', 'ODFL', 'SAIA', 'CHRW',
    'CSX', 'UNP', 'NSC', 'KSU', 'CP', 'CNI',
    // ── Shipping / Logistics ──────────────────────────────────────
    'ZIM', 'MATX', 'KEX',
    // ── Real Estate ───────────────────────────────────────────────
    'AMT', 'PLD', 'CCI', 'EQIX', 'PSA', 'DLR', 'O', 'SPG', 'VICI', 'WY',
    // ── Utilities ─────────────────────────────────────────────────
    'NEE', 'DUK', 'SO', 'D', 'AEP', 'EXC', 'SRE', 'PCG', 'ED', 'WEC',
    // ── Materials ─────────────────────────────────────────────────
    'LIN', 'APD', 'SHW', 'FCX', 'NEM', 'NUE', 'STLD', 'CF', 'MOS', 'ALB',
    'DOW', 'LYB',
    // ── Agriculture ───────────────────────────────────────────────
    'ADM', 'BG', 'INGR',
    // ── Communications ────────────────────────────────────────────
    'NFLX', 'DIS', 'CMCSA', 'T', 'VZ', 'TMUS', 'CHTR', 'FOXA',
    // ── Defense ───────────────────────────────────────────────────
    'LHX', 'KTOS', 'CACI',
    // ── Casinos & Hospitality ─────────────────────────────────────
    'MGM', 'LVS', 'WYNN', 'CZR',
    // ── Biotech (additional) ──────────────────────────────────────
    'ILMN', 'EXAS', 'FATE', 'BEAM', 'EDIT', 'CRSP', 'NTLA',
    // ── Semiconductors ────────────────────────────────────────────
    'ASML', 'TSM', 'SMCI', 'ARM',
    // ── Software / Cloud ──────────────────────────────────────────
    'NOW', 'WDAY', 'SNOW', 'DDOG', 'NET', 'ZS', 'CRWD', 'PANW', 'FTNT',
    'OKTA', 'MDB', 'ESTC', 'CFLT', 'HCP', 'GTLB',
    // ── Fintech ───────────────────────────────────────────────────
    'PYPL', 'SQ', 'AFRM', 'UPST', 'SOFI', 'NU', 'HOOD', 'COIN',
    // ── EV / Clean Energy ─────────────────────────────────────────
    'TSLA', 'ENPH', 'SEDG', 'FSLR', 'RUN', 'PLUG', 'BLDP', 'HYZN',
    // ── Homebuilders ──────────────────────────────────────────────
    'DHI', 'LEN', 'PHM', 'NVR', 'TOL', 'KBH', 'MDC', 'MTH',
    // ── Insurance ─────────────────────────────────────────────────
    'BRK.B', 'MET', 'PRU', 'AFL', 'ALL', 'CB', 'TRV', 'PGR', 'HIG',
    // ── Medical Devices ───────────────────────────────────────────
    'BSX', 'BDX', 'RMD', 'HOLX', 'IDXX', 'PODD', 'DXCM',
    // ── Retail (specialty) ────────────────────────────────────────
    'ROST', 'BBWI', 'ANF', 'GPS', 'PVH', 'RL', 'LULU',
    // ── Restaurants ───────────────────────────────────────────────
    'YUM', 'QSR', 'DPZ', 'DNUT', 'JACK', 'DRI',
    // ── Aerospace ─────────────────────────────────────────────────
    'HWM', 'SPR', 'HEICO', 'LDOS', 'SAIC', 'BAH',
    // ── Extended S&P 500 / Russell 1000 coverage ──────────────────
    // Tech
    'ACN', 'IBM', 'HPQ', 'HPE', 'DELL', 'CSCO', 'ANET', 'JNPR', 'NTAP', 'PSTG',
    'FFIV', 'ZBRA', 'TTWO', 'EA', 'ATVI', 'RBLX', 'U', 'MTCH', 'SNAP', 'PINS',
    'TWTR', 'LYFT', 'ZM', 'DOCU', 'TEAM', 'HUBS', 'INTU', 'PAYC', 'PCTY', 'SPGI',
    'MSCI', 'MCO', 'FDS', 'ICE', 'CME', 'NDAQ', 'CBOE', 'TW', 'BR', 'FISV',
    'FIS', 'GPN', 'WEX', 'EPAM', 'CTSH', 'IT', 'LDOS', 'SAIC',
    // Healthcare extended
    'ALGN', 'HSIC', 'COO', 'STE', 'INSP', 'NVST', 'PDCO', 'PKI', 'WAT', 'A',
    'IQV', 'ICLR', 'SYNH', 'CRL', 'IQVIA', 'MEDP', 'PRGO', 'VTRS', 'AGN',
    'JAZZ', 'NBIX', 'IONS', 'ALNY', 'BMRN', 'RARE', 'ACAD', 'SGEN', 'RCUS',
    // Financials extended
    'ALLY', 'CMA', 'HBAN', 'MTB', 'FHN', 'ZION', 'FNB', 'CBSH', 'WTFC',
    'EWBC', 'IBOC', 'WAL', 'PACW', 'BOKF', 'CATY', 'FFIN', 'UMBF', 'SFBS',
    'BPOP', 'OFG', 'PBCT', 'TCF', 'SNV', 'SSB', 'CVBF', 'NBTB', 'TRMK',
    'STBA', 'NWBI', 'QCRH', 'FBMS', 'HFWA', 'SASR', 'CCBG', 'ACNB', 'FXNC',
    'RJF', 'LPLA', 'SF', 'SEIC', 'VRTS', 'APAM', 'ARES', 'APO', 'KKR', 'CG',
    'BX', 'TPG', 'HLNE', 'STEP', 'GCO',
    // Energy extended
    'RRC', 'CTRA', 'SM', 'MTDR', 'PARR', 'DKL', 'CAPL', 'MPLX', 'HFC', 'DINO',
    'VNOM', 'FANG', 'PR', 'NOG', 'CIVI', 'WTI', 'BATL', 'ESTE', 'TALO', 'GPOR',
    // Industrials extended
    'FAST', 'GWW', 'MSM', 'AIT', 'DNOW', 'HSII', 'MAN', 'RHI', 'KELYA',
    'KFRC', 'CDLX', 'CTAS', 'PAYC', 'PYCR', 'EXPO', 'HUBB', 'REXEL', 'AEI',
    'AWI', 'TREX', 'AZEK', 'BLDR', 'IBP', 'GRBK', 'TMHC', 'LGIH', 'BLD',
    'SWK', 'SNA', 'TKR', 'RBC', 'GNRC', 'AIMC', 'HLIO', 'SPXC', 'CFX',
    'LECO', 'ITT', 'ROPER', 'ROP', 'AMETEK', 'AME', 'LFUS', 'ISSC', 'MKSI',
    // Consumer extended
    'BBY', 'ETSY', 'W', 'OSTK', 'CHWY', 'PETQ', 'WOOF', 'SBH', 'ULTA',
    'FIVE', 'OLLI', 'BJ', 'CASY', 'MUSA', 'ARKO', 'GPM', 'PTRY', 'PRSP',
    'BGFV', 'HIBB', 'ASO', 'DKS', 'SIG', 'ZUMZ', 'BOOT', 'FL', 'SKX',
    'CROX', 'DECK', 'ONON', 'HBI', 'UAA', 'UA', 'GIL', 'CRI', 'HELE',
    'IPAR', 'REV', 'ELF', 'SKIN', 'ODD', 'KVYO', 'FRPT', 'BYND', 'SMPL',
    // Materials extended
    'CC', 'OLN', 'WLK', 'TROX', 'VNTR', 'IOSP', 'PRM', 'GVNB', 'AVNT',
    'HXL', 'CRS', 'ATI', 'KALU', 'CENX', 'AMR', 'ARCH', 'CEIX', 'HCC',
    'METC', 'NACCO', 'SXC', 'ARLP', 'CTRA', 'FMCSA',
    // Real Estate extended
    'EXR', 'CUBE', 'LSI', 'NSA', 'REXR', 'EGP', 'FR', 'STAG', 'COLD',
    'LINE', 'NNN', 'ADC', 'EPRT', 'NETSTREIT', 'GTY', 'KRG', 'ROIC', 'BRX',
    'REG', 'FRT', 'AKR', 'RPT', 'SITC', 'CBL', 'PEI', 'WPG', 'SKT',
    'MAC', 'PK', 'RLJ', 'DRH', 'SHO', 'PEB', 'APLE', 'CLDT', 'PLYA',
    'SVC', 'INN', 'HTLD', 'SUPN', 'NREF', 'BRMK', 'GPMT', 'TPVG',
    // Utilities extended
    'ETR', 'FE', 'AEE', 'CMS', 'NI', 'LNT', 'EVRG', 'OTTR', 'MGEE',
    'HE', 'AWK', 'AWR', 'YORW', 'ARTNA', 'MSEX', 'GWRS', 'CTWS', 'ARIS',
    'SWWC', 'PRMW', 'WMS', 'SPOK', 'LUMN', 'CNSL', 'SHEN', 'NTELOS',
    // Communications extended
    'DISH', 'SIRI', 'IHRT', 'CCOI', 'GSAT', 'IRDM', 'VSAT', 'MAXR',
    'RGEN', 'BSIG', 'CSWC', 'MAIN', 'GLAD', 'GAIN', 'GSBD', 'ORCC',
    'ARCC', 'BXSL', 'BLUE', 'TPVG', 'NMFC', 'OCSL', 'SLRC', 'PSEC',
    // Additional S&P 500 constituents
    'A', 'AAL', 'AAP', 'ABBV', 'ABC', 'ABMD', 'ABT', 'ACGL', 'ACN', 'ADP',
    'ADSK', 'AEE', 'AEP', 'AFL', 'AIG', 'AIZ', 'AJG', 'AKAM', 'ALB', 'ALGN',
    'ALK', 'ALL', 'ALLE', 'AMAT', 'AMCR', 'AMD', 'AME', 'AMG', 'AMP', 'AMT',
    'AMTM', 'AN', 'ANSS', 'AON', 'AOS', 'APA', 'APD', 'APH', 'APTV', 'ARE',
    'ATO', 'AVB', 'AVGO', 'AVY', 'AWK', 'AXP', 'AZO', 'BA', 'BAC', 'BALL',
    'BAX', 'BBWI', 'BBY', 'BDX', 'BEN', 'BF.B', 'BG', 'BIIB', 'BIO', 'BK',
    'BKNG', 'BKR', 'BLK', 'BMY', 'BR', 'BRK.B', 'BRO', 'BSX', 'BWA', 'BXP',
    'C', 'CAG', 'CAH', 'CARR', 'CAT', 'CB', 'CBOE', 'CBRE', 'CCI', 'CCL',
    'CDAY', 'CDNS', 'CDW', 'CE', 'CEG', 'CF', 'CFG', 'CHD', 'CHRW', 'CHTR',
    'CI', 'CINF', 'CL', 'CLX', 'CMA', 'CMCSA', 'CME', 'CMG', 'CMI', 'CMS',
    'CNC', 'CNP', 'COF', 'COO', 'COP', 'COST', 'CPB', 'CPRT', 'CPT', 'CRL',
    'CRM', 'CSCO', 'CSGP', 'CSX', 'CTAS', 'CTLT', 'CTRA', 'CTSH', 'CTVA',
    'CVS', 'CVX', 'CZR', 'D', 'DAL', 'DD', 'DE', 'DFS', 'DG', 'DGX', 'DHI',
    'DHR', 'DIS', 'DLR', 'DLTR', 'DOC', 'DOV', 'DOW', 'DPZ', 'DRI', 'DTE',
    'DUK', 'DVA', 'DVN', 'DXCM', 'EA', 'EBAY', 'ECL', 'ED', 'EFX', 'EG',
    'EIX', 'EL', 'ELV', 'EMN', 'EMR', 'ENPH', 'EOG', 'EPAM', 'EQIX', 'EQR',
    'EQT', 'ES', 'ESS', 'ETN', 'ETR', 'ETSY', 'EVRG', 'EW', 'EXC', 'EXPD',
    'EXPE', 'EXR', 'F', 'FANG', 'FAST', 'FCX', 'FDS', 'FDX', 'FE', 'FFIV',
    'FI', 'FICO', 'FIS', 'FITB', 'FMC', 'FOX', 'FOXA', 'FRT', 'FSLR', 'FTV',
    'GD', 'GDDY', 'GE', 'GEHC', 'GEN', 'GEV', 'GILD', 'GIS', 'GL', 'GLW',
    'GM', 'GNRC', 'GPC', 'GPN', 'GRMN', 'GS', 'GWW', 'HAL', 'HAS', 'HBAN',
    'HCA', 'HD', 'HES', 'HIG', 'HII', 'HLT', 'HOLX', 'HON', 'HPE', 'HPQ',
    'HRL', 'HSIC', 'HST', 'HSY', 'HUBB', 'HUM', 'HWM', 'IAC', 'IBM', 'ICE',
    'IDXX', 'IEX', 'IFF', 'ILMN', 'INCY', 'INTC', 'INTU', 'INVH', 'IP',
    'IPG', 'IQV', 'IR', 'IRM', 'ISRG', 'IT', 'ITW', 'IVZ', 'J', 'JBHT',
    'JCI', 'JKHY', 'JNJ', 'JNPR', 'JPM', 'K', 'KDP', 'KEY', 'KEYS', 'KHC',
    'KIM', 'KLAC', 'KMB', 'KMI', 'KMX', 'KO', 'KR', 'L', 'LDOS', 'LEN',
    'LH', 'LHX', 'LIN', 'LKQ', 'LLY', 'LMT', 'LNT', 'LOW', 'LRCX', 'LULU',
    'LUV', 'LVS', 'LW', 'LYB', 'LYV', 'MA', 'MAA', 'MAR', 'MAS', 'MCD',
    'MCHP', 'MCK', 'MCO', 'MDLZ', 'MDT', 'MET', 'MGM', 'MHK', 'MKC', 'MKTX',
    'MLM', 'MMC', 'MMM', 'MNST', 'MOH', 'MOS', 'MPC', 'MPWR', 'MRK', 'MRNA',
    'MRO', 'MS', 'MSCI', 'MSI', 'MTB', 'MTCH', 'MTD', 'MU', 'NDAQ', 'NEM',
    'NFLX', 'NI', 'NKE', 'NOC', 'NOV', 'NOW', 'NRG', 'NSC', 'NTAP', 'NTRS',
    'NUE', 'NVR', 'NWS', 'NWSA', 'NXPI', 'O', 'OGN', 'OKE', 'OMC', 'ON',
    'ORCL', 'OTIS', 'OXY', 'PAYC', 'PAYX', 'PCAR', 'PCG', 'PEG', 'PEP',
    'PFE', 'PFG', 'PG', 'PGR', 'PH', 'PHM', 'PKG', 'PLD', 'PM', 'PNC',
    'POOL', 'PPG', 'PPL', 'PRU', 'PSA', 'PSX', 'PTC', 'PWR', 'PYPL', 'QCOM',
    'RCL', 'REG', 'REGN', 'RF', 'RJF', 'RL', 'RMD', 'ROK', 'ROL', 'ROP',
    'ROST', 'RSG', 'RTX', 'SBAC', 'SBUX', 'SCHW', 'SHW', 'SJM', 'SLB', 'SMCI',
    'SNA', 'SNPS', 'SO', 'SPG', 'SPGI', 'SRE', 'STE', 'STLD', 'STT', 'STX',
    'STZ', 'SWK', 'SWKS', 'SYF', 'SYK', 'SYY', 'T', 'TAP', 'TDG', 'TDY',
    'TECH', 'TEL', 'TER', 'TFC', 'TFX', 'TGT', 'TJX', 'TMO', 'TMUS', 'TPR',
    'TRMB', 'TROW', 'TRV', 'TSCO', 'TSN', 'TT', 'TTWO', 'TXN', 'TXT', 'TYL',
    'UAL', 'UDR', 'UHS', 'ULTA', 'UNH', 'UNP', 'UPS', 'URI', 'USB', 'V',
    'VFC', 'VICI', 'VLO', 'VMC', 'VRSK', 'VRSN', 'VRTX', 'VTR', 'VTRS',
    'VZ', 'WAB', 'WAT', 'WBA', 'WBD', 'WEC', 'WELL', 'WFC', 'WM', 'WMB',
    'WMT', 'WRB', 'WRK', 'WST', 'WTW', 'WY', 'WYNN', 'XEL', 'XOM', 'XYL',
    'YUM', 'ZBH', 'ZBRA', 'ZTS',
]);

/**
 * Returns true if the ticker is a known valid US-listed equity or ETF.
 */
export function isValidTicker(ticker: string): boolean {
    return VALID_TICKERS.has(ticker);
}

/**
 * Filters an array of tickers, returning only those in the universe.
 */
export function filterValidTickers(tickers: string[]): string[] {
    return tickers.filter(isValidTicker);
}
