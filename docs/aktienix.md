# Aktienix: Automatiserad Aktiehandel

Detta dokument är en idé om att ge Cryonix en bror, som handlar med aktier.

---

# Del 1: Teknisk och Strategisk Analys för Mikrokonton

## 1. Exekutiv Sammanfattning
Denna rapport utgör en uttömmande analys av de tekniska, ekonomiska och regulatoriska förutsättningarna för att etablera en automatiserad handelsinfrastruktur (handelsrobot) för aktier som privatperson i Sverige, med en startkapitalbegränsning om 500 SEK. Analysen är specifikt utformad för utvecklare med tidigare erfarenhet av kryptovalutamarknader som avser att diversifiera mot amerikanska aktiemarknader. Rapporten utvärderar kritiskt de föreslagna tjänsterna Alpaca, Polygon.io och Financial Modeling Prep (FMP) mot bakgrund av strikta budgetrestriktioner och svenska skatteregler.

Analysen bekräftar att det är tekniskt genomförbart att initiera algoritmisk handel med 500 SEK, men det ekonomiska manöverutrymmet är extremt begränsat. Den föreslagna teknologistacken kräver betydande modifieringar för att vara kostnadseffektiv. Medan Alpaca framstår som den enda viabla mäklaren för detta segment tack vare möjligheten till fraktionshandel och avsaknad av courtage, är förslaget att använda Polygon.io finansiellt ohållbart då deras realtidsdata för handel överstiger hela startkapitalet månatligen. Rapporten identifierar kritiska flaskhalsar relaterade till Pattern Day Trader (PDT)-reglerna och T+1-avräkningscykler, vilka tvingar fram en fundamental ändring av handelsstrategin jämfört med kryptomarknader.

Vidare belyses den ofta underskattade komplexiteten i det svenska skattesystemet vid användning av utländska mäklare. Till skillnad från handel via Investeringssparkonto (ISK) hos svenska aktörer som Avanza eller Nordnet, utlöser handel via Alpaca en manuell deklarationsplikt (blankett K4) och en skattesats på 30 % av vinsten, vilket ställer höga krav på automatiserad rapportering och valutajustering. Rapporten konkluderar att projektet bör betraktas som en utbildningsinvestering i marknadsstruktur och finansiell teknik snarare än en omedelbar inkomstkälla, givet de transaktionskostnader och den administrativa börda som mikrokonton medför.

## 2. Introduktion till Marknadsstruktur: Från Krypto till Aktier
Övergången från att utveckla handelsalgoritmer för kryptovalutor till att operera på de reglerade amerikanska aktiemarknaderna innebär mer än bara ett byte av API-endpoints; det kräver en fundamental omprogrammering av förståelsen för marknadens mikrostruktur. Medan kryptomarknaden karaktäriseras av fragmentering, dygnet-runt-handel och omedelbar (eller nära omedelbar) avräkning, är aktiemarknaden en djupt centraliserad och strikt reglerad miljö. För en utvecklare med en budget på 500 SEK är förståelsen för dessa skillnader skillnaden mellan en fungerande bot och ett konto som spärras eller dräneras på kapital inom första veckan.

### 2.1 Centralisering kontra Fragmentering
I kryptovärlden är priset på Bitcoin en funktion av orderböckerna på hundratals oberoende börser (Binance, Coinbase, Kraken). Arbitrage håller priserna i schack, men det finns inget "officiellt" pris. I den amerikanska aktiemarknaden existerar konceptet National Best Bid and Offer (NBBO). Enligt Regulation NMS (National Market System) måste mäklare garantera att kunden får det bästa tillgängliga priset över alla handelsplatser vid en given tidpunkt.

Detta skapar en unik utmaning för datakonsumtion. För att få en "sann" bild av marknaden krävs data från SIP (Securities Information Processor), som aggregerar bud och anbud från alla börser (NYSE, NASDAQ, BATS, IEX, etc.). Denna data är dyr. Gratistjänster erbjuder ofta data från endast en börs (exempelvis IEX), vilket kan ge en skev bild av likviditeten och priset, särskilt i mindre likvida aktier. För en algoritm som är känslig för spreadar kan detta vara förödande.

