# Alphanix Research & References

## Overview

This document catalogs the academic papers, patents, industry reports, and open-source projects that inform Alphanix's architecture. Organized by domain. Companion document to the main spec at `docs/superpowers/specs/2026-03-23-alphanix-design.md`.

---

## 1. Multi-Agent Systems (MAS) in Finance

### Academic Papers

**"QuantAgents: Towards Multi-agent Financial System via Simulated Trading"** (ACL)
- Builds a MAS where different LLM agents receive specific roles (macro analyst, company reviewer, trader).
- Agents collaborate and learn through competition in a virtual market.
- Directly informs Alphanix's pod structure with specialized agent roles. The key insight is that role specialization outperforms monolithic agents: a macro analyst agent that only reads macro data develops better intuition than a generalist that reads everything.

**"Multi-Agent Deep Reinforcement Learning (MADRL) in Algorithmic Trading"**
- Trains multiple RL agents (one on 1-minute data, one on daily data).
- A Meta-Agent (Orchestrator) weighs their opinions for the final decision.
- Informs Alphanix's Orchestrator aggregation logic, specifically the confidence-weighted voting mechanism where each pod's signal is weighted by its recent track record.

**"InvestESG: A multi-agent reinforcement learning benchmark for studying climate investment as a social dilemma"** (arXiv, 2024/2025)
- Simulates how ESG requirements affect corporate climate investment decisions.
- Proves mathematically that a sufficient critical mass of "green" AI investors creates positive feedback loops that benefit all participants.
- Foundation for Alphanix's Finance 2.0 ESG features, where the system actively seeks companies whose sustainability trajectory is improving rather than just screening out bad actors.

**"Future-Proof Finance: Navigating Climate Risks and ESG Goals with Agentic AI and Collaborative Foresight"** (2025)
- Explores Agentic AI and multi-agent systems for climate risk analysis.
- Networks of collaborative AI agents handling unstructured sustainability data from corporate filings, news, and satellite imagery.
- Validates Alphanix's swarm approach to ESG data collection, where many lightweight OSINT agents each cover a narrow data source and feed results to a central aggregator.

### Industry Frameworks

**Pod System (Millennium Management, Citadel)**
- Organizational structure used by the world's most successful multi-strategy hedge funds: hundreds of independent pods, each functioning as a micro-fund.
- Pods receive capital allocation based on performance and get shut down if returns fall below threshold.
- Alphanix implements this digitally: pods are software constructs managed by the Orchestrator. Capital allocation follows the same Darwinian logic, but reallocation happens in seconds rather than quarters.
- Key difference from the human version: digital pods can be spun up, cloned, and terminated at near-zero cost, enabling far more aggressive experimentation.

---

## 2. LLMs for Financial Intelligence (OSINT)

**"FinGPT: Democratizing Internet-scale Data for Financial Large Language Models"** (Columbia University, NYU)
- Open-source framework for scraping news, Reddit, Twitter, and SEC filings.
- Uses LLMs for real-time sentiment signal generation with financial domain fine-tuning.
- GitHub: https://github.com/AI4Finance-Foundation/FinGPT
- Directly applicable to Alphanix's OSINT swarm workers. The key contribution is the data pipeline architecture: how to normalize wildly different data sources into a unified sentiment signal.

**AlphaSense**
- Commercial AI search engine for finance, reading thousands of PDFs and earnings call transcripts in seconds.
- NLP detects subtle changes in CEO language patterns (hedging words, confidence markers, topic avoidance) that precede earnings surprises.
- Commercial inspiration for Alphanix's NLP analysis capabilities. While AlphaSense charges $25k+/year per seat, an LLM-based approach can approximate many of these capabilities at a fraction of the cost.

**"BloombergGPT: A Large Language Model for Finance"** (Bloomberg, 2023)
- 50B parameter LLM trained on Bloomberg's proprietary financial corpus.
- Outperforms general-purpose LLMs on financial NLP tasks (sentiment analysis, named entity recognition, question answering).
- Demonstrates the value of domain-specific training data. Alphanix compensates by using prompt engineering and retrieval-augmented generation (RAG) with financial context rather than training a custom model.

---

## 3. Alternative Data & Geospatial Finance

**"Leveraging Geospatial & AI for Biodiversity Finance"** (Robeco & Climate Engine, 2024/2025)
- Combines asset geolocation with AI and satellite data to assess environmental impact.
- Automatically grades companies' actual biodiversity impact without relying on self-reported data.
- Validates Alphanix's satellite-based ESG monitoring approach: trust the satellite, not the annual report.

**"The Essential Role of Biodiversity Data for Robust ESG Reporting"** (Gentian, 2025)
- High-resolution satellite imagery combined with AI delivers biodiversity assessments in hours or days.
- Replaces slow, expensive manual field studies that can take months and cover limited areas.
- Supports Alphanix's automated ESG scoring pipeline where satellite data provides ground truth for corporate sustainability claims.

