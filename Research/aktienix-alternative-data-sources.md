# Aktienix Alternative Data Sources — Free & Cheap APIs for Edge

> Research date: 2026-03-18
> Purpose: Identify working, free/cheap alternative data APIs for Aktienix US stock trading

---

## 1. Insider Trading / SEC Filings (Form 4, 13F, 13D)

### 1a. SEC EDGAR — Official API (FREE, no auth)

**Submissions API** — Get all filings for any company/insider by CIK:
```
GET https://data.sec.gov/submissions/CIK{10-digit-CIK}.json
```

- **Free**: Yes, completely free, no API key needed
- **Rate limit**: 10 requests/second (must set User-Agent header to your email)
- **Format**: JSON
- **Data**: Filing history including Form 4, 13F, 13D — at least 1 year or 1,000 filings
- **Latency**: Sub-second processing delay
- **Headers required**: `User-Agent: YourApp/1.0 (your@email.com)`

Example — Apple filings:
```
https://data.sec.gov/submissions/CIK0000320193.json
```

The `recentFilings` array contains `form`, `filingDate`, `accessionNumber` — filter for `form === "4"` to get insider trades.

### 1b. SEC EDGAR Full-Text Search (EFTS) — FREE

```
GET https://efts.sec.gov/LATEST/search-index?q=AAPL&forms=4&dateRange=custom&startdt=2026-03-01&enddt=2026-03-18
```

- **Free**: Yes, no auth
- **Rate limit**: 10 req/sec
- **Format**: JSON, 100 results per page (paginate with `from=` parameter)
- **Filters**: `forms` (comma-separated), `dateRange`, `startdt`, `enddt`, `entityName`
- **Since**: 2001

### 1c. Finnhub Insider Transactions (FREE tier)

```
GET https://finnhub.io/api/v1/stock/insider-transactions?symbol=AAPL&token={API_KEY}
```

- **Free tier**: 60 calls/minute, free API key via finnhub.io
- **Format**: JSON
- **Data**: Insider name, share count, transaction type, value, filing date
- **Signal use**: Cluster buys from 3+ insiders = strong buy signal

### 1d. Bulk Form 4 data — SEC EDGAR RSS

```
https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&dateb=&owner=include&count=40&search_text=&start=0&output=atom
```

- **Free**: Yes
- **Format**: Atom/XML feed of latest Form 4 filings
- **Use**: Poll every 5 minutes for new insider trades across all companies

**Trading signal**: Insider cluster buys (3+ officers buying within 2 weeks) have historically outperformed the market by 6-10% annually.

---

## 2. Congressional Trading (STOCK Act)

### 2a. Finnhub Congressional Trading (FREE tier)

```
GET https://finnhub.io/api/v1/stock/congressional-trading?symbol=AAPL&token={API_KEY}
```

- **Free tier**: 60 calls/minute
- **Format**: JSON
- **Data**: Representative name, amount range, filing date, transaction type (Sale/Purchase), asset name
- **Signal use**: Follow congress members with best historical returns

### 2b. QuiverQuant API

```
GET https://api.quiverquant.com/beta/historical/congresstrading/{TICKER}
```

- **Free tier**: Limited (requires API key from quiverquant.com)
- **Format**: JSON
- **Data**: All disclosed congressional trades by ticker
- **Note**: Free tier may be restricted; check current pricing

### 2c. Capitol Trades (Web scraping)

```
https://www.capitoltrades.com/trades
```

- **Free**: Website is free to browse
- **No public API** — requires scraping
- **Data**: Senator/representative trades with filing dates, amounts, asset descriptions

**Trading signal**: Congress members who sit on oversight committees have shown edge in related sectors. Track their buys.

---

## 3. Options Flow / Put-Call Ratios

### 3a. CBOE Put/Call Ratio (FREE CSV)

Historical aggregate put/call ratio:
```
https://cdn.cboe.com/resources/options/volume_and_call_put_ratios/indexpcarchive.csv
```

Daily market statistics page:
```
https://www.cboe.com/us/options/market_statistics/daily/
```

- **Free**: Yes, direct CSV download
- **Format**: CSV (date, call volume, put volume, P/C ratio)
- **Update**: Daily
- **Signal use**: P/C ratio > 1.0 = bearish sentiment (contrarian buy), < 0.7 = greedy (caution)

### 3b. Barchart Unusual Options Activity

```
https://www.barchart.com/options/unusual-activity
```

- **Free**: Website browsable, CSV download for registered users (free)
- **Criteria**: Volume > 500, OI > 100, Vol/OI > 1.25
- **No free API** — scraping or Barchart OnDemand API ($)

### 3c. Finnhub Options Data (FREE tier — limited)

Finnhub has some options endpoints but they are more limited in the free tier.

**Trading signal**: Extreme P/C ratio (>1.2) is a contrarian buy signal — historically leads to 2-4% bounce within 5 trading days.