### 2.2 Tidsaspekten och Handelsfönster
Till skillnad från kryptomarknadens 24/7-cykel är aktiemarknaden bunden till strikta öppettider (09:30–16:00 ET för ordinarie handel). Även om "Pre-market" och "After-hours" existerar, är likviditeten där ofta så låg och spreadarna så höga att de är olämpliga för mikrokonton. Detta introducerar risken för "Gap risk" – att priset på en tillgång ändras drastiskt mellan stängning en dag och öppning nästa dag, utan att algoritmen har någon möjlighet att agera däremellan.

### 2.3 Avräkningsmekanik och Likviditet
Kryptohandel innebär ofta att tillgångar byter ägare omedelbart. I aktiemarknaden sker avräkningen (settlement) enligt principen T+1 (Trade date plus one business day). Detta är en kritisk faktor för konton med begränsat kapital. Om algoritmen säljer en aktie på måndag, är likviden (pengarna) tekniskt sett inte "avräknad" och fri att använda fullt ut förrän på tisdag. För ett konto under 25 000 USD, som ofta måste operera som ett kontantkonto (Cash Account) för att undvika PDT-regler, innebär detta att kapitalet är låst under avräkningsperioden. Detta skapar en naturlig begränsning för handelsfrekvensen som inte existerar i kryptovärlden.

## 3. Regulatoriskt Ramverk och Handelsrestriktioner
Att navigera det amerikanska regelverket är den enskilt största utmaningen för småskaliga algoritmiska handlare. Reglerna är utformade för att skydda investerare men fungerar i praktiken som inträdesbarriärer för aktörer med litet kapital.

### 3.1 Pattern Day Trader (PDT) Regelverket
PDT-regeln är den mest ökända barriären för detaljhandlare. Enligt Financial Industry Regulatory Authority (FINRA) definieras en "Pattern Day Trader" som någon som utför fyra eller fler "day trades" (öppnar och stänger en position i samma instrument under samma handelsdag) inom en rullande femdagarsperiod, förutsatt att dessa affärer utgör mer än 6 % av den totala handelsaktiviteten.

**Konsekvenser för Marginkonton**
Om ett konto flaggas som PDT måste det upprätthålla ett eget kapital (equity) på minst 25 000 USD (cirka 260 000 SEK).
- **Under 25 000 USD:** Om saldot understiger denna gräns på ett marginkonto som flaggats som PDT, fryses kontot för ny dagshandel i 90 dagar, eller tills kapitalet återställts.
- **För 500 SEK-kontot:** Med ett startkapital på cirka 45 USD är det omöjligt att uppfylla detta krav. Ett marginkonto är därmed i praktiken oanvändbart för en högfrekvent strategi. 

**Lösningen: Kontantkonto (Cash Account)**
PDT-reglerna appliceras inte på kontantkonton. I ett kontantkonto lånar du inte pengar av mäklaren (ingen hävstång), och därmed anser regulatorn att risken är begränsad till ditt eget kapital.
- **Frihet:** I ett kontantkonto kan du dagshandla så många gånger du vill, så länge du använder avräknade medel (settled cash).
- **Begränsning (T+1):** Med 500 SEK kan du köpa för 500 SEK på måndag morgon och sälja på måndag eftermiddag. Därefter är saldot "oavräknat" (unsettled). Du kan inte handla igen förrän pengarna avräknats på tisdag.
- **Algoritmisk Implikation:** Boten måste programmeras att spåra `settled_cash` snarare än `total_buying_power`. 

### 3.2 Good Faith Violations (GFV)
I ett kontantkonto måste man undvika "Good Faith Violations". Detta inträffar om man köper en aktie med oavräknade medel och sedan säljer den innan medlen har avräknats.
- **Straff:** Upprepade GFV leder till att kontot begränsas till att endast få handla med fullt avräknade medel i 90 dagar. Boten måste ha strikt logik för att förhindra detta.

### 3.3 Wash Sale-regeln
En "Wash Sale" sker om du säljer ett värdepapper med förlust och köper samma eller ett "väsentligt identiskt" värdepapper inom 30 dagar före eller efter försäljningen.
- **Svensk Kontext:** Generalklausuler mot skatteflykt. Särskilt viktigt att tänka på då utländska mäklares underlag bygger på Wash Sales.

## 4. Analys av Mäklare och Infrastruktur
Valet av mäklare är den enskilt mest kritiska komponenten i arkitekturen. För en svensk privatperson med 500 SEK är urvalet extremt begränsat.

