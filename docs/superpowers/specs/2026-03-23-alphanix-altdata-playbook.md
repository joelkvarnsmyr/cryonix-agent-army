# Alphanix Alternative Data Playbook

**Date:** 2026-03-23
**Status:** Draft
**Companion to:** [Alphanix Design Spec](2026-03-23-alphanix-design.md)

## How Alternative Data Creates Alpha

In modern quantitative finance, traditional data — price, volume, quarterly earnings reports — is available to everyone simultaneously. When millions of participants see the same data at the same time, there is no informational edge.

The edge comes from **alternative data**: unconventional information sources that reveal economic activity *before* it shows up in official numbers. A satellite image of a parking lot tells you Walmart's foot traffic three months before the earnings call. A ship's draft measurement tells you iron ore export volumes weeks before the trade balance report. A CEO's private jet landing at an obscure airport hints at a merger before anyone files with the SEC.

Hedge funds like Citadel, Two Sigma, and Point72 spend $100M+ per year acquiring and processing alternative data. Alphanix's thesis is simple: enough of this data is now available through free and freemium APIs that an AI agent army — with the right ingestion pipeline and analytical framework — can extract meaningful alpha without the hedge fund budget.

This playbook catalogs every data source Alphanix targets, organized by category, with concrete examples of how each translates into trading signals.

---

## Data Acquisition Methods

### 1. APIs from Specialized Data Brokers

Professional data vendors (YipitData, Eagle Alpha, Quandl/Nasdaq, Planet Labs) package raw data into clean, structured feeds delivered via REST or WebSocket APIs. Subscription costs range from $500/month for basic feeds to $50,000+/month for institutional-grade datasets. Alphanix targets free tiers and open-data equivalents for Phase 1, graduating to paid feeds as portfolio size justifies the cost.

### 2. Direct Network Connections (Market Data)

At the highest tier, quantitative firms install dedicated fiber optic cables directly into exchange matching engines (co-location). Every tick, every order book change, every cancel-and-replace is captured with nanosecond precision. This costs millions in infrastructure and is irrelevant for Alphanix's timeframes (minutes to days, not microseconds). Mentioned here for completeness only.

### 3. Advanced Web Scraping & OSINT

Thousands of lightweight scripts running on schedules — reading government websites, counting social media mentions, monitoring DNS changes on corporate domains, parsing court filings. The raw material is public; the alpha is in the *speed* and *interpretation*. Alphanix's Swarm Pool is purpose-built for this: ephemeral worker threads that fan out, collect, clean, and deliver structured data to pod Data Engineers.

---

## The 6 Data Categories

### Category 1: Satellite & Geospatial Intelligence

Satellites photograph the Earth multiple times per day. Computer vision extracts economic signals invisible to ground-level observers.

#### Oil Tank Shadow Measurement (Cushing, Oklahoma)

| Attribute | Detail |
|-----------|--------|
| **What** | SAR (Synthetic Aperture Radar) satellites photograph floating-roof oil storage tanks. The roof physically rests on the oil surface — more oil pushes the roof up, less oil lets it sink. The sun creates a shadow proportional to the gap between the tank rim and the roof. |
| **Signal** | AI measures shadow length across every tank in Cushing, OK (the US crude oil pricing hub) and globally. Calculates exact crude oil inventory volumes. |
| **Trade** | Before the weekly EIA inventory report (Wednesday 10:30 ET), the fund already knows if reserves increased (bearish crude) or decreased (bullish crude). Front-run the official number. |
| **Sources** | ESA Copernicus Sentinel-1 SAR (free, 12-day revisit, 10m resolution) / Planet Labs SkySat (paid, daily, 50cm resolution) / Maxar WorldView (paid, sub-meter) |
| **API** | Copernicus Open Access Hub REST API — free registration, bulk download. Planet Labs API — paid plans starting ~$500/mo. |
| **Phase** | 1 (Copernicus) / 3 (Planet Labs, Maxar) |