---

## 4. Short Interest Data

### 4a. FINRA Short Interest (FREE — delayed)

Website:
```
https://otctransparency.finra.org/otctransparency/
```

Downloadable files:
```
https://www.finra.org/finra-data/browse-catalog/equity-short-interest/files
```

- **Free**: Yes, delayed 2-4 weeks depending on tier
- **Format**: Pipe-delimited text files, downloadable
- **Data**: Short interest by security, bi-monthly snapshots
- **Coverage**: 5 rolling years

### 4b. FINRA Developer API (FREE registration)

```
Base URL: https://api.finra.org
Auth endpoint: https://ews.fip.finra.org/fip/rest/ews/oauth2/access_token?grant_type=client_credentials
```

- **Free**: Public credentials are free (register at developer.finra.org)
- **Auth**: OAuth 2.0 (Client ID + Secret, Base64 encoded)
- **Format**: JSON or CSV (set Accept header)
- **Endpoint**: `GET/POST /data/group/otcMarket/name/weeklysummary`
- **Data types**: ATS_W_SMBL (by issue), ATS_W_SMBL_FIRM (by ATS+issue), ATS_W_FIRM (by ATS)
- **Coverage**: Rolling 12 months (production), 4 years (historic)

### 4c. Finnhub Short Interest (FREE tier)

```
GET https://finnhub.io/api/v1/stock/short-interest?symbol=AAPL&token={API_KEY}
```

- **Free tier**: 60 calls/minute
- **Format**: JSON

**Trading signal**: Days-to-cover > 5 + rising price = short squeeze candidate. Short interest > 20% of float = elevated squeeze risk.

---

## 5. Earnings Estimates / Analyst Revisions

### 5a. Finnhub Earnings Estimates (FREE tier)

```
GET https://finnhub.io/api/v1/stock/earnings?symbol=AAPL&token={API_KEY}
```

EPS estimates:
```
GET https://finnhub.io/api/v1/stock/eps-estimate?symbol=AAPL&token={API_KEY}
```

Revenue estimates:
```
GET https://finnhub.io/api/v1/stock/revenue-estimate?symbol=AAPL&token={API_KEY}
```

- **Free tier**: 60 calls/minute
- **Format**: JSON
- **Data**: EPS actual vs estimate, surprise %, revenue estimates

### 5b. Alpha Vantage EARNINGS (FREE tier)

```
GET https://www.alphavantage.co/query?function=EARNINGS&symbol=AAPL&apikey={API_KEY}
```

- **Free tier**: 25 requests/day (free key at alphavantage.co)
- **Format**: JSON
- **Data**: Annual + quarterly EPS, analyst estimates, surprise amount/percentage
- **Limitation**: Very tight daily limit

### 5c. Financial Modeling Prep (FREE tier)

Analyst estimates:
```
GET https://financialmodelingprep.com/api/v3/analyst-estimates/AAPL?apikey={API_KEY}
```

Earnings calendar:
```
GET https://financialmodelingprep.com/api/v3/earnings-calendar?apikey={API_KEY}
```

Earnings surprises:
```
GET https://financialmodelingprep.com/api/v3/earnings-surprises/AAPL?apikey={API_KEY}
```

- **Free tier**: 250 requests/day (free key at financialmodelingprep.com)
- **Format**: JSON
- **Data**: Estimated/actual EPS+revenue, consensus estimates, analyst count

**Trading signal**: Positive EPS revision (last 30 days) + earnings in next 2 weeks = momentum buy. Companies that beat estimates by >10% tend to drift up 3-5% in the following month.

---

## 6. Social Sentiment

### 6a. ApeWisdom — Reddit/WallStreetBets (FREE)

Top mentioned tickers:
```
GET https://apewisdom.io/api/v1.0/filter/all-stocks
```

WallStreetBets only:
```
GET https://apewisdom.io/api/v1.0/filter/wallstreetbets
```

Paginated:
```
GET https://apewisdom.io/api/v1.0/filter/wallstreetbets/page/2
```

- **Free**: Yes, no API key needed
- **Format**: JSON
- **Data**: rank, ticker, name, mentions (24h), upvotes, rank_24h_ago, mentions_24h_ago
- **100 results per page**
- **Subreddits**: wallstreetbets, stocks, investing, CryptoCurrency, 4chan, 13+ others

### 6b. StockTwits API (FREE tier)

Trending symbols:
```
GET https://api.stocktwits.com/api/2/trending/symbols.json
```

Symbol stream with sentiment:
```
GET https://api.stocktwits.com/api/2/streams/symbol/AAPL.json
```

- **Free**: Yes, limited rate
- **Format**: JSON
- **Data**: Messages with bullish/bearish/neutral tags, trending symbols
- **Docs**: https://api-docs.stocktwits.com/

