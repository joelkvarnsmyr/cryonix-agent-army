# System Questions — Cryonix Agent Army

Varje del av systemet ska ställa dessa frågor till sig själv vid rätt tidpunkt.
Frågorna är inte retoriska — de kräver svar med data.

---

## 1. Master Orchestrator (varje 4h-cykel)

### Kapitalskydd
- Har vi förlorat mer än vi tjänat senaste 24h? Exakt hur mycket och varför?
- Vilken agent blöder mest? Är det paper eller live?
- Finns det stuck positions som låser kapital? Hur länge?
- Fungerar SL/TP/stagnation-exits? Triggar de som de ska?

### Profit-acceleration
- Vilka signaler avvisade vi som HAD blivit vinnare? (missed alpha query)
- Stänger vi vinnare för tidigt? (jämför avg holding-tid: wins vs losses)
- Ligger kapital och sover som borde jobba? (idle cash ratio)
- Kan vi allokera MER till det som bevisligen funkar?

### Systemhälsa
- Är alla 26 tjänster uppe? Har något crashat sedan förra cykeln?
- Har evolution/brain kört? Förbättrade eller försämrade det?
- Är calibration aktuell eller stale? (kolla TTL)
- Fungerar Telegram-bots? Når alerts ut?

### Korrelation & diversifiering
- Handlar 2+ agenter samma symbol just nu? (dubbelrisk)
- Förlorar alla agenter samtidigt? (systemisk risk, inte agentproblem)
- Vilken agent är MINST korrelerad med resten? (mest diversifierande)
- Har vi agents som gör exakt samma sak? (redundans utan värde)

### Exekvering
- Vad har jag GJORT sedan förra cykeln? (inte bara analyserat)
- Finns det GRÖNA åtgärder jag borde ha kört men inte gjorde?
- Har jag skickat GUL/RÖD Telegram-förfrågningar som väntar på svar?

---

## 2. Varje Agent (varje trade-beslut)

### Före entry
- Har jag sett denna signal förut? Vad hände då? (calibration EV)
- Vad är marknadens regim just nu? (trending/ranging/volatile/crash)
- Är det rätt tid på dygnet för denna marknad? (market hours)
- Finns det anledning att INTE handla? (earnings, macro event, extreme F&G)
- Kommer min förväntade vinst täcka fees med marginal? (PnL > 3× fees)
- Har jag redan en position i denna eller korrelerad symbol?
- Stödjer andra agenter denna tes? (confluence)

### Under position
- Har premissen för traden ändrats? (regim-skift, nyhetsbreak)
- Borde jag flytta SL/TP baserat på ny information?
- Har jag hållit längre än förväntat utan rörelse? (stagnation)
- Visar andra agenter motsatt signal nu? (divergens = varning)

### Efter exit
- Varför gick det bra/dåligt? (attribution: pattern, timing, sizing, luck)
- Hade jag kunnat hållit längre? (left money on table)
- Borde jag haft mindre/mer position? (sizing review)
- Lärdom att mata tillbaka till calibration?
- Var entry-timing optimal eller kunde jag väntat? (slippage)

---

## 3. Systemet som helhet (meta-reflektion)

### Veckovis
- Blir vi bättre? (WR trend, PF trend, Sharpe trend — inte bara senaste siffra)
- Lönar sig varje agent individuellt? (intäkt vs kostnad per agent)
- Vilka mutations/evolution förbättrade och vilka försämrade?
- Täcker vi våra driftkostnader? (kostnadstäckning ≥ 2.0x?)
- Har vi paper-agenter redo för live-promovering?

### Strategiskt (månadsvis)
- Fiskar vi i rätt vatten? (rätt marknader, rätt instrument, rätt tidshorisont)
- Har marknaden ändrats sedan vi designade strategin?
- Vad gör konkurrenterna annorlunda? (open-source bots, nya papers)
- Har vi blinda fläckar? (marknader vi inte bevakar, data vi inte samlar)
- Vilka nya datakällor finns tillgängliga? (gratis API:er, nya exchanges)

### Överlevnad
- Om ALLT går fel samtidigt, hur mycket förlorar vi max? (worst case drawdown)
- Hur snabbt kan vi stänga ner ALLT? (nödstopps-tid i minuter)
- Är vi beroende av en enskild tjänst/API som kan gå ner? (single points of failure)
- Vad kostar det att driva systemet om det gör 0 vinst i en månad?
- Har vi backups av kritisk data? (Postgres, TOML configs, evolution history)