#### Parking Lot Car Counting (Retail Earnings)

| Attribute | Detail |
|-----------|--------|
| **What** | Daily satellite images captured over thousands of retail chain parking lots across the US. Computer vision models count individual vehicles per store per day. |
| **Signal** | Aggregate foot traffic proxy for any publicly traded retailer: Walmart, Target, Costco, Home Depot, Starbucks. |
| **Trade** | If Walmart parking lots show 12% more cars in November vs prior year across 2,000+ locations, that is a statistically significant revenue signal. BUY WMT before Q4 earnings. Conversely, empty lots at Bed Bath & Beyond predicted bankruptcy months early. |
| **Sources** | Planet Labs (paid, daily revisit) / Google Earth Engine (free, but delayed 2-4 weeks) / Orbital Insight (paid, pre-processed retail metrics) |
| **API** | Google Earth Engine Python API (free with Google Cloud project). Planet Labs RESTful Data API. |
| **Phase** | 3 (actionable daily data requires paid sources) |

#### Crop Health & Agriculture (Commodity Futures)

| Attribute | Detail |
|-----------|--------|
| **What** | Multispectral and infrared satellites measure NDVI (Normalized Difference Vegetation Index) — a direct proxy for chlorophyll levels and plant health in agricultural regions. |
| **Signal** | Early drought detection in Brazilian coffee plantations, US corn belt, Ukrainian wheat fields. Months before harvest failure is officially reported. |
| **Trade** | Drought stress visible in Brazilian Minas Gerais coffee region (NDVI dropping below seasonal average) → BUY coffee futures (KC) months before the supply shock hits prices. Similarly: US corn NDVI anomaly → BUY corn futures (ZC). |
| **Sources** | ESA Copernicus Sentinel-2 (free, 5-day revisit, 10m multispectral) / NOAA AVHRR (free, daily, lower resolution) / NASA MODIS (free, daily, 250m-1km) / USDA CropScape (free, annual crop maps) |
| **API** | Copernicus Data Space Ecosystem API (free). NOAA CLASS (free). NASA Earthdata API (free, requires Earthdata login). |
| **Phase** | 1 |

---

### Category 2: Shipping & Logistics (AIS / Vessel Tracking)

Every commercial vessel over 300 gross tons broadcasts its position, speed, heading, and draft via AIS (Automatic Identification System). This is a real-time x-ray of global trade flows.

#### Vessel Draft Measurement (Commodity Volumes)

| Attribute | Detail |
|-----------|--------|
| **What** | AIS data includes ship draft — how deep the hull sits in the water. A loaded vessel sits deeper than an empty one. The relationship between draft and cargo tonnage is well-characterized for each vessel class. |
| **Signal** | AI calculates: "Bulk carrier *Nordic Orion* entered port of Narvik at 4.2m draft, departed at 7.8m draft → carrying approximately 6,400 tons of iron ore." Scale this across every port globally = real-time export/import volume estimates. |
| **Trade** | Iron ore exports from Narvik surging → BUY iron ore futures. Chinese port congestion increasing (vessels queuing) → supply chain bottleneck → SELL retail stocks dependent on imports. |
| **Sources** | MarineTraffic (freemium — 100 API calls/day free, historical data paid) / Spire Global (paid, institutional AIS feed) / VesselFinder (freemium) |
| **API** | MarineTraffic API v2 (REST, API key required, free tier: vessel positions + basic details). Spire Maritime API (paid, full historical + predictive ETA). |
| **Phase** | 2 |

#### Dark Fleet Detection (Sanctions & Smuggling)

