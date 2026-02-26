# System Insights — 2026-02-16

Samlade insikter från fullständig systemaudit, hälsokontroll och diskanalys.

---

## 1. DUST_NOTIONAL — Rotorsak & Fix

**Problem:** 100% av stängda positioner (4/4) blev DUST_NOTIONAL write-offs. Positioner öppnades vid ~$5 istället för $7.50, och efter prisdroppar föll de under Binance NOTIONAL minimum (~$5) och kunde inte säljas.

**Rotorsak:** `market.limits?.cost?.min` returnerar `undefined` för vissa par → fallback till `CONFIG.MIN_ORDER_VALUE = 1.0` → `safeMinNotional = $1.50` → $5-positioner passerade checken. Dessutom avrundade `amountToPrecision()` kvantiteten nedåt.

**Fix (5 ändringar, deployade):**
1. `MIN_ORDER_VALUE: 1.0` → `7.50`
2. Fallback `5.0` istället för `CONFIG.MIN_ORDER_VALUE` vid saknad market data
3. `safeMinNotional = Math.max(pairMinNotional * 1.5, CONFIG.MIN_ORDER_VALUE)` — hård golv
4. Post-rounding check efter `amountToPrecision()`
5. Proaktiv dust-exit i monitorPositions() när värde < $7.50 men >= $5.00

**Verifierat:** Alla 5 ändringar bekräftade i både källkod och kompilerad route.js.

---

## 2. Web Container Healthcheck — FAIL

**Symptom:** `cryonix-web-1` rapporterar `unhealthy`, FailingStreak: 17.

**Rotorsak:** Docker healthcheck konfigurerad med `curl`, men Alpine-imagen har bara `wget`. Healthcheck-kommandot hittar inte `curl` i PATH.

**Appen fungerar fint** — `/api/health` returnerar grönt (Redis 9ms, Postgres 8ms, Engine 163ms, Binance 288ms).

**Fix:** I Dockerfile eller docker-compose.prod.yml, byt healthcheck till:
```
wget -q --spider http://localhost:3000/api/health
```
Alternativt installera curl i Dockerfile (`apk add --no-cache curl`).

---

## 3. Data-integritetsproblem

### 3.1 Stale FILLED-trades i Postgres

13 trades i Postgres har status `FILLED` men finns inte i Redis `positions:open`. De har stängts på Binance (via stop-loss eller manuellt) men Postgres uppdaterades aldrig till `CLOSED`.

**Påverkade:** CRV, WIF, PYTH, AIXBT, SOL, ATOM, POL, BNB, LINK, SEI, ETH (2026-02-14 till 2026-02-15).

**Rotorsak:** Close-position-flödet uppdaterar Redis men gör inte `UPDATE trades SET status='CLOSED'` i Postgres. Postgres `trades`-tabellen används mest för loggning (write-only), inte som source of truth.

**Åtgärd:** Engångs-SQL för att rensa:
```sql
UPDATE trades SET status = 'CLOSED'
WHERE status = 'FILLED'
AND created_at < '2026-02-16';
```

### 3.2 Duplicerad BNB/USDC-order

Två identiska FILLED-trades för BNB/USDC @ $635.43 med 0.009 qty, öppnade 23ms isär (14:54:30.088 och 14:54:30.111). Race condition i executeBuy().

**Åtgärd:** Lägg till dedup-guard i executeBuy() — t.ex. Redis-lock per symbol med kort TTL.

### 3.3 positions:open nyckeltyp

`positions:open` är en JSON-sträng, inte en Redis set. `SMEMBERS` fungerar inte. Appen serialiserar hela position-arrayen som string. Fungerar men är icke-standard.

### 3.4 Daily PnL-räknare

`trades:daily_pnl` och `trades:daily_count` är nil. Antingen körs inte daily reset, eller så används inte dessa nycklar i nuvarande kodversion.

---

## 4. Diskstrategi

### Nuläge (efter cleanup)

| Resurs | Storlek | Andel |
|--------|---------|-------|
| Docker images | ~8.7 GB | 51% av använt |
| Docker containers | 1.1 GB | 6% |
| Docker volumes | 98 MB | <1% |
| node_modules | 863 MB | 5% |
| Postgres | 17 MB | <1% |
| Redis | 1.9 MB | <1% |
| Backups | 583 KB | <1% |
| **Total använt** | **17G / 29G (59%)** | |