### Satellite Data Providers

| Provider | Data Type | Access | Used For |
|----------|-----------|--------|----------|
| ESA Copernicus / Sentinel | Multispectral, SAR | Free API | Crop health, land use change, ice coverage |
| Google Earth Engine | Aggregated satellite | Free (research) | Deforestation monitoring, water level tracking |
| NASA GRACE | Gravity anomaly | Free | Groundwater level changes (drought risk) |
| Planet Labs | High-res daily imagery | Paid | Parking lot occupancy, industrial activity |
| Maxar | Very high-res | Paid | Oil tank fill levels, construction progress |
| Spire Global | AIS satellite | Paid | Global vessel tracking, trade flow estimation |

### Flight & Vessel Tracking

| Provider | Data Type | Access | Used For |
|----------|-----------|--------|----------|
| OpenSky Network | ADS-B (flights) | Free API | Corporate jet tracking, M&A detection |
| FlightRadar24 | ADS-B enhanced | Freemium | Real-time flight intelligence |
| MarineTraffic | AIS (vessels) | Freemium | Port activity, cargo volume estimation |
| Kystverket (Norway) | Norwegian AIS | Free | Narvik port monitoring (iron ore exports) |
| Trafikverket (Sweden) | Rail traffic | Free API | Malmbanan iron ore train frequency |

### Notable Alternative Data Use Cases

- **Oil tank shadows**: Satellite imagery of floating-roof oil tanks allows estimation of global crude inventory by measuring shadow length to calculate fill levels. First commercialized by Orbital Insight.
- **Parking lot counts**: Satellite-derived car counts at retail locations (Walmart, Target) predict quarterly earnings before official reports. RS Metrics pioneered this approach.
- **Ship tracking for commodity flows**: AIS data combined with vessel draft depth estimates commodity shipment volumes in near-real-time. Used by Kpler and ClipperData.
- **Corporate jet tracking**: Private jet movements of CEOs and board members can signal M&A activity days before announcements. Quiver Quantitative tracks this systematically.

---

## 4. Execution & Market Microstructure

### Patents

**US20190370649A1 -- "Trade platform with reinforcement learning"** (Royal Bank of Canada / Borealis AI)
- RL agent learns to split large orders into thousands of micro-orders.
- Agent discovers market microstructure patterns (queue position dynamics, adverse selection) to minimize slippage.
- Relevant to Alphanix's Execution Engine TWAP/VWAP algorithms. The patent demonstrates that RL-based execution consistently outperforms static scheduling by 2-5 basis points.

**JPMorgan Chase -- Market Simulation Patents**
- Various patents on simulating order book dynamics using generative adversarial networks (GANs).
- Used for calibrating execution algorithms in a synthetic environment before live deployment.
- Informs Alphanix's backtesting infrastructure: testing execution algorithms against realistic order book simulations rather than just historical price data.

### Execution Algorithms

| Algorithm | Use Case | How It Works |
|-----------|----------|--------------|
| TWAP | Time-Weighted Average Price | Split order evenly across a time period, simple but predictable |
| VWAP | Volume-Weighted Average Price | Match order size to historical volume profile, reduces market impact |
| Iceberg | Large order concealment | Show only a small portion of total order size, hide true intent |
| Implementation Shortfall | Minimize decision-to-fill drift | Adaptive splitting based on real-time market impact measurement |
| Sniper | Liquidity seeking | Passively wait then aggressively take when favorable liquidity appears |

### Market Microstructure Concepts

- **Adverse selection**: The risk that your counterparty knows something you don't. Informed traders disproportionately take liquidity when it's mispriced.
- **Queue position**: In price-time priority markets, being early in the queue at a price level provides execution advantage. RL agents learn to manage queue position.
- **Maker-taker fees**: Most exchanges charge takers (market orders) and rebate makers (limit orders). Execution algorithms optimize the maker/taker mix to minimize net fees.
- **Latency arbitrage**: High-frequency traders exploit speed advantages to pick off stale quotes. Alphanix's execution engine must be aware of this risk even if it does not compete on latency.

---

## 5. Swarm Intelligence & Optimization

**Particle Swarm Optimization (PSO) for Portfolio Selection**
- Bio-inspired optimization algorithm derived from bird flocking and fish schooling behavior.
- Each "particle" represents a candidate portfolio allocation. Particles move through the solution space, influenced by their own best-known position and the swarm's global best.
- Tests millions of portfolio weight combinations in seconds, converging on near-optimal Sharpe ratios.
- Used by Alphanix Risk Managers for optimal risk/reward balance under constraints.