| Attribute | Detail |
|-----------|--------|
| **What** | Vessels evading sanctions turn off AIS transponders ("going dark"). AI detects gaps in AIS tracks — a ship that was broadcasting every 10 seconds suddenly disappears for 72 hours, then reappears 500 nautical miles away. Satellite imagery can then spot ship-to-ship (STS) transfers at sea. |
| **Signal** | Volume of sanctioned Russian/Iranian crude oil reaching global markets despite sanctions. The "dark fleet" is estimated at 600+ tankers carrying ~1.5M barrels/day. |
| **Trade** | Rising dark fleet activity = more sanctioned oil reaching market = bearish pressure on official crude prices. Declining dark fleet (enforcement tightening) = supply reduction = bullish crude. |
| **Sources** | OpenSky Network (free, ADS-B aircraft data — complementary) / MarineTraffic gap detection (freemium) / Satellite correlation for STS events (paid) |
| **API** | MarineTraffic API (gap event notifications on paid tier). |
| **Phase** | 2-3 |

#### Narvik / Malmbanan Iron Ore (Nordic Specific)

| Attribute | Detail |
|-----------|--------|
| **What** | LKAB (Swedish state-owned mining company) ships iron ore pellets from Kiruna to the port of Narvik, Norway, via the Malmbanan railway — the single most critical iron ore logistics artery in Europe. Any disruption (derailment, weather, maintenance) immediately constrains European steel mill supply. |
| **Signal** | Trafikverket (Swedish Transport Administration) publishes real-time train movement data for every track in Sweden, including Malmbanan. Kystverket (Norwegian Coastal Administration) publishes vessel movements at Narvik. |
| **Trade** | Malmbanan stoppage detected → SELL SSAB (Swedish steelmaker dependent on LKAB pellets), BUY Rio Tinto / BHP (Australian competitors gain market share as European supply tightens). |
| **Sources** | Trafikverket Open API (free, real-time train positions and delays) / Kystverket AIS data (free, Norwegian port vessel movements) / LKAB press releases (free, OSINT) |
| **API** | Trafikverket API v2 (REST/XML, free API key at `api.trafikinfo.trafikverket.se`). Kystverket SafeSeaNet (public AIS portal). |
| **Phase** | 1 |

---

### Category 3: Flight Tracking (Corporate Intelligence)

Commercial and private aircraft broadcast position via ADS-B. Corporate jet movements reveal executive activity that precedes public announcements.

#### Private Jet Convergence (M&A Detection)

| Attribute | Detail |
|-----------|--------|
| **What** | Track corporate jets registered to public companies via ADS-B transponder data. Cross-reference tail numbers with FAA registry and SEC filings to identify which company owns which aircraft. |
| **Signal** | If Company A's CEO jet (N-registered Gulfstream G650) and Company B's CEO jet both land at the same obscure regional airport (e.g., Teterboro, NJ) three times within two weeks — and neither company has offices there — the probability of merger/acquisition negotiations is significant. |
| **Trade** | BUY Company B (the smaller company, likely the acquisition target — targets receive a 20-40% premium). Optionally: BUY call options on Company B for leveraged exposure. |
| **Sources** | OpenSky Network (free, global ADS-B coverage, 25+ million position reports/day) / FlightRadar24 (freemium, better UI but rate-limited free API) / ADS-B Exchange (free, community-driven, no filtering of military/private jets) |
| **API** | OpenSky Network REST API (free, 100 req/min for authenticated users, 10-second position granularity). ADS-B Exchange API v2 (free tier available). FlightRadar24 — no official API, but Flightradar24-python library available. |
| **Phase** | 1 |

#### Pharmaceutical Executive Travel (FDA Decisions)

| Attribute | Detail |
|-----------|--------|
| **What** | Track biotech/pharma executive jets visiting FDA headquarters (Silver Spring, MD) or advisory committee meeting locations before drug approval decisions. |
| **Signal** | Unusual clustering of pharma company jets at FDA-adjacent airports before a PDUFA date (FDA decision deadline). |
| **Trade** | Increased executive presence may signal confidence in approval. Combine with FDA calendar and clinical trial data for directional bets. |
| **Sources** | Same as M&A detection (OpenSky, ADS-B Exchange). Cross-reference with FDA PDUFA calendar (free, public). |
| **Phase** | 1 |

