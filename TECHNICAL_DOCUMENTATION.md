# AI Agent Platform - Teknisk Dokumentation

## Projektöversikt

Detta är en avancerad AI-agentplattform som låter användare skapa, konfigurera och köra intelligenta agenter genom en visuell drag-and-drop-gränssnitt. Plattformen stöder olika typer av agenter för automatisering av uppgifter som trading, e-posthantering, schemaläggning och mer.

## Teknisk Stack

### Frontend
- **React 18** - Huvudramverk
- **TypeScript** - Typsäkerhet
- **Vite** - Build-verktyg och utvecklingsserver
- **Tailwind CSS** - Styling och design system
- **React Router** - Navigering
- **@xyflow/react** - Visuell flödesbyggare
- **Shadcn/ui** - UI-komponentbibliotek
- **Lucide React** - Ikoner

### Backend
- **Supabase** - Backend-as-a-Service
- **PostgreSQL** - Databas
- **Edge Functions** - Serverless funktioner
- **Row Level Security (RLS)** - Säkerhet

### Externa Integrationer
- **OpenAI API** - AI-funktionalitet
- **Binance API** - Kryptovaluta trading
- **Email APIs** - E-posthantering
- **Webhook support** - Externa integrationer

## Arkitektur

### Mappstruktur
```
src/
├── components/          # Återanvändbara komponenter
│   ├── agents/         # Agent-specifika komponenter
│   ├── dashboard/      # Dashboard-komponenter
│   ├── flow/          # React Flow komponenter
│   │   └── nodes/     # Nodtyper för flödesbyggaren
│   ├── layout/        # Layout-komponenter
│   └── ui/           # Shadcn UI-komponenter
├── hooks/             # Custom React hooks
├── integrations/      # Supabase integration
├── lib/              # Utility-funktioner
└── pages/            # Sidkomponenter

supabase/
├── functions/        # Edge Functions
└── config.toml      # Supabase konfiguration
```

## Huvudfunktioner

### 1. Agent Builder (Visual Flow Editor)
**Fil:** `src/pages/AgentBuilder.tsx`

En komplex visuell editor som låter användare:
- Dra och släppa noder för att skapa arbetsflöden
- Konfigurera varje nod med specifika inställningar
- Koppla samman noder för att skapa logik
- Generera flöden med AI baserat på beskrivningar
- Spara och redigera existerande agenter

**Nodtyper:**
- **TriggerNode** - Startar flödet (manuell, schema, webhook)
- **GPTNode** - AI-analys och beslutsfattning
- **BinanceNode** - Kryptovaluta trading-operationer
- **EmailNode** - E-posthantering
- **ConditionNode** - Villkorlig logik
- **WebhookNode** - Externa API-anrop

### 2. Agent Chat Interface
**Fil:** `src/pages/AgentChat.tsx`

Chattgränssnitt för interaktion med agenter:
- Realtidschatt med agenter
- Sessionbaserade konversationer
- Agent-konfiguration i sidopanel
- Test- och felsökningsfunktioner

### 3. Agent Dashboard
**Fil:** `src/pages/Dashboard.tsx`

Översiktsvy med:
- Statistik över agentprestanda
- Översikt av aktiva agenter
- Snabbåtkomst till vanliga funktioner

### 4. Agenthantering
**Fil:** `src/pages/Agents.tsx`

Centraliserad hantering av alla agenter:
- Lista över alla skapade agenter
- Status och prestandainformation
- Redigering och borttagning av agenter

## Databassschema

### Huvudtabeller

#### `agents`
Lagrar agentdefinitioner och konfigurationer
```sql
- id (uuid, primary key)
- user_id (uuid, not null)
- name (text, not null)
- description (text)
- agent_type (text, not null)
- status (text, default 'inactive')
- configuration (jsonb) -- Flödeskonfiguration
- performance_data (jsonb)
- api_integrations (jsonb)
- memory_context (jsonb)
- interaction_style (jsonb)
```

#### `agent_conversations`
Lagrar chatthistorik mellan användare och agenter
```sql
- id (uuid, primary key)
- user_id (uuid, not null)
- agent_id (uuid)
- session_id (text, not null)
- message_type (text, not null)
- content (text, not null)
- metadata (jsonb)
```

#### `agent_templates`
Fördefinierade agentmallar
```sql
- id (uuid, primary key)
- name (text, not null)
- agent_type (text, not null)
- description (text)
- prompt_template (text)
- required_integrations (text[])
- default_configuration (jsonb)
```

#### `trades`
Trading-data för kryptoagenter
```sql
- id (uuid, primary key)
- user_id (uuid, not null)
- bot_id (uuid)
- symbol (text, not null)
- side (text, not null) -- 'BUY' eller 'SELL'
- quantity (numeric)
- price (numeric)
- status (text, default 'PENDING')
- confidence (integer)
- risk_score (integer)
```