### Tillväxttakt

- **Signals:** ~12,500/dag, ~3 MB/dag → ~1 GB/år. Inte ett problem.
- **Validation history:** ~1,600/dag, ~1.4 MB/dag. Följer signals.
- **Docker build cache:** ~200-900 MB per build. Växer snabbt utan pruning.
- **Backups:** 583 KB/dag med 7-dagars rotation → max ~4 MB.
- **Redis:** Stabilt runt 2 MB. Inga tillväxtproblem.

### Rekommendation

- Kör `docker builder prune -f` efter varje deploy (eller lägg i deploy-skriptet)
- Överväg `docker image prune -a` kvartalsvis (tar bort oanvända images)
- Signals-tabellen kan behöva cleanup efter ~6 månader (VACUUM eller DELETE äldre än 90 dagar)
- `alpine/openclaw` (4.2 GB) är Claude Code-containern — behålls

---

## 5. Resursanvändning

### Minne (3.8 Gi host)

| Container | Minne | Notering |
|-----------|-------|----------|
| engine | 378 MiB | Python + CCXT + pattern detection |
| web | 317 MiB | Next.js + CCXT + auto-trade |
| Övriga (7 st) | ~600 MiB | Postgres, Redis, bots, caddy, etc. |
| **Totalt** | **~1.3 GiB** | 60% av 3.8 Gi |

**Risk:** Vid hög last kan engine + web OOM:a. Inget maxmemory satt i Redis. Övervaka med `docker stats`.

### CPU

Generellt låg. Engine-scanning (45 par var 10:e sekund) och auto-trader polling (var 30:e sekund) är de tyngsta.

---

## 6. Oanvänd kod — Highlights

Fullständig audit finns i chat-historik (2026-02-16). Sammanfattning:

### Döda paket
- **packages/intelligence/** — helt oanvänd stub. Kan tas bort.

### Legacy-kod (delvis använd)
- **packages/agents/** — MarketScoutAgent, ExecutorAgent, pattern detectors är döda. BacktesterAgent, RiskManagerAgent, ClaudeAssistant används via API routes.

### Oanvända dashboard-komponenter (18 st)
active-positions, ai-signals, backtest-results, deep-value-alerts, grid-manager, market-ticker, orchestrator-status, portfolio-donut, portfolio-summary, position-manager, price-ticker, quick-trade, risk-gate-approval, risk-monitor, signal-validator, tank-monitor, trading-chart, value-stats.

### Oanvända DB-tabeller (10 st)
users, portfolio, marketData, agentActions, mlModels, orchestratorState, positionHistory (schema finns men importeras aldrig), telegramSignals, telegramChannels, positions.

### UI-paket
Bara 11 av 48 shadcn-komponenter används (77% oanvänt).

### Döda scripts
copilot-agent.mjs, run_evolution.bat, deploy-evolution-to-vm.bat (säkerhetsrisk: hårdkodad GitHub-token).

---

## 7. Caddy / Reverse Proxy

Caddy loggar 502-errors (`connection refused` till web:3000) när web-containern startar om. Detta är förväntat — Caddy har ingen retry/backoff konfigurerad.

**Åtgärd:** Lägg till `lb_try_duration` eller health checks i Caddyfile så att Caddy väntar tills web är redo.

---

## 8. Prioriterad åtgärdslista

### Kritisk
1. Fixa web healthcheck (curl → wget)

### Hög
2. Rensa 13 stale FILLED-trades i Postgres
3. Lägg till dedup-guard i executeBuy() (race condition)
4. Lägg till `docker builder prune -f` i deploy-skriptet

### Medium
5. Övervaka minnesanvändning (engine 378 MiB på 3.8 Gi host)
6. Verifiera daily PnL-räknare
7. Signals-tabellen: planera cleanup-strategi vid >100K rader

### Låg
8. Ta bort packages/intelligence/
9. Ta bort 18 oanvända dashboard-komponenter
10. Ta bort deploy-evolution-to-vm.bat (hårdkodad token)
11. Caddy retry-konfiguration