---

### Category 4: Macro & Central Bank Intelligence

Macroeconomic data forms the foundation of every cross-asset trading model. The edge is not in having the data (everyone does) but in processing speed and interpretation quality.

#### FRED (Federal Reserve Economic Data)

| Attribute | Detail |
|-----------|--------|
| **What** | The single most comprehensive free macroeconomic database in the world. 816,000+ time series covering every aspect of the US and global economy: interest rates, inflation (CPI, PCE), unemployment, GDP, money supply (M1, M2), yield curves, housing starts, industrial production, and more. |
| **Signal** | Foundation for regime detection (recession/expansion/stagflation), rate expectations, sector rotation models. |
| **Trade** | Inverted yield curve (10Y-2Y spread negative, FRED series `T10Y2Y`) → historically precedes recession by 12-18 months → reduce equity exposure, increase Treasury allocation. M2 money supply growth accelerating → inflationary → BUY commodities, TIPS. |
| **Sources** | FRED API (free, API key required, 120 requests/minute) |
| **API** | `https://api.stlouisfed.org/fred/` — REST API. Key endpoints: `series/observations` (time series data), `releases/dates` (upcoming data releases), `series/search` (discover series). |
| **Phase** | 1 |

#### Central Bank NLP (Statement Parsing)

| Attribute | Detail |
|-----------|--------|
| **What** | AI performs word-by-word diff analysis of consecutive Fed/ECB/Riksbank rate decision statements. Central bankers choose words with extreme precision — a single word change can signal a policy pivot. |
| **Signal** | Detect subtle shifts: "transitory inflation" → "persistent inflation" = hawkish pivot. "Considerable time" → "patient" = dovish shift. "Unanimous" → "most participants" = dissent emerging. |
| **Trade** | Hawkish surprise detected in FOMC statement → SELL rate-sensitive equities (REIT, utilities), BUY USD, SELL gold. Process within milliseconds of statement publication. |
| **Sources** | Federal Reserve press releases (`federalreserve.gov`, free). ECB press conferences (`ecb.europa.eu`, free). Riksbanken policy decisions (`riksbank.se`, free). |
| **API** | No formal API — requires web scraping on a schedule synchronized to meeting calendars. Fed statements published at exactly 14:00 ET on FOMC days. |
| **Phase** | 1 |

#### SEC EDGAR (Insider Trading & Filings)

| Attribute | Detail |
|-----------|--------|
| **What** | Real-time access to all SEC filings. Most valuable: Form 4 (insider transactions — when CEOs, CFOs, and directors buy or sell shares in their own company) and 13F (quarterly hedge fund holdings). |
| **Signal** | Cluster insider buying (3+ insiders buying within 30 days) is one of the strongest documented alpha signals in academic finance. Conversely, coordinated insider selling before earnings is a warning. |
| **Trade** | CEO of mid-cap company buys $2M of stock on the open market (not option exercise) → BUY. Historical excess returns: +5-8% over 6 months for cluster buys. |
| **Sources** | SEC EDGAR XBRL API (free, 10 requests/second with User-Agent header). SEC Full-Text Search (free). |
| **API** | `https://efts.sec.gov/LATEST/search-index` (full text search). `https://data.sec.gov/submissions/` (company filings by CIK). Form 4 RSS feeds for real-time insider transaction alerts. |
| **Phase** | 1 |

#### Riksbanken & ECB (European Macro)

