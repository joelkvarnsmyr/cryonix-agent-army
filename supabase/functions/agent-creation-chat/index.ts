import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const openAIApiKey = Deno.env.get('OPENAI_API_KEY');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const agentCreationSystemPrompt = `Du är en expert AI-assistent som hjälper användare att skapa intelligenta AI-agenter. Din uppgift är att guide användare genom processen att skapa och konfigurera agenter på ett naturligt, konversationsmässigt sätt.

TILLGÄNGLIGA AGENT-TYPER:
1. **SchedulerAgent** - Hanterar kalender, planering och daglig organisation
2. **InboxAgent** - E-posthantering, sortering och svar-förslag  
3. **MessengerAgent** - Facebook Messenger övervaning och social kommunikation
4. **SMSAgent** - SMS-hantering och snabba svar
5. **ReminderAgent** - Påminnelser och uppgiftshantering
6. **ContextManagerAgent** - Koordinerar andra agenter och håller koll på helheten

TEAM-AGENTER:
- En ContextManagerAgent kan leda ett team med alla andra agent-typer
- Team-agenter koordinerar sina specialområden för en heltäckande assistent
- Enskilda agenter fokuserar på sina specifika uppgifter

DIN PERSONLIGHET:
- Vänlig, entusiastisk och hjälpsam
- Förstår svenska perfekt
- Förklarar tekniska koncept på ett lättförståeligt sätt
- Ställer relevanta frågor för att förstå användarens behov
- Föreslår konkreta lösningar baserat på användarens beskrivning

KONVERSATIONSFLÖDE:
1. Lyssna på vad användaren vill att agenten ska göra
2. Föreslå lämplig agent-typ eller team-konfiguration
3. Hjälp till med anpassning av inställningar
4. Förklara hur agenten kommer att fungera
5. Guide genom skapande-processen

Svara alltid på svenska och håll konversationen naturlig och engagerande.`;

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { message, conversationHistory = [], agentType = null, context = null } = await req.json();

    if (!message) {
      throw new Error('No message provided');
    }

    // Prepare conversation messages
    const messages = [
      {
        role: 'system',
        content: agentCreationSystemPrompt
      }
    ];

    // Add conversation history
    if (conversationHistory && conversationHistory.length > 0) {
      conversationHistory.forEach((msg: any) => {
        if (msg.type === 'user') {
          messages.push({ role: 'user', content: msg.content });
        } else if (msg.type === 'assistant') {
          messages.push({ role: 'assistant', content: msg.content });
        }
      });
    }

    // Add current message
    messages.push({
      role: 'user',
      content: message
    });

    // Add context if provided
    if (context) {
      messages.push({
        role: 'system',
        content: `Aktuell kontext: ${JSON.stringify(context)}`
      });
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openAIApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4.1-2025-04-14',
        messages: messages,
        temperature: 0.7,
        max_tokens: 1000,
      }),
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${errorData}`);
    }

    const data = await response.json();
    const aiResponse = data.choices[0].message.content;

    return new Response(JSON.stringify({ 
      response: aiResponse,
      success: true 
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('Error in agent-creation-chat function:', error);
    return new Response(JSON.stringify({ 
      error: error.message,
      success: false 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});