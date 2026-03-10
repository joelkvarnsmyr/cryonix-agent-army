# Aktienix: Monorepo-strategi i Cryonix

Eftersom **Cryonix** redan är byggt som en modern monorepo (Troligtvis med Turborepo och pnpm, givet strukturen med `apps/`, `packages/` och `turbo.json`), är det ett strategiskt genidrag att bygga **Aktienix** (aktiehandelsboten) inuti samma ekosystem istället för som ett fristående projekt.

Här är en genomgång av hur det rent arkitektoniskt skulle byggas, samt vilka de massiva fördelarna är med att samköra dem.

## 1. Vad är fördelarna med att samköra Aktienix med Cryonix?

Att lägga Aktienix i Cryonix-monorepot ("Agent Army") ger enorma synergieffekter, både för utvecklingshastighet och systemets intelligens.

### Synergi av Intelligens (Agent Army)
Cryonix verkar bygga på ett multi-agentsystem (`packages/intelligence`, `packages/agents`). 
* **Delad Hjärna:** Aktienix kan bli en specifik *agent* i armén (en "Trading Agent"). Den kan dra nytta av samma LLM-infrastruktur, minneshantering och RAG-system (Retrieval-Augmented Generation) som Cryonix använder.
* **Samarbete:** Om Cryonix samlar in nyheter från sociala medier eller nyhetssajter, kan Aktienix prenumerera på den datan och utföra sentimentanalys för att fatta köpbeslut på aktiemarknaden.

### Kodåteranvändning (DRY - Don't Repeat Yourself)
* **Databas & Modeller:** Du slipper sätta upp en ny Postgres-databas eller nya Prisma-scheman. Du lägger bara till `StockOrder` och `Portfolio` i det befintliga schemat i `packages/database`.
* **Typer:** TypeScript-interface och Python-Dataklasser (`packages/types`, `packages/engine/src/models/analysis.py`) kan delas sömlöst.
* **UI-Komponenter:** När du bygger dashboarden för Aktienix kan du limma in samma knappar, grafer och tabeller från `packages/ui` som webb-appen för Cryonix använder.

### Smidigare DevOps & Drift
* **Ett enda bygge:** Turborepo (`turbo.json`) förstår beroenden. Bygger du om databaspaketet, vet Turbo att både Cryonix och Aktienix måste byggas om.
* **Gemensam Docker/Deploy:** Du kan deploya allt i ett svep (t.ex. via Vercel för frontend och en Docker/Azure/Railway-lösning för backend-agenterna). 
* **Ett kommando:** Du skriver `pnpm run dev` och hela ditt AI-imperium (både kryptobot och aktiebot) startar lokalt.

---

## 2. Hur skulle arkitekturen se ut i Monorepot?

Ett Turborepo består normalt av **Apps** (saker som körs och deployas, t.ex. webbsidor, servrar, CLI) och **Packages** (delad kod, bibliotek).

Så här bör du integrera Aktienix:

### Alternativ A: Aktienix som en fristående App (`apps/aktienix`)
Om Aktienix är en stor, tung demon (t.ex. en Python-arbetsbörda som dygnet runt lyssnar på IEX live-data) är det bäst att isolera den som en egen app.

```text
cryonix-agent-army/
├── apps/
│   ├── web/               # Gemensam dashboard (Visar både Krypto och Aktier)
│   ├── cryonix/           # Den befintliga Krypto-boten
│   └── aktienix/          # [NY] Aktie-boten (Python/TS som kör IBKR/Alpaca)
├── packages/
│   ├── database/          # Gemensam Postgres/Redis (Prisma/Drizzle)
│   ├── engine/            # [DELAD] Logik för marknadsanalys och risk
│   ├── intelligence/      # [DELAD] LLM-agenter och prompt-hantering
│   └── ui/                # React/Tailwind-komponenter
```

### Alternativ B: Aktienix som en Agent Plug-in (`packages/agents/aktienix`)
Om din vision med "Cryonix Agent Army" är att du har en central "General" (Master-server) som skickar ut ordrar till olika under-agenter, bör Aktienix byggas som en modul i `agents` paketet.

```text
cryonix-agent-army/
├── apps/
│   ├── orchestrator/      # Huvud-motorn som styr alla agenter
│   └── web/               # Dashboard
├── packages/
│   ├── agents/
│   │   ├── crypto/        # Cryonix (Binance/Bybit etc)
│   │   └── aktienix/      # [NY] Aktie-agent (Alpaca / IBKR)
│   ├── database/
```

### Konkreta integrationssteg (Micro-Tasks)
1. **Initiera paketet:** Skapa en mapp `apps/aktienix` med egen `package.json` eller `pyproject.toml`.
2. **Koppla Beroenden (pnpm):** I Aktienix `package.json`, lägg till `"@cryonix/database": "workspace:*"` och `"@cryonix/engine": "workspace:*"`. Nu har handelsboten tillgång till den gemensamma databasen och analysverktygen direkt.
3. **Konfigurera Turbo:** Uppdatera `turbo.json` så att kommandot `dev` startar din aktie-loop parallellt med kryto-loopen.
4. **Utöka Databasen:** Gå in i `packages/database` och lägg till tabellerna `AktienixTrade`, `AktienixPortfolio` och de relationer som behövs mot det befintliga `User` eller `Agent`-systemet.
5. **Utöka Dashboarden:** Importera Aktienix API-routes i `apps/web` för att bygga en flik i UI:t som heter "Stocks", renderad med samma `packages/ui`-bibliotek.

## Slutsats
Att hålla isär krypto-handel och aktiehandel i olika GitHub-repon leder ofta till konfigurations-helvete (version mismatch i databasen, dubbelt arbete med UI). Att lägga Aktienix i Cryonix monorepo maximerar potentialen i din "Agent Army" och gör att de två systemen kodmässigt (och kanske till och med finansiellt) kan kommunicera med varandra direkt.