### 4.1 Alpaca Markets: Det Primära Valet
Alpaca Markets (Alpaca Securities LLC) framstår som den mest lämpliga, och kanske enda realistiska, kandidaten för detta projekt.
- **Tillgänglighet för Svenska Medborgare:** Alpaca accepterar nu kunder från Sverige och har slopat minimikravet på 30 000 USD för internationella konton.
- **Prisstruktur och Fraktionshandel:** Alpaca tillåter handel med fraktioner ner till ett nominellt värde av 1 USD. Detta innebär att 500 SEK kan fördelas på en portfölj av 40 olika aktier. Handeln är helt courtagefri.
- **Finansiering:** Alpaca har introducerat "Funding Wallets". Detta möjliggör överföring av SEK till ett lokalt kontonummer (eller via SEPA för EUR), vilket drastiskt minskar överföringskostnaderna.

### 4.2 Interactive Brokers (IBKR): Alternativet som Faller (För mikrokonton)
Interactive Brokers nämns ofta som "guldstandarden" för algoritmisk handel, men för en budget på 500 SEK är det inte realistiskt på grund av datakostnader och komplicerade avgiftsstrukturer.

### 4.3 Svenska Mäklare (Avanza/Nordnet) och Inofficiella API:er
- **Avsaknad av Officiella API:er:** Varken Avanza eller Nordnet erbjuder öppna handels-API:er för privatkunder. Nordnets API "nExt" har stoppat onboarding av nya kunder.
- **Stabilitetsrisk:** Tredjeparts-bibliotek som "reverse-engineerar" deras API:er kräver ofta hantering av BankID/TOTP, och kan sluta fungera över en natt vid en webbuppdatering.

## 5. Dataarkitektur: Utvärdering av Tjänster

### 5.1 Polygon.io: Kvalitet kostar
Polygon.io är en premiumtjänst. För en användare med nollbudget är deras gratisnivå kraftigt begränsad.
- **Rekommendation:** Använd Polygon enbart för historisk data vid backtesting, inte för livehandel (deras live streams kostar mer än startbudgeten).

### 5.2 Financial Modeling Prep (FMP): Fundamenta
FMP är utmärkt för fundamental data.
- **Användningsområde:** FMP bör användas för "Universe Selection" (t.ex. körs på kvällen) snarare än livesignaler.

### 5.3 Lösningen: Alpacas Data och Tiingo
- **Alpaca Market Data (Free Tier):** Alpaca erbjuder ett gratis dataflöde via IEX. Dugligt för likvida aktier.
- **Tiingo:** Erbjuder ett mycket generöst gratispaket med högkvalitativ data.

## 6. Ekonomisk Genomförbarhetsanalys: 500 SEK-utmaningen

### 6.1 Insättningskostnader (Funding Friction)
Det största hotet mot kapitalet är transaktionskostnader innan handeln ens börjat.
- **Slutsats:** Du måste använda en modern fintech-lösning (Wise, Revolut) eller Alpacas integrerade lokala insättningsalternativ för att undvika det traditionella banknätverkets (SWIFT) fasta avgifter.

### 6.2 Handelns Kostnader
- **Valutarisk:** Ditt konto är i USD. Bor du i Sverige har du dina utgifter i SEK. Fallet blir att din vinst minskar om dollarn försvagas.

## 7. Skatter och Administration
Att deklarera för utländska depåer i Sverige är extremt krävande rent administrativt.

### 7.1 Skatt på Utländsk Depå vs ISK
- **ISK (Svensk mäklare):** Schablonskatt. 
- **Alpaca (Utländsk depå):** Du betalar 30 % skatt på all realiserad vinst. Du måste manuellt deklarera varje försäljning på blankett K4. 

### 7.2 Valutaeffekten och K4-Rapportering
- **Krav:** Varje affär måste i deklarationen omräknas till SEK enligt dagens valutakurs. 
- **Lösning:** Du måste programmera din bot att automatgenerera denna K4 i t.ex. en CSV-fil (Datum, Antal, Valuta, Kurs SEK, Pris USD, Totalsumma SEK). 

## 8. Teknisk Arkitektur (Python)
Givet begränsningarna (ingen blankning, ingen margin, T+1), bör strategin vara Swing Trading (hålla i dagar/veckor).
**Flöde:**
1. **Universe Selection (FMP):** Varje natt, hämta fundamenta.
2. **Entry Signal (Tiingo/Alpaca):** Övervaka under dagen för dippar. Kolla mot `account.non_marginable_buying_power` (Settled cash). 
3. **Exit:** Fixerade +5% Take-profit ordrar.

