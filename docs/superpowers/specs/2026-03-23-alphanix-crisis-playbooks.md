# Alphanix Crisis Playbooks

**Date:** 2026-03-23
**Status:** Draft
**Owner:** Joel (Cryonix Agent Army)
**Companion to:** [alphanix-design.md](2026-03-23-alphanix-design.md)

## Introduction

These playbooks demonstrate how Alphanix's multi-agent system responds to real-world events by correlating multiple independent data signals faster than human traders or traditional news services. Each playbook follows the pattern: DETECT -> CORRELATE -> ANALYZE -> EXECUTE.

The core advantage is **multi-signal correlation** — no single data source triggers a trade. The Orchestrator requires 2+ independent confirmations before authorizing execution, and the pod-level Risk Manager stress-tests every position against historical scenarios before order placement.

All timings are measured from the first signal detection (T+0). Response times assume the production deployment on Azure VM with Redis pub/sub for inter-agent communication.

---

## Playbook 1: Strait of Hormuz / Red Sea Blockade

**Context:** 20% of the world's oil passes through the Strait of Hormuz. Houthi attacks on Red Sea shipping have previously forced rerouting around the Cape of Good Hope, adding 2-3 weeks per voyage and tying up global fleet capacity.

### Detection (T+0)

| Agent | Signal | Confidence |
|-------|--------|------------|
| AIS Swarm | 3 supertankers execute synchronized U-turn at Bab el-Mandeb strait | 0.85 |
| AIS Swarm | Multiple vessels switch off transponders ("going dark") in a 50km radius | 0.70 |
| Insurance Swarm | Lloyd's War Risk Premium spikes from 0.1% to 2.0% within 30 minutes | 0.90 |
| OSINT Swarm | Arabic Telegram channels detect keywords "drone", "missile", "explosion" near GPS coordinates matching the strait | 0.75 |
| OSINT Swarm | Local Yemeni and Somali news feeds report military activity | 0.60 |

### Correlation (T+5s)

- **Orchestrator** receives 5 independent signals from 3 distinct data categories (maritime, financial, intelligence).
- Composite confidence: `0.85 * 0.90 * 0.75 = 0.574` (joint probability of top 3 independent signals) exceeds the 0.50 threshold for "geopolitical shock" classification.
- Orchestrator broadcasts `CRISIS:MARITIME_BLOCKADE` event to all pods via Redis pub/sub.
- Risk Manager initiates stress-test of all open positions against the "Suez 2021 closure" historical scenario.

### Analysis (T+10s)

**Commodities Pod — Quant Agent:**
- Oil supply chain disruption model activates.
- Historical analogy: 2024 Houthi campaign caused Brent premium of +$5-8/barrel sustained over 3 months.
- Calculates expected price impact: Brent +6-10% within 48 hours if blockade persists.

**EU Stocks Pod — Quant Agent:**
- Shipping fleet scarcity model activates. Rerouting via Cape of Good Hope ties up vessels for an additional 14-21 days per round trip, reducing effective global fleet capacity by an estimated 12%.
- European industrial exposure model flags energy-intensive manufacturers with thin margins.
- Identifies BASF (chemical, energy-dependent), Skanska (construction, component supply chains), and European airlines (jet fuel cost sensitivity).

**Crypto Pod — Quant Agent:**
- Geopolitical uncertainty historically correlates with BTC safe-haven narrative (+2-5% in first 72 hours of major events).
- Oil-correlated tokens flagged for monitoring but no immediate action (low liquidity, unreliable correlation).

### Execution (T+15s)