### 6c. Finnhub Social Sentiment (FREE tier)

```
GET https://finnhub.io/api/v1/stock/social-sentiment?symbol=AAPL&token={API_KEY}
```

- **Free tier**: 60 calls/minute
- **Format**: JSON
- **Data**: Reddit + Twitter mention counts, positive/negative scores
- **Platforms**: Reddit, Twitter

### 6d. Financial Modeling Prep Social Sentiment (FREE tier)

```
GET https://financialmodelingprep.com/api/v4/social-sentiment?symbol=AAPL&apikey={API_KEY}
```

- **Free tier**: 250 requests/day
- **Format**: JSON
- **Data**: Sentiment from Reddit, StockTwits, Twitter, Yahoo

**Trading signal**: Sudden 5x spike in WSB mentions + bullish sentiment > 70% = momentum play (enter early, exit fast). Contrarian: extreme bullish sentiment (>90%) is often a local top.

---

## 7. Economic Calendar

### 7a. Trading Economics (FREE with guest key)

```
GET https://api.tradingeconomics.com/calendar/country/United%20States?c=guest:guest&f=json
```

By date range:
```
GET https://api.tradingeconomics.com/calendar/country/United%20States/2026-03-18/2026-03-25?c=guest:guest&f=json
```

By indicator:
```
GET https://api.tradingeconomics.com/calendar/indicator/interest%20rate?c=guest:guest&f=json
```

- **Free**: Yes, `guest:guest` credentials work for basic access
- **Format**: JSON, CSV, or XML (set with `&f=json`)
- **Data**: CalendarId, Date, Country, Category, Event, Actual, Previous, Forecast, Importance
- **Groups**: interest rate, inflation, GDP, consumer, labor, housing, trade, business

### 7b. Finnhub Economic Calendar (FREE tier)

```
GET https://finnhub.io/api/v1/calendar/economic?token={API_KEY}
```

- **Free tier**: 60 calls/minute
- **Format**: JSON
- **Data**: Event, country, actual, estimate, previous, impact level

### 7c. Financial Modeling Prep Economic Calendar (FREE tier)

```
GET https://financialmodelingprep.com/api/v3/economic_calendar?apikey={API_KEY}
```

- **Free tier**: 250 requests/day
- **Format**: JSON
- **Data**: Event, date, country, actual, previous, consensus, impact

**Trading signal**: FOMC days historically have higher volatility. CPI above consensus = sell tech, buy commodities. NFP miss = risk-off.

---

## 8. Dark Pool / Institutional Flow

### 8a. FINRA ATS Transparency API (FREE registration)

```
Base: https://api.finra.org
Endpoint: POST /data/group/otcMarket/name/weeklysummary
```

Query for ATS data by symbol:
```json
{
  "compareFilters": [
    {"fieldName": "summaryTypeCode", "fieldValue": "ATS_W_SMBL", "compareType": "EQUAL"},
    {"fieldName": "issueSymbolIdentifier", "fieldValue": "AAPL", "compareType": "EQUAL"}
  ]
}
```

- **Free**: Public credentials free at developer.finra.org
- **Auth**: OAuth 2.0 (Client ID + Secret -> Bearer token)
- **Format**: JSON or CSV
- **Data**: Weekly ATS trade count, share volume, by ATS firm + symbol
- **Delay**: 2-4 weeks
- **Coverage**: Rolling 12 months (production), 4 years (historic)

### 8b. FINRA OTC Transparency Website (FREE)

```
https://otctransparency.finra.org/otctransparency/
```

- **Free**: Yes, downloadable data
- **Format**: CSV/Excel files
- **Data**: Weekly dark pool volume by security, by ATS

**Trading signal**: Dark pool volume > 40% of total volume + rising price = institutional accumulation (bullish). Dark pool volume spike + flat price = institutions front-running before a move.

---

## 9. Fear & Greed Index

### 9a. CNN Fear & Greed Index (FREE, no auth)

Current + historical data:
```
GET https://production.dataviz.cnn.io/index/fearandgreed/graphdata/2026-01-01
```

- **Free**: Yes, no API key needed
- **Format**: JSON
- **Data**: `fear_and_greed_historical.data[]` with `x` (unix ms timestamp) and `y` (index 0-100)
- **History**: Since September 2020
- **Components**: Market momentum, stock price strength/breadth, put/call options, junk bond demand, market volatility, safe haven demand

### 9b. Python package (pip install)

```bash
pip install fear-and-greed
```

Wraps the CNN endpoint above.

### 9c. RapidAPI CNN Fear & Greed

```
GET https://cnn-fear-and-greed-index.p.rapidapi.com/
```

- **Free tier**: Limited calls via RapidAPI
- **Requires**: RapidAPI key