**Ant Colony Optimization (ACO)**
- Inspired by how ant colonies find shortest paths to food sources through pheromone trail reinforcement.
- Applied to order routing: finding the optimal execution path across multiple venues, where "pheromone" strength represents historical fill quality at each venue.
- Naturally handles the exploration-exploitation tradeoff: established good routes get reinforced, but random exploration discovers new opportunities.

**Genetic Algorithms for Strategy Evolution**
- Population of 100 agents generates random trading strategies (entry rules, exit rules, position sizing).
- Separate population of 100 "judge" agents backtests and scores them.
- Top 5 survivors breed (crossover + mutation) to produce the next generation.
- After ~50 generations, surviving strategies exhibit emergent properties not present in any initial random strategy.
- Directly informs Alphanix's "Backtest Tournament" concept (Phase 3), where pod strategies compete for capital allocation.

**"Swarm Intelligence in Financial Trading"** (Various, 2020-2025)
- Survey literature demonstrating that swarm-based portfolio optimization consistently matches or exceeds mean-variance optimization (Markowitz) while being more robust to estimation error.
- Key finding: swarm methods degrade gracefully with noisy inputs, while analytical solutions can produce wildly wrong allocations from small input errors.

---

## 6. True Cost Accounting & Regenerative Finance

**"True cost accounting applications for agrifood systems policymakers"** (FAO, 2023/2024)
- United Nations framework for pricing nature and health in economic terms.
- Systematic methodology for including externalities (pollution, soil degradation, health impacts) in cost calculations.
- When externalities are priced, many "cheap" commodities become expensive, and many "expensive" sustainable alternatives become competitive. This repricing creates investment opportunities.

**"The Hidden Cost of UK Food"** (Sustainable Food Trust)
- For every GBP 1 spent on food, GBP 1 in hidden costs flows to healthcare (diet-related disease), water treatment (agricultural runoff), and climate damage.
- Argues for redirecting agricultural subsidies from volume-based to outcome-based (soil health, biodiversity, nutrition).
- Informs Alphanix's thesis that companies positioned for true cost accounting will outperform as externality pricing becomes regulatory reality.

**"Soil, capital and power: mapping the financial landscape of regenerative agriculture"** (British Food Journal, 2026)
- Critical analysis warning that applying traditional financial tools to ecological systems may shift risk to farmers rather than genuinely improving outcomes.
- Reinforces the need to redesign incentive structures, not just overlay conventional finance metrics on ecology.
- Important counterbalance for Alphanix's Finance 2.0 features: avoid greenwashing by measuring actual ecological outcomes, not just financial proxies.

**"An evaluation of the regenerative claims of Web3's ReFi movement"** (Frontiers, 2025)
- Evaluates blockchain-based Regenerative Finance (ReFi) claims against actual environmental outcomes.
- Mixed results: some projects deliver genuine ecological benefits, but many amount to greenwashing with extra steps.
- Caution for Alphanix: token-based environmental credits require rigorous verification infrastructure.

### Planetary Boundaries Framework (Johan Rockstrom, Stockholm Resilience Centre)

Nine planetary boundaries define the safe operating space for humanity. Each boundary is mappable to portfolio risk factors:

| Boundary | Metric | Financial Impact |
|----------|--------|-----------------|
| Climate change | CO2 concentration, radiative forcing | Carbon credit costs, stranded fossil assets |
| Biosphere integrity | Extinction rate, functional diversity | Supply chain disruption, pollination loss |
| Land-system change | Forest cover percentage | Agricultural commodity risk, regulation |
| Freshwater use | Water consumption, blue water | Industrial capacity constraints (TSMC, Cementa) |
| Biogeochemical flows | Nitrogen/phosphorus loading | Fertilizer costs, algae bloom cleanup |
| Ocean acidification | Carbonate saturation state | Fisheries collapse, coastal tourism |
| Atmospheric aerosol loading | Aerosol optical depth | Health costs, solar panel efficiency |
| Stratospheric ozone | O3 concentration | Agricultural UV damage, skin cancer costs |
| Novel entities | Chemical pollution index | Regulatory risk, PFAS cleanup liability |

Six of nine boundaries are already transgressed (as of 2023). Companies whose business models depend on transgressing these boundaries face growing regulatory and physical risk. Companies enabling boundary restoration represent asymmetric upside.

---

## 7. Open-Source Tools & Frameworks

### AI Agent Frameworks

| Framework | Purpose | Relevance to Alphanix |
|-----------|---------|----------------------|
| LangChain | LLM orchestration, chaining | Could power OSINT NLP analysis pipelines |
| CrewAI | Multi-agent collaboration | Inspiration for pod agent coordination patterns |
| Microsoft AutoGen | Multi-agent conversation | Agent-to-agent communication and debate protocols |
| Claude Code CLI | Autonomous coding agent | Brain service implementation (already proven in Cryonix) |
| LangGraph | Stateful agent workflows | Tank pipeline architecture (scan -> analyze -> risk -> execute) |