| Pod | Action | Instrument | Rationale | Position Size |
|-----|--------|------------|-----------|---------------|
| Commodities | BUY | Brent Crude futures | Supply constraint -> price up | 3% of pod capital |
| EU Stocks | BUY | Frontline (FRO) | Fleet scarcity -> record freight rates | 2% of pod capital |
| EU Stocks | BUY | Maersk (MAERSK-B) | Container rerouting premium | 2% of pod capital |
| EU Stocks | BUY | Euronav (EURN) | Tanker demand surge | 1.5% of pod capital |
| EU Stocks | SELL | BASF (BAS) | Energy cost shock -> margin compression | 2% of pod capital |
| EU Stocks | SELL | Skanska (SKA-B) | Component delays + energy costs | 1.5% of pod capital |
| Crypto | BUY | BTC/USDC | Safe-haven bid on geopolitical shock | 1% of pod capital |

**Risk Manager actions:**
- Widen stop-loss buffers by 50% across all new positions (expect extreme volatility in first 24 hours).
- Orchestrator shifts 20% of unallocated capital reserve to Commodities pod.
- Set maximum drawdown trigger at 8% for all crisis-related positions (normally 5%).

### Post-Event Monitoring (T+1h onward)

- **AIS Swarm:** Track fleet rerouting pattern. Count vessels taking Africa route vs. waiting at anchor. If >80% reroute, blockade is confirmed sustained.
- **Insurance Swarm:** Monitor war risk premium for normalization (signal for de-escalation). Premium returning below 0.5% triggers position reduction.
- **OSINT Swarm:** Scan for diplomatic resolution signals (UN Security Council statements, bilateral negotiations, ceasefire keywords).
- **Risk Manager:** Re-evaluate positions every 4 hours. Begin unwinding shipping longs if rerouting vessels start returning to Red Sea route.

### Historical Precedent

| Event | Duration | Brent Impact | Shipping Impact |
|-------|----------|-------------|-----------------|
| Houthi campaign 2024 | 6+ months | +$5-8/bbl sustained | Freight rates 3x |
| Suez blockage 2021 (Ever Given) | 6 days | +3% | Freight rates 2x |
| Iran-Iraq tanker war 1984-88 | 4 years | +$10/bbl | War risk premiums 10x |

---

## Playbook 2: Malmbanan Derailment (Swedish Iron Ore Crisis)

**Context:** Malmbanan is the only rail link between LKAB's mines in Kiruna/Malmberget and the ice-free port of Narvik, Norway. It is Europe's largest iron ore supply artery. During winter (November-May), Bottenviken (Gulf of Bothnia) freezes, making the port of Lulea inaccessible to bulk carriers without icebreaker escort. Narvik is the only reliable year-round export option, and a single point of failure.

### Detection (T+0)

| Agent | Signal | Confidence |
|-------|--------|------------|
| Trafikverket Swarm | Real-time rail traffic API shows all freight trains halted on Malmbanan section between Vassijaure and Bjorkliden | 0.95 |
| AIS Swarm | 3 bulk carriers anchored outside Narvik harbor with status "waiting for berth" for >6 hours (unusual; normal turnaround is 2-4 hours) | 0.80 |
| OSINT Swarm | Local Norrland media (NSD, Norran) mentions "ursparing", "derailment", "sparat ur" near identified rail section | 0.85 |

### Correlation (T+10s)

- **Orchestrator** receives 3 independent signals from distinct categories (infrastructure, maritime, media).
- Historical model loaded: Previous Vassijaure-area derailments (2023, 2024) closed the track for 2-8 weeks. LKAB loses approximately SEK 50-100 million per day of lost exports.
- Winter context check: Current date is within freeze season -> Lulea port unavailable -> Narvik is the only export path -> severity multiplier applied.
- Orchestrator broadcasts `CRISIS:INFRASTRUCTURE_RAIL` with region tag `SE_MALMBANAN`.

### Analysis (T+20s)

**EU Stocks Pod — Quant Agent:**
- Iron ore supply model: LKAB produces ~27 million tonnes/year, roughly 80% of Europe's iron ore pellet supply. Full blockage removes ~75,000 tonnes/day from the market.
- Downstream cascade: SSAB steel mills in Lulea and Oxelosund depend directly on LKAB pellets. Pellet stockpiles at mill sites typically last 7-14 days.
- Competitor benefit analysis: Rio Tinto and BHP (Australian producers) gain pricing power as European buyers seek spot-market alternatives. Australian iron ore fines are an imperfect substitute for LKAB pellets, so premium pricing is expected.
- Construction sector impact: Swedish construction is already capacity-constrained. Steel shortage adds 4-8 week delays to structural steel deliveries.

