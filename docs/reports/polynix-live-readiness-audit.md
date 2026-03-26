# Teknisk Granskning: Polynix Live-Readiness Audit

**Datum:** 2026-03-25
**Status:** KRITISK GENOMGÅNG KRÄVS
**Agent:** Polynix (Polymarket Binary Options)

## Sammanfattning
Nuvarande simuleringar i `paper_trading`-läge visar positiv P&L, men den tekniska arkitekturen innehåller flera "simulerings-bias" som riskerar att göra strategin olönsam i en live-miljö. Denna rapport identifierar de gap som måste stängas innan riktigt kapital sätts in.

## API-Analys & Out-of-the-Box Stöd
Efter genomgång av Polymarkets officiella API-dokumentation konstateras följande:
*   **Ingen Native Sandbox:** Det finns ingen testnet- eller sandbox-miljö tillgänglig från Polymarket. All utveckling och testning sker direkt mot produktions-API:er.
*   **Ingen Paper Trading-flagga:** API:et saknar inbyggt stöd för "dry runs". Alla ordrar som skickas förutsätter signering och riktigt kapital (USDC på Polygon).
*   **Tillgänglig Data för Backtesting:** API:et erbjuder kraftfulla ändpunkter för `prices-history`, `trades` och `orderbook` (L2 data). Dessa kan och bör användas för att bygga en mer realistisk simulator.

## Identifierade Risker & Gap

### 1. Latens & Polling-intervall (Hög Risk)
*   **Nuvarande läge:** Boten pollar API:et var 20:e sekund (`scan_interval_ms = 20000`).
*   **Problem:** Arbitrage-möjligheter och prisrörelser på Polymarket existerar ofta bara i sekunder eller millisekunder. 
*   **Åtgärd:** Implementera WebSockets för realtids-orderböcker (L2 data) istället för HTTP-polling.

### 2. Slippage & Orderboks-djup (Medel Risk)
*   **Nuvarande läge:** `OrderManager` antar "instant fill" till det senaste kända priset.
*   **Problem:** `polynix.toml` tillåter handel i marknader med så lite som $50 i likviditet (`min_liquidity_usd`). En order på $25 i en tunn bok kommer att flytta priset (slippage), vilket snabbt raderar arbitrage-marginalen på 3%.
*   **Åtgärd:** Uppdatera `OrderManager` att läsa hela orderboken (L2) och beräkna den faktiska exekveringskostnaden (Volume-Weighted Average Price, VWAP) baserat på tillgänglig likviditet.

### 3. Avgiftsstruktur & Netto-marginal
*   **Nuvarande läge:** Fastställd avgift på 1.56% (`fee_rate`).
*   **Problem:** Vid arbitrage handlar boten på två sidor samtidigt. Det innebär en total avgift på ~3.12% per runda. Om `arb_threshold` är 0.97 (3% marginal), är affären i praktiken en förlustaffär efter avgifter och gas.
*   **Åtgärd:** Verifiera de faktiska CLOB-avgifterna för Polymarket och dynamiskt justera `arb_threshold` baserat på rörliga avgifter.

### 4. Implementationsstatus: OrderManager (Kritisk)
*   **Nuvarande läge:** `OrderManager` är en stubbe ("Phase 2").
*   **Problem:** Ingen kod finns för att hantera EIP-712 signering, hantering av privat nyckel eller koppling till `@polymarket/clob-client`.
*   **Åtgärd:** Utveckla den skarpa kopplingen till Polymarkets CLOB-klient och implementera säker hantering av Proxy Wallets.

## Rekommenderad Åtgärdsplan: "Virtual Broker"-arkitektur

För att få en tillförlitlig simulering krävs att vi bygger om vår `OrderManager` till en sofistikerad **Virtual Broker**:

1.  **L2-Baserad Simulering:** Istället för att bara simulera vinst baserat på sista pris, ska simulatorn hämta den aktuella orderboken och "äta" sig igenom nivåerna för att se om ordern *faktiskt* skulle ha fyllts.
2.  **Trade-Validering:** Använd `/trades`-ändpunkten för att verifiera om det faktiskt skedde några avslut vid det pris simulatorn antar.
3.  **Simulerad Latens:** Lägg till en slumpmässig fördröjning (t.ex. 200-500ms) i simulatorn för att efterlikna nätverkslatens och se om arbitrage-möjligheten fortfarande finns kvar när "ordern når fram".
4.  **Gas-kalkylator:** Inkludera beräknade Polygon gas-avgifter i varje simulerad affär.

---
*Denna rapport är framtagen för att säkerställa att Cryonix-agentarmén inte bara genererar fiktiv profit, utan är tekniskt rustad för verklig marknadsexekvering.*
