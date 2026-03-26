# The Agent Army — Arkitektur & Modeller

Här är en förenklad översikt över hur hela ekosystemet ("Cryonix Agent Army") hänger ihop. Projektet är byggt som en **svärm av agenter** där varje del har en specifik uppgift. Tillsammans samlar de in data, verifierar den, fattar beslut, handlar och utvärderar sig själva för att hela tiden bli bättre.

Vi kan dela in systemet i fyra logiska lager:
1. **Sensorer / Data** (Samlar information)
2. **Hjärnan / Logik** (Analyserar, godkänner och lär sig)
3. **Armén / Agenterna** (Strategi-specifika instanser som utför handlandet)
4. **Utförande / Utvärdering** (Själva köpen och utvärderingen)

---

## 1. Övergripande Arkitektur

Detta diagram visar hur data flödar från marknaden hela vägen ner till ett faktiskt köpbeslut.

```mermaid
flowchart TD
    %% Färger
    classDef data fill:#e1f5fe,stroke:#03a9f4,color:#000
    classDef brains fill:#fff3e0,stroke:#ff9800,color:#000
    classDef agents fill:#e8f5e9,stroke:#4caf50,color:#000
    classDef execution fill:#ede7f6,stroke:#673ab7,color:#000
    classDef infra fill:#eceff1,stroke:#607d8b,color:#000

    %% 1. Sensorer
    subgraph SENSORER ["📡 SENSORER (Känner av marknaden)"]
        direction LR
        MarketScout["MarketScout (Python)\nTA & Priskurvor"]:::data
        NewsScout["NewsScout / X Sentiment\nSentiment & Nyheter"]:::data
        TelegramScrap["Telegram Scraper\nExterna Signaler"]:::data
        CMC["CMC Scout\nMacro & Fear/Greed"]:::data
    end

    %% Databas
    Redis[(Redis\nMessage Broker)]:::infra

    %% 2. Hjärnan
    subgraph HJARNAN ["🧠 HJÄRNAN (Validering & Evolution)"]
        GrokValidator{"Grok AI Validator\nGatekeeper (Godkänn/Neka)"}:::brains
        AIBrain["AI Brain (Grok 3)\nKänner av och Skruvar på parametrar"]:::brains
        EvoEngine["Evolution Engine (Claude)\nSkriver om och förbättrar koden"]:::brains
        Calibrator["Pattern Calibrator\nRäknar ut Win/Loss på mönster"]:::brains
    end

    %% 3. Armén (Agenterna)
    subgraph ARMEN ["🤖 ARMÉN (De olika instanserna/strategierna)"]
        direction LR
        AutoTrader["AutoTrader\nHuvudstrategi"]:::agents
        Huntrix["Huntrix (9)\nJagar Pump & Dumps"]:::agents
        Aktienix["Aktienix\nAktier/Makro"]:::agents
        VedicBTD["Vedic BTD\nVenus Rx köp-dippen"]:::agents
        Copynix["Copynix / Solanix\nPlånboks-kopierare / Meme-coins"]:::agents
        APEX["APEX Trader\nMeta-intelligens (Kombinerar ALLA)"]:::agents
    end

    %% 4. Utförande
    subgraph EXECUTION ["⚡ UTFÖRANDE & LAGRING"]
        Binance(("Binance / Mäklare\n(Köp/Sälj)")):::execution
        Postgres[(Postgres\nHistorik & Loggar)]:::infra
    end

    %% Kopplingar
    SENSORER --> Redis
    Redis --> ARMEN
    ARMEN --> GrokValidator
    
    GrokValidator -- Godkänt --> Binance
    GrokValidator -- Nekat --> Postgres
    
    Binance --> Postgres
    Postgres --> Calibrator
    Calibrator --> Redis
    
    Postgres -. "Prestandadata" .-> AIBrain
    Postgres -. "Prestandadata" .-> EvoEngine
    AIBrain -. "Direktiv" .-> EvoEngine
```

---

## 2. Agent-Armén: Vem gör vad?

Istället för en enda stor kodklump som ska vara bra på allt, fungerar systemet som en armé där varje agent är en *specialist*. De senaste tillskotten och de nya konfigurationerna har gjort teamet väldigt vasst:

*   **Auto-Trader (Core):** Den stadiga arbetshästen. Följer klassisk Teknisk Analys (TA) och volym.
*   **Huntrix (tidigare Predator Hunter):** Spårhunden. Letar medvetet efter koordinerade "shills" och pump-and-dump grupper på X och Telegram för att surfa medvetet på vågen, och hoppa av innan dumpen.
*   **Vedic BTD (Buy The Dip):** Astrologi-/Cykel-agenten. Ligger ibland passiv och kliver bara in när specifika cykler (ex. Venus Retrograde) pekar på starka dippar att köpa.
*   **Aktienix:** Makro-agenten. Har koll på geopolitik, Fear & Greed, optioner (straddles/put-call ratios) för att förstå hur den *vanliga* marknaden mår.
*   **Copynix / Psinix:** Följer plånboksadresser (valar) för att kopiera smarta drag ("Smart Money").
*   **APEX Trader (The General):** Över-agenten. Istället för att titta på marknaden tittar den på *de andra agenterna*. Går flera agenter åt samma håll skapar det "Confluence" (sammanflöde) och APEX tar en tung position.

---

## 3. Maskininlärningen / "Super-Hjärnan"

Det unika med projektet är att det inte dör om logiken blir inaktuell. Systemet bygger om sig självt.

```mermaid
sequenceDiagram
    participant Marknad as 📊 Binance
    participant Agent as 🤖 AutoTrader
    participant Calibrator as 🧮 Calibrator
    participant Brain as 🧠 AI Brain (Grok)
    participant Evo as 🧬 Evo Engine (Claude)

    Marknad->>Agent: Genomför trade
    Agent->>Marknad: Vinner / Förlorar
    
    Note over Calibrator: Var 6:e timme
    Calibrator->>Calibrator: Räknar ut statistik
    
    Note over Brain: Kollar förluster
    Brain->>Evo: "Vi blir utstoppade för ofta. Ge direktiv!"
    
    Note over Evo: Klona, Testa, Ändra
    Evo->>Evo: Bygger om riskparametrar i cryonix.toml
    Evo->>Agent: Uppdaterad kod/konfig (Deploy)
```

**Hur det fungerar i tre steg:**
1. **Utvärdering:** `self_calibrate.py` och `Pattern Calibrator` räknar ut om The Agent Army tjänar eller förlorar pengar på specifika mönster.
2. **Beslut:** `AI Brain` (Grok 3 Mini Fast) tittar på statistiken. Upptäcks ett fel (t.ex. *Stop-Loss löser ut för tidigt*) skapas direktiv.
3. **Evolution:** `Evolution Engine` (Claude Code) får direktiven, skriver om källkoden eller inställningarna (`cryonix.toml`), kör kod-tester `pnpm test`, och om det passerar trycker den ut den nya, smartare versionen.