**Commodities Pod — Quant Agent:**
- Iron ore futures (SGX 62% Fe) expected to rise 5-12% depending on estimated repair duration.
- If repair estimate exceeds 4 weeks, activate "prolonged disruption" model with additional commodity spread trades.

### Execution (T+30s)

| Pod | Action | Instrument | Rationale | Position Size |
|-----|--------|------------|-----------|---------------|
| Commodities | BUY | SGX Iron Ore futures (62% Fe) | Global supply reduction from Europe's largest producer | 3% of pod capital |
| EU Stocks | SELL | SSAB (SSAB-A) | Input shortage -> production halt risk within 7-14 days | 2.5% of pod capital |
| EU Stocks | BUY | Rio Tinto (RIO) | Competitor gains market share + premium pricing | 2% of pod capital |
| EU Stocks | BUY | BHP (BHP) | Same competitor dynamic | 2% of pod capital |
| EU Stocks | SELL | Peab (PEAB-B) | Steel shortage -> construction project delays | 1.5% of pod capital |
| EU Stocks | SELL | Skanska (SKA-B) | Steel shortage -> structural steel delivery delays | 1.5% of pod capital |

**Risk Manager actions:**
- Flag as "infrastructure shock" with expected duration 2-8 weeks.
- Position sizes scaled to expected duration: if repair estimate <1 week, reduce positions by 50%.
- Set profit targets at +8% for commodity longs, +5% for equity shorts.

### Duration Tracking (T+1h onward)

- **Trafikverket Swarm:** Poll restoration timeline updates every 15 minutes. Key signal: "enkelspardrift" (single-track operation) means partial reopening.
- **Satellite Swarm (Phase 2):** If available, request SAR imagery of derailment site for severity assessment (number of cars derailed, track damage extent).
- **AIS Swarm:** Monitor Lulea port activity. If icebreakers are dispatched and bulk carriers start loading at Lulea, LKAB has activated the backup route — reduces severity.
- **OSINT Swarm:** Track LKAB press releases, Trafikverket repair estimates, and Swedish government response (emergency infrastructure funding signals longer disruption).

### Historical Precedent

| Event | Location | Duration | Impact |
|-------|----------|----------|--------|
| Malmbanan derailment 2024 | Vassijaure | ~3 weeks | LKAB production halted, SSAB warnings |
| Malmbanan derailment 2023 | Ofoten section | ~2 weeks | Narvik exports suspended |
| Norrbotten storm damage 2022 | Multiple points | 5 days | Partial service restoration via single track |

---

## Playbook 3: Slite Cement Factory Crisis (Gotland Water + Legal)

**Context:** Cementa (subsidiary of Heidelberg Materials) operates Sweden's largest cement factory in Slite, Gotland. The factory produces approximately 75% of Sweden's cement. Limestone quarrying requires pumping millions of liters of groundwater, directly competing with Gotland's drinking water supply. The operation depends on environmental permits that are periodically challenged in Swedish courts (Mark- och miljodomstolen). A permit denial is a binary event with catastrophic downstream effects on the entire Swedish construction sector.

### Scenario A: Unplanned Shutdown

#### Detection (T+0)

| Agent | Signal | Confidence |
|-------|--------|------------|
| Satellite Swarm (Phase 2) | Thermal signature of rotary kiln drops from ~1450C to ambient (kiln shutdown) | 0.90 |
| AIS Swarm | 2 bulk carriers sitting idle at Slite port, not loading cement for >12 hours | 0.75 |
| OSINT Swarm | Article in "Hela Gotland" reporting smoke, dust incident, or emergency response at Cementa facility | 0.80 |