**Trading signal**: F&G < 25 (Extreme Fear) = contrarian buy. F&G > 75 (Extreme Greed) = reduce exposure. Historically, buying at Extreme Fear and holding 1 year returns 15-20% on average.

---

## 10. Sector Rotation Signals

### 10a. Finnhub Sector Performance (FREE tier)

```
GET https://finnhub.io/api/v1/stock/sector-performance?token={API_KEY}
```

- **Free tier**: 60 calls/minute
- **Format**: JSON

### 10b. Financial Modeling Prep Sector Performance (FREE tier)

```
GET https://financialmodelingprep.com/api/v3/sector-performance?apikey={API_KEY}
```

Historical sector performance:
```
GET https://financialmodelingprep.com/api/v3/historical-sectors-performance?apikey={API_KEY}
```

ETF prices (proxy for sector flows):
```
GET https://financialmodelingprep.com/api/v3/historical-price-full/XLK?apikey={API_KEY}
```

- **Free tier**: 250 requests/day
- **Format**: JSON
- **Sectors**: Technology, Healthcare, Financials, Energy, Consumer, Industrials, etc.

### 10c. Alpha Vantage Sector Performance (FREE)

```
GET https://www.alphavantage.co/query?function=SECTOR&apikey={API_KEY}
```

- **Free**: 25 requests/day
- **Format**: JSON
- **Data**: Real-time, 1D, 5D, 1M, 3M, YTD, 1Y, 3Y, 5Y, 10Y sector returns

### 10d. DIY Sector Rotation via ETF Prices

Track sector ETFs via any free price API (Finnhub, Alpha Vantage):
- XLK (Tech), XLF (Financials), XLE (Energy), XLV (Healthcare)
- XLI (Industrials), XLP (Consumer Staples), XLY (Consumer Discretionary)
- XLB (Materials), XLU (Utilities), XLRE (Real Estate), XLC (Communication)

Calculate: 20-day relative strength vs SPY. Overweight top 3, underweight bottom 3.

**Trading signal**: Money flowing from defensive (XLU, XLP) to cyclical (XLI, XLY) = risk-on rotation. Reverse = risk-off. Track 5-day rate of change in relative strength.

---

## Summary: Best Free APIs by Priority

| Priority | Source | API | Free Limit | Best Signal |
|----------|--------|-----|------------|-------------|
| 1 | **Finnhub** | finnhub.io | 60/min | Insider, congress, sentiment, earnings, economic cal |
| 2 | **SEC EDGAR** | data.sec.gov | 10/sec | Insider Form 4, 13F institutional holdings |
| 3 | **CNN F&G** | production.dataviz.cnn.io | Unlimited | Market sentiment regime |
| 4 | **ApeWisdom** | apewisdom.io | Unlimited | Reddit/WSB mention spikes |
| 5 | **FMP** | financialmodelingprep.com | 250/day | Earnings estimates, sector rotation |
| 6 | **Trading Economics** | api.tradingeconomics.com | guest:guest | Economic calendar (FOMC, CPI, NFP) |
| 7 | **CBOE** | cdn.cboe.com | Unlimited | Put/call ratio (daily CSV) |
| 8 | **FINRA** | api.finra.org | Free reg | Dark pool volume, short interest |
| 9 | **StockTwits** | api.stocktwits.com | Limited | Real-time retail sentiment |
| 10 | **Alpha Vantage** | alphavantage.co | 25/day | Sector performance, earnings |

## Recommended Implementation Order for Aktienix

1. **Finnhub** — Single API key gets you insider trades, congressional trades, social sentiment, economic calendar, earnings estimates. Best bang for buck.
2. **CNN Fear & Greed** — No key needed, instant market regime signal. Use as position sizing multiplier.
3. **SEC EDGAR** — No key needed. Poll RSS feed for Form 4 cluster buys.
4. **ApeWisdom** — No key needed. Monitor WSB mention velocity for momentum plays.
5. **Trading Economics** — guest:guest key. Pre-market check for today's economic events.
6. **CBOE P/C Ratio** — Daily CSV download. Contrarian sentiment indicator.
7. **FMP** — Earnings estimates + surprises. Pre-earnings positioning.
8. **FINRA Dark Pool** — Weekly institutional flow analysis. Accumulation detection.

---

## API Key Registration Links

- Finnhub: https://finnhub.io/register (free, instant)
- FMP: https://financialmodelingprep.com/register (free, instant)
- Alpha Vantage: https://www.alphavantage.co/support/#api-key (free, instant)
- FINRA Developer: https://developer.finra.org (free, registration process)
- StockTwits: https://api-docs.stocktwits.com/ (free, OAuth app)
- SEC EDGAR: No registration needed (just set User-Agent header)
- CNN F&G: No registration needed
- ApeWisdom: No registration needed
- Trading Economics: No registration needed (guest:guest)
- CBOE: No registration needed (direct CSV)