| Attribute | Detail |
|-----------|--------|
| **What** | Riksbanken (Swedish central bank) and ECB publish policy rates, inflation expectations, financial stability reports, and lending survey data. |
| **Signal** | Riksbanken repo rate decisions affect SEK, Swedish mortgage rates, and Nordic bank profitability (SEB, Handelsbanken, Swedbank). ECB decisions ripple through all EUR-denominated assets. |
| **Trade** | Riksbanken surprise rate cut → BUY Swedish bank stocks (NII compression priced in, but loan demand boost underpriced). SEK weakens → BUY Swedish exporters (Volvo, Ericsson, Atlas Copco). |
| **Sources** | Riksbanken API (free, RESTful, rate decisions + statistics). ECB Statistical Data Warehouse (free, SDMX API). |
| **API** | Riksbanken: `https://www.riksbank.se/en-gb/statistics/` (downloadable datasets + API). ECB SDW: `https://sdw-wsrest.ecb.europa.eu/service/` (SDMX REST API, no auth required). |
| **Phase** | 1 |

---

### Category 5: Consumer & Sentiment Intelligence

Real-time consumer behavior data reveals demand shifts weeks or months before they appear in quarterly earnings.

#### Anonymized Credit Card Data

| Attribute | Detail |
|-----------|--------|
| **What** | Aggregated, anonymized transaction data from billions of credit/debit card purchases. Providers clean and categorize spending by merchant, geography, and time period. |
| **Signal** | "Netflix subscription revenue this quarter is tracking +8% vs consensus estimate of +5%" — derived from counting recurring card charges to Netflix merchant IDs. |
| **Trade** | Revenue tracking above consensus → BUY before earnings. Revenue tracking below → SHORT or avoid. Works for any company with significant card-based revenue (retail, restaurants, subscriptions, travel). |
| **Sources** | YipitData (paid, $5k-50k/mo), Earnest Analytics (paid), Second Measure (paid, now owned by Bloomberg) |
| **API** | All paid, institutional-only APIs. No free alternatives with comparable coverage. |
| **Phase** | 3 |

#### App Downloads & Usage (Mobile Intelligence)

| Attribute | Detail |
|-----------|--------|
| **What** | Track daily app installs, DAU (daily active users), session length, and revenue estimates for iOS and Android apps globally. |
| **Signal** | A gaming studio's new release hits 5M downloads in 48 hours (vs 500K for their last title) → revenue beat incoming. A food delivery app's DAU declining for 3 consecutive months → SELL. |
| **Trade** | BUY Take-Two Interactive when GTA VI mobile companion app downloads spike. SELL DoorDash when DAU trends negative vs Uber Eats. |
| **Sources** | Data.ai (formerly App Annie, paid — basic free tier for top charts). SimilarWeb (freemium, limited mobile data on free tier). Sensor Tower (paid). |
| **API** | Data.ai API (paid plans). SimilarWeb Digital Data API (freemium, 1 month history free). |
| **Phase** | 2-3 |

#### Social Media Sentiment (Retail Flow Detection)

| Attribute | Detail |
|-----------|--------|
| **What** | NLP analysis of Reddit (especially r/wallstreetbets, r/stocks, r/cryptocurrency), StockTwits, X/Twitter, and Telegram groups. Detect shifts in retail trader sentiment, emerging meme stock candidates, and panic selling cascades. |
| **Signal** | Mention velocity: if $GME mentions on WSB jump from 50/hour to 5,000/hour with >80% bullish sentiment, a retail squeeze is forming. Conversely, extreme bearish sentiment on a fundamentally sound stock = contrarian BUY. |
| **Trade** | Meme stock early detection (BUY before the squeeze). Panic capitulation detection (contrarian BUY when fear is maximum). Crypto sentiment divergence (price falling but sentiment improving = accumulation phase). |
| **Sources** | Reddit API (free, 100 req/min for OAuth apps — rate limits tightened in 2024). StockTwits API (free, 200 req/hour). X/Twitter API (free tier: 1,500 tweets/month read — very limited; Basic: $100/mo for 10k tweets/month). |
| **API** | Reddit: `https://oauth.reddit.com/` (OAuth2). StockTwits: `https://api.stocktwits.com/api/2/` (no auth for public streams). |
| **Phase** | 1-2 |