#### Correlation (T+10s)

- Orchestrator receives 3 signals. Kiln shutdown + idle ships + local media = confirmed production halt.
- Historical model: Unplanned kiln shutdowns typically last 3-14 days depending on cause (refractory failure vs. electrical vs. environmental order).

### Scenario B: Legal Ruling (Permit Denied)

#### Detection (T+0)

| Agent | Signal | Confidence |
|-------|--------|------------|
| Legal OSINT Swarm | New PDF document uploaded to Mark- och miljodomstolen (Environmental Court) case database matching Cementa/Heidelberg case number | 0.95 |
| NLP Swarm | Parses 400-page Swedish legal ruling in ~2 seconds. Extracts verdict: "tillstand avvisas" (permit denied) with 0.87 confidence | 0.87 |
| OSINT Swarm | Swedish mainstream media (SVT, DN, SvD) has NOT published the ruling yet (typical delay: 3-15 minutes) | — |

**Information advantage window: 3-15 minutes** before mainstream media coverage triggers retail and institutional response.

#### Correlation (T+5s for Scenario B)

- Orchestrator: Legal ruling with "permit denied" from NLP analysis + court database source = HIGH CONFIDENCE.
- Severity assessment: Permit denial for limestone quarrying means Slite cannot extract raw material. Existing stockpiles last 6-18 months depending on extraction rate at time of ruling.
- Downstream model loaded: 75% of Swedish cement supply at risk. No domestic alternative at scale. Import capacity from Germany/Poland is limited by port infrastructure and would take months to scale.

### Analysis (T+15s)

**EU Stocks Pod — Quant Agent:**
- Heidelberg Materials: Direct revenue loss from Slite operations. But Slite is a small fraction of global Heidelberg revenue — limit short size accordingly.
- Swedish construction: Cement is non-substitutable in concrete. Shortage triggers project delays across the entire sector. Peab, Skanska, NCC, and JM all affected.
- Alternative suppliers: German and Polish cement producers receive panic orders. CRH plc and Buzzi Unicem may benefit.
- Gotland infrastructure: If permit denial includes groundwater remediation requirements, desalination plant construction becomes necessary. Municipal infrastructure companies benefit.

**Macro implications:**
- Swedish GDP model: Construction represents ~10% of Swedish GDP. A sustained cement shortage has measurable macroeconomic impact.
- Swedish government response probability: Emergency temporary permit (politiskt beslut) is historically likely within 2-4 weeks, but legal uncertainty persists.

### Execution

**Scenario A (Shutdown) — moderate severity:**

| Pod | Action | Instrument | Rationale | Position Size |
|-----|--------|------------|-----------|---------------|
| EU Stocks | SELL | Heidelberg Materials (HEI) | Lost production revenue | 1.5% of pod capital |
| EU Stocks | SELL | Skanska (SKA-B) | Cement supply shortage -> project delays | 1.5% of pod capital |
| EU Stocks | SELL | Peab (PEAB-B) | Same construction delay dynamic | 1% of pod capital |
| EU Stocks | BUY | CRH plc (CRH) | Alternative cement producer receives overflow orders | 1% of pod capital |

**Scenario B (Legal — permit denied) — high severity:**

| Pod | Action | Instrument | Rationale | Position Size |
|-----|--------|------------|-----------|---------------|
| EU Stocks | SELL | Heidelberg Materials (HEI) | Potential permanent production loss at Slite | 3% of pod capital |
| EU Stocks | SELL | Skanska (SKA-B) | Systemic cement shortage in Sweden | 2.5% of pod capital |
| EU Stocks | SELL | Peab (PEAB-B) | Systemic cement shortage | 2% of pod capital |
| EU Stocks | SELL | NCC (NCC-B) | Systemic cement shortage | 1.5% of pod capital |
| EU Stocks | BUY | CRH plc (CRH) | European alternative supplier benefits | 2% of pod capital |
| EU Stocks | BUY | Buzzi Unicem (BZU) | Italian/German production gains export demand | 1.5% of pod capital |