### Financial Data & Analysis

| Tool | Purpose | Relevance |
|------|---------|-----------|
| CCXT | Crypto exchange abstraction | Already in monorepo, used by BinanceAdapter |
| FinGPT | Financial LLM framework | OSINT sentiment analysis pipeline |
| Backtrader | Python backtesting framework | Strategy validation and tournament infrastructure |
| Zipline | Event-driven backtesting | Alternative backtesting engine (Quantopian legacy) |
| QuantLib | Financial mathematics library | Pricing models, risk calculations, Greeks |
| TA-Lib | Technical analysis library | Indicator computation (RSI, MACD, Bollinger) |

### Data Infrastructure

| Tool | Purpose | Relevance |
|------|---------|-----------|
| TimescaleDB | Time-series Postgres extension | Phase 2 data lake optimization for tick data |
| KDB+/q | Ultra-fast time-series DB | Industry standard at hedge funds (inspiration, not adopted) |
| Apache Kafka | Distributed stream processing | Alternative to Redis pub/sub at scale (100k+ msg/sec) |
| DuckDB | Embedded analytical DB | Fast local backtesting queries without server overhead |
| Apache Arrow | Columnar in-memory format | Zero-copy data sharing between Python and TypeScript |
| Redis Streams | Ordered message log | Current pub/sub backbone, proven in Cryonix architecture |

---

## 8. Regulatory & Legal Context

### Market Regulation

- **SEC (US):** Algorithmic trading firms must register as broker-dealers or investment advisers. Regulation SCI requires system compliance and integrity testing. Market Access Rule (15c3-5) requires pre-trade risk controls.
- **MiFID II (EU):** Requires algorithm testing, real-time monitoring, and kill switch capabilities. Algorithmic traders must be authorized and notify regulators. High-frequency trading firms face additional obligations (tick-by-tick record keeping).
- **Finansinspektionen (SE):** Swedish financial supervisory authority. Oversees algorithmic trading activities in Swedish markets. Enforces EU regulations with national supplements.

### Data Privacy

- **GDPR (EU):** All personal data processing requires legal basis. Satellite imagery of individuals' property may qualify as personal data. Anonymized aggregate data (parking lot counts, vessel positions) generally exempt. Right to explanation may apply if AI-derived scores affect individuals.
- **CCPA (California):** California consumer privacy law affecting data sourcing from US-based platforms. Restricts use of consumer behavioral data without consent.

### ESG Regulation

- **EU Taxonomy:** Classification system defining which economic activities qualify as "green." Creates a common language for ESG claims, reducing greenwashing. Alphanix can use taxonomy alignment as a scoring input.
- **CSRD (Corporate Sustainability Reporting Directive):** Mandatory ESG disclosure for ~50,000 EU companies starting 2024-2026. Dramatically expands the availability of structured ESG data for algorithmic consumption.
- **SEC Climate Disclosure Rule:** US-specific ESG reporting requirements for public companies. Scope 1 and 2 emissions disclosure, with phased-in Scope 3 for large filers.
- **SFDR (Sustainable Finance Disclosure Regulation):** Requires financial products to disclose sustainability characteristics. Creates Article 6/8/9 fund classifications that Alphanix can use as filtering criteria.

---

## 9. Key Takeaways for Alphanix Architecture

1. **Multi-agent specialization works.** Both academic research (QuantAgents, MADRL) and industry practice (Millennium, Citadel) confirm that specialized agents outperform generalists. Build narrow, deep pods.

2. **LLMs are the OSINT equalizer.** FinGPT and BloombergGPT demonstrate that LLM-based analysis can approximate capabilities previously requiring Bloomberg Terminal subscriptions and analyst teams.

3. **Alternative data is the edge.** Satellite imagery, vessel tracking, and flight data provide information advantages that are legal, scalable, and increasingly accessible through free and freemium APIs.

4. **Execution quality matters more than signal quality at scale.** The RBC/Borealis AI patent shows that RL-based execution saves 2-5 bps per trade. At high frequency, this compounds to dominate returns.

5. **Swarm optimization handles uncertainty better than analytical solutions.** PSO and genetic algorithms degrade gracefully with noisy inputs, making them superior to Markowitz-style optimization for real-world portfolios.

6. **Planetary boundaries create asymmetric opportunities.** Six of nine boundaries transgressed means regulatory tightening is inevitable. Companies enabling boundary restoration are underpriced; companies depending on transgression are overpriced.

7. **Regulation is expanding, not contracting.** CSRD, SFDR, SEC climate rules all increase structured data availability while creating compliance moats for ESG-aware systems.