---

# Del 2: Det Svenska Landskapet (Azure / IBKR ISK 2026)

## Sammanfattning
Denna rapport utvärderar förutsättningarna för aktiehandel i Sverige mot Microsoft Azure. Slutsatsen är att svenska mäklare har stängt sina dörrar för retail API-utvecklare. Det stora skiftet är **Interactive Brokers (IBKR)** som till slut, runt 2025, öppnat ISK-konton med automatiskt API-stöd.

## 1. Den Finansiella Teknologins Evolution i Sverige

### Från Öppenhet till "Walled Gardens"
Historiskt var Nordnet med nExt API ledande för "Open Banking". Detta är nu upphävt och privatpersoners automatiserade handel försvåras p.g.a. DDoS-skydd, KYC-regler och bankernas egna frontends.

**Azures Roll och Utmaningar**
Att anropa banker direkt från Microsoft Azure IP-adresser blockeras i stort sett överallt (av Avanzas/Nordnets WAF). 

## 2. Interactive Brokers (IBKR) – Den Nya Mästaren

### ISK-revolutionen hos IBKR
Att IBKR nu stödjer Investeringssparkonto (ISK) för svenskar är en "game changer" för algoritmisk handel, eftersom skatte- och valutaproblematiken försvinner.
- **Skattefördelar:** Handlare slipper K4-blanketten och omräkning från USD till SEK för varje affär.
- **API:** IBKR erbjuder ett REST-baserat Client Portal Web API via en Docker Gateway, perfekt designad för Azure Container Instances.

### Lösningen på Azure IP-blockeringar (Tailscale)
Om IBKR eller Avanza spärrar din Azure-VM's IP-adress:
1. Sätt upp **Tailscale** på din container.
2. Använd t.ex. din hemmarouter (eller Raspberry PI i hemmet) som **Exit Node**.
3. Trafiken dirigeras därmed från Azure genom ditt hemliga, trygga "Villa-nätverk", varpå banken inte blockerar det. 

## 3. Slutsats och Tillvägagångssätt

Slutsatsen är att det inhemska banknätet (Avanza/Nordnet) abdikrerat från privat algoritmhandel. Om man ska bygga för 500 SEK som ett rent lärorikt projekt är **Alpaca** den enda realistiska vägen, eftersom de erbjuder gratishandel i dollar med bråkdelar (men innebär svensk skattekomplexitet). 

Ska man dock bygga systemet seriöst i en Azure-miljö, är det rekommenderade spåret att **öppna ett IBKR ISK-konto**, hosta deras CP Gateway API i en Docker container, verifiera nätverkstrafiken via Tailscale och hämta historisk fundamental data via Börsdata Pro. 

---

# Del 3: Aktienix Agent Implementation Status (Våren 2026)

Den tekniska integrationen av `AktienixAgent` i `@cryonix/agents` har inletts med fokus på multi-mäklar-stöd. 

## Aktuell Arkitektur och Framsteg
1. **Mäklar-Agnostisk Design:** Skapat ett abstrakt `BrokerClient`-gränssnitt för att isolera agentens handelslogik från den specifika API-dialekten. Detta tillåter smidiga byten mellan olika mäklare.
2. **IBKR Integration (`ibkr-client.ts`):** 
   - Byggt för IBKR Client Portal Web API Gateway, med lokal Docker-anslutning (via IBeam-imagern) för att hantera 2FA headless.
   - Implementerat logik för session-tickles, kontostatus och ordrar.
   - **Nuvarande status:** Väntar på att nyregistrerat Paper Trading-konto ska aktiveras hos IBKR, Gateway nekar för närvarande med `Invalid username/password`.
3. **Alpaca Integration (`alpaca-client.ts`):**
   - Integrerad som en snabbare och stabilare backup-lösning för test och utveckling via det officiella `@alpacahq/alpaca-trade-api` SDK:t.
   - Pappers- och live-nycklar inlagda säkert i miljövariabler.

## Nästa Steg i Kodbasen
- Koppla agentens huvudloop (`AktienixAgent.start()`) mot Alpaca för att påbörja simuleringar.
- Skicka test-signaler till agentens internkö för att verifiera orderflödet end-to-end.