**Risk Manager actions:**
- Scenario B positions are 2x larger than Scenario A (permanent vs. temporary impact).
- Monitor for Swedish government emergency intervention (temporary permit would reverse the thesis).
- Set tight stops on Heidelberg short: if government announces emergency permit within 48 hours, cover immediately.

### Post-Event Monitoring

- **Legal OSINT Swarm:** Monitor for appeal filings, government intervention signals ("undantagstillstand"), and Riksdag debate transcripts.
- **AIS Swarm:** Track cement import vessels arriving at Swedish ports (Goteborg, Stockholm). Increasing import traffic confirms supply chain restructuring.
- **OSINT Swarm:** Gotland water level reports (Gotlands kommun). If water table recovers, environmental argument weakens in appeals.

---

## Playbook 4: TSMC Water Crisis (Global Chip Shortage)

**Context:** Taiwan Semiconductor Manufacturing Company (TSMC) is the world's largest contract chip manufacturer, producing over 50% of the world's semiconductors by revenue. Advanced chip fabrication (sub-7nm) requires massive quantities of ultra-pure water — approximately 156,000 tonnes per day at TSMC's Hsinchu Science Park fabs. Taiwan is a subtropical island with concentrated rainfall seasons and limited reservoir capacity. Drought conditions directly threaten production output.

### Detection (T+0)

| Agent | Signal | Confidence |
|-------|--------|------------|
| Satellite Swarm | NASA GRACE satellite gravity data shows Baoshan and Baoshan Second Reservoirs (Hsinchu region) dropping below 30% capacity — critical threshold | 0.85 |
| OSINT Swarm | Taiwanese Water Resources Agency (WRA) announces industrial water rationing for Hsinchu Science Park | 0.95 |
| Weather Swarm (NOAA) | Extended drought forecast for northern Taiwan: less than 50% of normal precipitation expected for next 60 days | 0.80 |
| OSINT Swarm | TSMC internal memo leaked on PTT (Taiwanese forum) discussing contingency water trucking operations | 0.60 |

### Correlation (T+5s)

- **Orchestrator** receives 4 signals from 3 categories (satellite, government, weather).
- Historical model loaded: 2021 Taiwan drought forced TSMC to deploy water trucks at $3M/month, reduced wafer output by an estimated 5-10%.
- Severity assessment: Current reservoir levels (30%) are worse than 2021 levels at the equivalent calendar date. Extended drought forecast suggests no relief for 60+ days.
- Orchestrator broadcasts `CRISIS:SUPPLY_CHAIN_SEMICONDUCTOR` to all pods.

### Analysis (T+15s)

**US Stocks Pod — Quant Agent:**
- TSMC production reduction model: 10-20% output reduction over 60 days if rationing persists.
- Delivery delay cascade: 3nm and 5nm wafer starts delayed 3-6 months. Customers affected: Apple (A-series, M-series chips), AMD (Zen CPUs, RDNA GPUs), Nvidia (data center GPUs, automotive), Qualcomm (Snapdragon mobile), Broadcom, MediaTek.
- Revenue impact estimates: Apple iPhone production delayed -> Q4 revenue miss. Nvidia data center GPU shortage -> hyperscaler CapEx delays.
- Competitor benefit: Samsung Foundry (Pyeongtaek, South Korea) receives overflow 4nm/5nm orders. Intel Foundry Services (IFS) domestic US capacity becomes strategic asset — US government CHIPS Act narrative strengthens.

**Commodities Pod — Quant Agent:**
- DRAM and NAND flash memory prices spike on component hoarding (customers front-load orders fearing deeper shortages).
- Copper demand may soften if consumer electronics production slows.

**Crypto Pod — Quant Agent:**
- GPU-dependent proof-of-work mining: Hardware shortage reduces new mining rig deployment -> hashrate growth stalls.
- GPU-intensive AI tokens: Projects dependent on Nvidia H100/H200 availability may face infrastructure delays.