#### Quiver Quantitative (Aggregated Alt Data)

| Attribute | Detail |
|-----------|--------|
| **What** | A single API that aggregates multiple alternative data streams: US Congress member stock trades (Nancy Pelosi, etc.), Wikipedia page view spikes, government contract awards, corporate lobbying spending, patent filings. |
| **Signal** | Congress member buys $1M in NVDA call options 2 weeks before a semiconductor bill vote → insider knowledge signal. Wikipedia page views for a company spike 500% → upcoming news event (earnings, scandal, M&A). |
| **Trade** | Follow Congress trades with a 1-2 day delay (after STOCK Act disclosure). Wikipedia spike + positive sentiment = BUY catalyst incoming. |
| **Sources** | Quiver Quantitative API (freemium — generous free tier covers Congress trades, Wikipedia, contracts) |
| **API** | `https://api.quiverquant.com/beta/` — REST API. Endpoints: `/live/congresstrading`, `/live/wikipedia`, `/live/govcontracts`, `/live/lobbying`. Free tier: 50 req/day. Paid: $25/mo unlimited. |
| **Phase** | 1 |

---

### Category 6: Industrial & Infrastructure Chokepoints

Physical infrastructure creates bottlenecks. Monitoring these chokepoints reveals supply disruptions before they hit commodity prices.

#### Cement Factory Monitoring (Slite, Gotland)

A deep example of multi-source intelligence fusion on a single industrial target.