#### `profiles`
Användarprofilinformation
```sql
- id (uuid, primary key)
- user_id (uuid, not null)
- display_name (text)
- avatar_url (text)
- subscription_tier (text, default 'basic')
```

## Edge Functions

### 1. agent-executor
**Fil:** `supabase/functions/agent-executor/index.ts`
- Kör agentflöden baserat på konfiguration
- Hanterar stegvis exekvering av noder
- Processerar resultat och tillstånd

### 2. ai-chat
**Fil:** `supabase/functions/ai-chat/index.ts`
- Hanterar AI-konversationer
- Integrerar med OpenAI API
- Hanterar kontext och minneshantering

### 3. generate-flow
**Fil:** `supabase/functions/generate-flow/index.ts`
- AI-generering av flöden baserat på beskrivningar
- Skapar noder och kopplingar automatiskt
- Optimerar flödesstruktur

### 4. market-analysis-ai
**Fil:** `supabase/functions/market-analysis-ai/index.ts`
- Kryptomarknadsanalys med AI
- Teknisk analys av prisdata
- Handelssignaler och rekommendationer

### 5. autonomous-trading-loop
**Fil:** `supabase/functions/autonomous-trading-loop/index.ts`
- Automatisk trading-loop för kryptoagenter
- Kontinuerlig marknadsövervakning
- Riskhantering och positionshantering

### 6. risk-analysis
**Fil:** `supabase/functions/risk-analysis/index.ts`
- Riskbedömning för trades
- Portföljanalys
- Säkerhetskontroller

### 7. data-fetch-service
**Fil:** `supabase/functions/data-fetch-service/index.ts`
- Extern datahämtning
- API-integrationer
- Dataprocessering och caching

### 8. agent-creation-chat
**Fil:** `supabase/functions/agent-creation-chat/index.ts`
- AI-assisterad agentskapande
- Chattbaserad konfiguration
- Automatisk flödesgenerering

## Säkerhet

### Row Level Security (RLS)
- **Användarisolering** - Användare kan bara se sina egna data
- **Rollbaserad åtkomst** - Olika behörigheter för olika användartyper
- **API-säkerhet** - Säkra API-nycklar i Supabase secrets

### Autentisering
- Supabase Auth för användarhantering
- Session-baserad autentisering
- Säker token-hantering

## UI/UX-komponenter

### Layout-komponenter
- **Navigation** - Huvudnavigering
- **AgentBuilderSidebar** - Konfigurerbar sidopanel för builder

### Flow-komponenter
- **NodeConfigPanel** - Konfigurationspanel för noder
- **NodeToolbox** - Verktygslåda med tillgängliga noder
- **Olika nodtyper** - Specialiserade komponenter för varje nodtyp

### Dashboard-komponenter
- **HeroSection** - Välkomstsektion
- **StatsOverview** - Statistiköversikt
- **AgentGrid** - Rutnät med agenter

## Konfiguration och Deploy

### Miljövariabler
Hanteras via Supabase secrets:
- `OPENAI_API_KEY` - OpenAI API-åtkomst
- `SUPABASE_URL` - Supabase projekt-URL
- `SUPABASE_ANON_KEY` - Supabase anonym nyckel

### Utvecklingsmiljö
```bash
npm install          # Installera beroenden
npm run dev          # Starta utvecklingsserver
npm run build        # Bygg för produktion
```

### Supabase Setup
```bash
supabase init        # Initiera projekt
supabase start       # Starta lokal utveckling
supabase db push     # Synka databasschema
```

## API-integrationer

### OpenAI
- GPT-4 för konversationer och analys
- Automatisk prompt-generering
- Kontexthantering

### Binance
- Realtids-prisdata
- Order-placering och hantering
- Balans- och positionsinformation

### Email APIs
- SMTP-integration
- E-postläsning och skrivning
- Automatisk kategorisering

## Prestanda och Skalbarhet

### Frontend
- Lazy loading av komponenter
- Memoization av tunga beräkningar
- Optimerad rendering av React Flow

### Backend
- Edge Functions för låg latens
- Database indexering för snabba frågor
- Caching av frekventa API-anrop

## Framtida Utveckling

### Planerade Funktioner
- Fler nodtyper och integrationer
- Team-funktionalitet
- Avancerad monitoring och logging
- Marketplace för agentmallar
- Mobile app

### Tekniska Förbättringar
- WebSocket för realtidsuppdateringar
- Förbättrad AI-träning
- Bättre felhantering
- Performance-optimering

## Utvecklarriktlinjer

### Kodstandards
- TypeScript strict mode
- ESLint konfiguration
- Prettier för kodformatering
- Konsistent namngivning

### Testning
- Unit tests för kritiska funktioner
- Integration tests för API-endpoints
- E2E-tester för huvudflöden

### Dokumentation
- JSDoc för funktioner och komponenter
- README för varje större komponent
- API-dokumentation för Edge Functions

Detta projekt representerar en komplett plattform för AI-driven automatisering med stark fokus på användarvänlighet, säkerhet och skalbarhet.