### Execution (T+20s)

| Pod | Action | Instrument | Rationale | Position Size |
|-----|--------|------------|-----------|---------------|
| US Stocks | SELL | TSMC ADR (TSM) | Production cut -> revenue miss for 2+ quarters | 3% of pod capital |
| US Stocks | SELL | Apple (AAPL) | iPhone production delayed -> Q4 miss | 2% of pod capital |
| US Stocks | SELL | AMD (AMD) | CPU/GPU supply constrained | 2% of pod capital |
| US Stocks | SELL | Nvidia (NVDA) | Data center GPU delivery delays | 2% of pod capital |
| US Stocks | BUY | Samsung Electronics (SSNLF) | Overflow foundry orders from TSMC customers | 2.5% of pod capital |
| US Stocks | BUY | Intel (INTC) | Domestic US fab capacity = strategic asset, CHIPS Act tailwind | 2% of pod capital |
| Commodities | BUY | Memory ETF / DRAM futures proxy | Component hoarding -> price spike | 1.5% of pod capital |
| US Stocks | BUY | Xylem (XYL) | Water infrastructure — Taiwan desalination investment | 1% of pod capital |
| Crypto | SELL | GPU-mining tokens (reduce exposure) | Hardware shortage -> hashrate growth stalls | 1% of pod capital |

**Risk Manager actions:**
- Maximum portfolio exposure to "TSMC drought" thesis: 15% of total AUM across all pods.
- Duration estimate: 60-120 days (drought season). Positions sized for multi-month hold.
- Trigger for thesis invalidation: Taiwan rainfall exceeding 200mm in Hsinchu region over any 7-day period (reservoir recovery signal).

### Post-Event Monitoring (T+1h onward)

- **Satellite Swarm:** Weekly reservoir level checks via GRACE data and Sentinel-2 optical imagery.
- **Weather Swarm:** Daily precipitation forecast updates for Hsinchu region.
- **OSINT Swarm:** TSMC quarterly earnings call transcripts — management commentary on water contingency and CapEx for on-site water recycling.
- **OSINT Swarm:** Taiwan WRA policy announcements — escalation from rationing to mandatory curtailment would worsen the thesis.
- **US Stocks Pod — Quant Agent:** Monitor Samsung Foundry yield rates. If Samsung cannot absorb overflow at acceptable yields, the shortage worsens further.

### Historical Precedent

| Event | Year | Duration | TSMC Impact | Market Impact |
|-------|------|----------|-------------|---------------|
| Taiwan drought | 2021 | ~5 months | Water trucks, estimated 5-10% output cut | Global chip shortage, auto industry halted |
| Taiwan drought | 2002 | ~4 months | Production slowdowns | DRAM prices +30% |
| Hsinchu earthquake | 2024 | 2 weeks | Fab tool recalibration | Minimal lasting impact |

---

## Playbook 5: Flash Crash / Algorithmic Feedback Loop

**Context:** Multiple AI-driven trading systems from different funds enter a destructive feedback loop, causing a flash crash. This is a market microstructure event — no fundamental news trigger exists. The danger is that Alphanix's own algorithms could amplify the crash if they interpret falling prices as a bearish signal. The primary objective is survival, not profit.

### Detection (T+0)

| Agent | Signal | Confidence |
|-------|--------|------------|
| Execution Agent (all pods) | Order book depth evaporating at 100x normal rate across multiple exchanges simultaneously | 0.95 |
| Risk Manager | Portfolio-level realized volatility exceeds 3-sigma threshold within 60 seconds | 0.90 |
| Macro Swarm | No fundamental news event detected in the last 30 minutes (ruling out legitimate crisis) | 0.85 |
| Cross-Exchange Swarm | Price divergence >0.5% between NYSE and NASDAQ for identical securities (SPY vs. ES, QQQ vs. NQ) | 0.80 |
| Execution Agent | Bid-ask spread widening 10x across large-cap equities in under 30 seconds | 0.90 |