| Layer | Data Source | What It Reveals | Phase |
|-------|------------|-----------------|-------|
| **Thermal IR Satellite** | Copernicus Sentinel-3 SLSTR (free, 1km) / Landsat 8 TIRS (free, 100m) | Kiln operating temperature (1,450C when running). Cold kilns = unplanned shutdown = production halt. | 1-2 |
| **AIS Vessel Tracking** | MarineTraffic (freemium) / Kystverket (free for Swedish waters) | Vessel loading at Slite port. Draft measurement = cement tonnage per ship. Empty port = no exports. | 2 |
| **Energy Consumption** | Svenska Kraftnat open data (free) | Electricity draw on the Gotland cable. Cement grinding consumes massive power. Drop in consumption = reduced production. | 1 |
| **EU ETS Carbon Credits** | EU ETS registry (free) / ICE Futures Europe (delayed free) | Carbon credit price impact on cement margins. Heidelberg Materials (Cementa's parent) pays per ton of CO2. Rising ETS price = margin compression. | 1 |
| **Legal / Permits** | Mark- och miljodomstolen rulings (free, Swedish court database) | Limestone extraction permit decisions for Slite quarry. Permit denial in 2021 nearly shut down Sweden's only cement factory. | 1 |

**Trade thesis:** Multi-signal production disruption at Slite → SELL Heidelberg Materials (cement supply constrained), SELL Skanska/Peab (Swedish construction companies dependent on domestic cement), BUY competing cement producers (CRH, Holcim).

#### Gotland Water Crisis (ESG / Stranded Asset Risk)

| Attribute | Detail |
|-----------|--------|
| **What** | Cementa's Slite quarry requires continuous dewatering — pumping millions of liters of groundwater to keep the limestone pit dry. This competes directly with Gotland's drinking water supply, an island already facing water scarcity. |
| **Signal** | Satellite-derived soil moisture indices + municipal water level reports. When Gotland reservoir levels drop below critical thresholds, political pressure to restrict industrial water use intensifies. |
| **Trade** | Water-intensive industries on water-scarce islands = **stranded asset risk**. In ESG-aware portfolios, this is a long-term SHORT signal on Heidelberg Materials' Nordic operations. More broadly: screen for any industrial operation where water dependency intersects with scarcity. |
| **Sources** | Copernicus Climate Data Store (free, soil moisture). Gotland municipality water reports (free, OSINT). |
| **Phase** | 2 |

#### Concrete Truck GPS (Real-Time Construction Activity)

| Attribute | Detail |
|-----------|--------|
| **What** | GPS fleet tracking data from concrete mixer trucks. Concrete has a critical constraint: it must be poured within 60-90 minutes of mixing or it hardens in the drum. Therefore, every concrete truck trip = confirmed active construction pour. |
| **Signal** | Aggregate concrete truck activity per metro area per day = real-time construction activity index. More trucks moving = more building happening. |
| **Trade** | Concrete activity spiking in Phoenix, Dallas, Austin → BUY homebuilder stocks (DR Horton, Lennar). Activity collapsing in San Francisco → commercial real estate downturn deepening. |
| **Sources** | Fleet GPS data providers: Samsara, Geotab, Verizon Connect (all paid, institutional). No free alternative. |
| **Phase** | 3 |

#### Suez / Red Sea Crisis Response (Geopolitical Chokepoint)

| Attribute | Detail |
|-----------|--------|
| **What** | Bab el-Mandeb strait (southern entrance to the Red Sea) is a chokepoint for 12% of global trade. Houthi attacks on shipping since late 2023 have forced vessels to reroute around Africa (+10-14 days), spiking shipping costs and disrupting supply chains. |
| **Signal** | Multi-source detection system: AIS shows tanker U-turns at Bab el-Mandeb (vessel heading changes from 330 to 150 within minutes). Lloyd's List reports War Risk Premium spikes. OSINT monitors Arabic Telegram channels for "drone" or "missile" mentions near Red Sea coordinates. |
| **Trade** | Escalation detected → BUY crude oil futures (WTI, Brent), BUY shipping stocks (Frontline, Euronav, Maersk — rate surge), SELL European industrial stocks (supply chain disruption). Detection-to-execution target: <30 seconds. |
| **Sources** | MarineTraffic AIS (freemium, real-time vessel positions). Lloyd's List (paid, insurance premiums). Telegram OSINT (free, requires Arabic NLP). ACLED conflict data (free, academic). |
| **Phase** | 1-2 (AIS + OSINT) / 3 (insurance feeds) |

---

## Data Quality & The Data Engineer's Challenge

Alternative data, especially from free and open sources, is inherently messy:

| Problem | Example | Impact |
|---------|---------|--------|
| **Missing values** | Copernicus satellite image obscured by clouds for 5 consecutive days | Gap in crop health time series |
| **Inconsistent timestamps** | AIS data in UTC, FRED in ET, Trafikverket in CET | Correlation analysis breaks |
| **Schema drift** | Reddit API v3 response format changed without deprecation notice | Ingestion pipeline fails silently |
| **Survivorship bias** | Delisted stocks disappear from free data sources | Backtests overestimate returns |
| **Latency variation** | FRED data released at scheduled time; satellite data varies by hours | Signal timing inconsistency |

Hedge funds pay millions for cleaned, normalized, point-in-time data. In Alphanix, the **Data Engineer agent** within each pod and the **cleaning swarms** handle this through:

- **Validation schemas** (Zod) applied to every ingested data point — reject malformed records immediately
- **Gap detection and interpolation** — identify missing data points, apply appropriate fill methods (forward-fill for prices, interpolation for continuous variables, flag-and-skip for categorical)
- **Source health monitoring** — track latency, error rates, and schema changes per feed. Alert when a source degrades.
- **Automatic fallback** — if primary source fails, switch to backup (e.g., Copernicus down → fall back to NASA MODIS)
- **Point-in-time storage** — store data as-of the moment it was received, never backfill corrections into historical records (prevents look-ahead bias in backtests)

---

## Priority Data Sources for Phase 1

These are the sources Alphanix targets first — all free or freemium, with sufficient data quality for signal generation.

| Source | Type | API Format | Cost | Rate Limit | Alphanix Feed Module | Primary Use |
|--------|------|-----------|------|------------|---------------------|-------------|
| FRED | Macro | REST (JSON/XML) | Free | 120 req/min | `fred-feed.ts` | Regime detection, rate models, yield curve |
| SEC EDGAR | Filings | REST (JSON/XBRL) | Free | 10 req/sec | `sec-edgar-feed.ts` | Insider trades, 13F holdings, 8-K events |
| OpenSky Network | Aviation | REST (JSON) | Free | 100 req/min | `opensky-feed.ts` | Corporate jet tracking, M&A detection |
| Trafikverket | Rail/Transport | REST (XML) | Free | No published limit | `trafikverket-feed.ts` | Malmbanan iron ore logistics |
| NOAA | Weather/Climate | REST (JSON) | Free | No published limit | `noaa-feed.ts` | Agricultural signals, energy demand |
| ECB SDW | European Macro | REST (SDMX) | Free | No published limit | `ecb-feed.ts` | EUR rates, money supply, lending surveys |
| Riksbanken | Swedish Macro | REST (JSON) | Free | No published limit | `riksbanken-feed.ts` | SEK rates, Swedish economic indicators |
| Reddit / StockTwits | Sentiment | REST (JSON) | Limited free | 60 / 100 req/min | `sentiment-feed.ts` | Retail flow, meme detection, fear/greed |
| Quiver Quantitative | Alt Data Agg | REST (JSON) | Freemium | 50 req/day (free) | `quiver-feed.ts` | Congress trades, Wikipedia, contracts |
| Copernicus | Satellite | REST (JSON) | Free | Bulk download | `copernicus-feed.ts` | Crop health, thermal, oil tanks |
| Polymarket | Prediction | Existing module | Free | Existing | Shared module | Geopolitical probabilities |
| CoinMarketCap | Crypto Macro | Existing module | Free | 30 req/min | CMCScout (existing) | Fear & Greed, market cap, dominance |

### Phase 2 Candidates (Freemium, Worth Budget)

| Source | Cost | Value Add |
|--------|------|-----------|
| MarineTraffic Premium | ~$100/mo | Historical AIS, fleet analytics, port congestion |
| Data.ai Basic | ~$200/mo | App download trends, DAU estimates |
| FlightRadar24 Business | ~$50/mo | Enhanced private jet tracking |
| Quiver Quantitative Pro | $25/mo | Unlimited API calls, real-time Congress alerts |
| SimilarWeb Starter | ~$100/mo | Website traffic for e-commerce revenue estimation |

### Phase 3 Candidates (Paid, Justify with AUM)

| Source | Cost | Value Add |
|--------|------|-----------|
| Planet Labs | ~$500+/mo | Daily satellite imagery, parking lots, oil tanks |
| YipitData | ~$5,000+/mo | Credit card transaction data |
| Spire Global | Custom pricing | Institutional-grade AIS + weather |
| Bloomberg Terminal | ~$2,000/mo | Everything, but expensive |

---

## Integration with Alphanix Architecture

Each data source maps to the Alphanix architecture as follows:

```
Data Source API
      │
      ▼
┌─────────────────┐
│   Feed Module    │  (e.g., fred-feed.ts, sec-edgar-feed.ts)
│   - Fetch        │  Scheduled polling or webhook listener
│   - Validate     │  Zod schema validation
│   - Normalize    │  Unified timestamp, naming conventions
│   - Store        │  Redis (real-time) + Postgres (history)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Data Engineer   │  Pod-level agent
│  Agent           │  - Joins feeds into composite signals
│                  │  - Detects anomalies and regime shifts
│                  │  - Publishes to pod's signal bus
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Quant           │  Consumes normalized alt data
│  Researcher      │  alongside price/volume
│  Agent           │  - Multi-factor alpha models
│                  │  - Backtesting via swarm workers
└─────────────────┘
```

Feed modules are intentionally thin — they handle API communication, schema validation, and storage only. All analytical logic lives in the Data Engineer and Quant agents, keeping the data layer clean and replaceable.