### Correlation (T+3s)

- **Orchestrator** pattern match: **FLASH CRASH** — algorithmic cascade, not fundamental event.
- Key discriminator: **No news** + **cross-exchange divergence** + **simultaneous depth evaporation** = market microstructure breakdown.
- Historical model loaded: May 6, 2010 Flash Crash (Dow dropped 998 points in 5 minutes, recovered within 20 minutes). August 24, 2015 ETF Flash Crash. February 5, 2018 VIX Flash Crash.
- Confidence that this is a flash crash (not a real crash): calculated from the "no fundamental news" signal. If OSINT detects a legitimate trigger (e.g., nuclear event, central bank surprise), classification changes to "real crisis" and a different playbook activates.

### Immediate Response (T+5s) — DEFENSIVE PHASE

| Agent | Action | Priority |
|-------|--------|----------|
| **Orchestrator** | Broadcast `KILL_SWITCH:SOFT` to all pods — halt all new order generation | CRITICAL |
| **Execution Agent (all pods)** | Cancel all open limit orders across all exchanges (prevent getting filled at crash prices) | CRITICAL |
| **Risk Manager** | Switch all pods to `DEFENSIVE` mode — no new positions, monitor-only | CRITICAL |
| **Risk Manager** | Evaluate existing positions: do NOT panic-sell into illiquid crash (selling into a flash crash locks in losses) | HIGH |
| **Orchestrator** | Log all market data at tick level for post-mortem analysis | MEDIUM |

**Critical anti-feedback-loop rule:** Alphanix must NOT sell during the initial crash phase. Selling into a flash crash provides liquidity to the cascading algos and amplifies the crash. The correct action is to freeze and wait for liquidity to return.

### Monitoring Phase (T+5s to T+60s)

- **Execution Agent:** Track bid-ask spread normalization rate. Plot spread width over time.
- **Risk Manager:** Monitor for exchange-level circuit breakers (NYSE Rule 48, LULD bands). If a market-wide halt is triggered, reset all timers.
- **Cross-Exchange Swarm:** Track price convergence between exchanges. Convergence = recovery beginning.
- **OSINT Swarm:** Continuous scan for any late-breaking fundamental news that could reclassify this as a real event.

### Opportunistic Phase (T+60s to T+300s)

Once the Orchestrator confirms ALL of the following conditions:
1. Prices have diverged >5% from pre-crash levels.
2. No fundamental news has been detected (flash crash classification holds).
3. Bid-ask spreads have begun narrowing (liquidity returning).
4. At least 60 seconds have passed since the initial crash (avoid catching a falling knife).

| Pod | Action | Instrument | Rationale | Position Size |
|-----|--------|------------|-----------|---------------|
| US Stocks | BUY | SPY (S&P 500 ETF) | Blue-chip index at flash-crash discount | 2% of pod capital |
| US Stocks | BUY | QQQ (Nasdaq 100 ETF) | Tech index at flash-crash discount | 2% of pod capital |
| EU Stocks | BUY | ASML, LVMH (quality names) | High-quality stocks with deep order books | 1% each of pod capital |
| Crypto | BUY | BTC/USDC, ETH/USDC | Crypto markets often flash-crash in sympathy | 1% each of pod capital |

**Execution method:** TWAP (Time-Weighted Average Price) over 5 minutes. Do NOT market-order — liquidity is still thin and market orders will get poor fills.

**Risk Manager constraints during opportunistic phase:**
- Maximum 50% of normal position sizes (elevated uncertainty).
- Stop-loss at 3% below entry (if the crash deepens, it may not be a flash crash).
- If fundamental news emerges during accumulation, immediately halt and re-evaluate.

### Recovery Monitoring (T+5min to T+60min)

- **Execution Agent:** Track bid-ask spread normalization. Full recovery = spreads return to pre-crash levels.
- **Risk Manager:** Gradually increase position size limits as volatility declines. Restore normal limits only after realized volatility falls below 2-sigma.
- **OSINT Swarm:** Monitor for regulatory announcements (SEC trading halts, exchange statements).
- **Orchestrator:** Conduct automated post-mortem: compare Alphanix's actions vs. the optimal strategy (buy the dip immediately after crash bottom). Store results in Postgres for model improvement.

### Anti-Amplification Safeguards

These are always-on rules that prevent Alphanix from becoming part of a feedback loop:

1. **Velocity circuit breaker:** If portfolio-level P&L changes by more than 2% in under 60 seconds, all new order generation halts automatically.
2. **Cross-pod correlation limit:** If more than 3 pods generate SELL signals within the same 10-second window without a fundamental news trigger, Orchestrator overrides all signals and activates review mode.
3. **Order book depth check:** Execution Agent refuses to place market orders when order book depth is below 20% of the 24-hour average.
4. **Self-awareness test:** Before executing any order during a high-volatility event, the Execution Agent checks: "Would this order worsen the market condition it is responding to?" If yes, the order is held.

### Historical Precedent

| Event | Date | Duration | Drop | Recovery |
|-------|------|----------|------|----------|
| Flash Crash | May 6, 2010 | 36 minutes | Dow -998 pts (-9.2%) | Full recovery same day |
| ETF Flash Crash | Aug 24, 2015 | ~30 minutes | SPY -5%, individual ETFs -20%+ | Most recovered within 1 hour |
| VIX Flash Crash | Feb 5, 2018 | 1 day | XIV -96% (liquidated) | VIX normalized in 2 weeks |
| Crypto Flash Crash | May 19, 2021 | ~4 hours | BTC -30% | Partial recovery within 24h |

---

## Cross-Playbook Patterns

| Pattern | Primary Detection Source | Typical Response Time | Expected Duration | Capital Shift |
|---------|------------------------|-----------------------|-------------------|---------------|
| Geopolitical shock | OSINT + AIS | 5-15 seconds | Days to weeks | +20% to Commodities |
| Infrastructure failure | Trafikverket / satellite | 10-30 seconds | Days to months | Sector rotation within EU Stocks |
| Legal/regulatory event | Court database NLP | 2-10 seconds | Months to permanent | Sector shorts + competitor longs |
| Supply chain disruption | Satellite + OSINT + weather | 15-60 seconds | Weeks to months | Cross-pod (stocks + commodities + crypto) |
| Market microstructure | Order book + cross-exchange | 1-5 seconds | Minutes to hours | Defensive first, opportunistic second |

## Key Principles

1. **Multi-signal correlation.** Never trade on a single data source. Require 2+ independent confirmations from distinct data categories before authorizing execution.

2. **Speed hierarchy.** Detection (seconds) -> Correlation (seconds) -> Analysis (seconds) -> Execution (seconds) -> Monitoring (hours/days). The competitive advantage is in the first 15 seconds.

3. **Risk-first execution.** In every playbook, the Risk Manager acts before the Quant Agent. Protect existing capital, then seek alpha. The kill switch is always faster than the buy button.

4. **Duration-aware position sizing.** Flash crashes recover in minutes — use small positions with tight stops. Infrastructure crises last months — use larger positions with wider stops. Match position duration to event duration.

5. **Feedback protection.** Alphanix must detect when it is contributing to a feedback loop and halt immediately. The anti-amplification safeguards (Playbook 5) are always active, not just during flash crashes.

6. **Information advantage window.** The period between Alphanix's detection and mainstream media coverage is where alpha is generated. Playbook 3 (legal ruling) has a 3-15 minute window. Playbook 1 (maritime blockade) has a 5-30 minute window. Sizing and urgency scale with the window duration.

7. **Thesis invalidation.** Every playbook defines explicit conditions under which the thesis is wrong and positions should be unwound. Trading without a defined exit condition is speculation, not systematic trading.
