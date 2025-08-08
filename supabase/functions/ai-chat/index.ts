import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const openAIApiKey = Deno.env.get('OPENAI_API_KEY');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { message, agent_type, context } = await req.json();

    if (!openAIApiKey) {
      throw new Error('OpenAI API key not configured');
    }

    // Get system prompt based on agent type
    const getSystemPrompt = (agentType: string) => {
      const prompts = {
        'cryonix-trader': 'Du är en expert på kryptovalutahandel. Analysera marknaden och ge konkreta råd om handelsmöjligheter. Fokusera på riskhantering.',
        'life-coach': 'Du är en personlig coach som hjälper människor nå sina mål och utvecklas. Ge uppmuntrande och praktiska råd.',
        'fitness-coach': 'Du är en personlig tränare som hjälper med träningsprogram och kosträd. Ge konkreta och genomförbara råd.',
        'mindfulness-guide': 'Du är en mindfulness-expert som hjälper med meditation och stresshantering. Ge lugna och genomtänkta råd.',
        'finance-advisor': 'Du är en finansiell rådgivare som hjälper med privatekonomi och investeringar. Ge ansvarsfulla råd.',
        'learning-assistant': 'Du är en lärare som hjälper med kunskapsinhämtning. Förklara komplexa ämnen på ett enkelt sätt.',
        'inbox-tamer': 'Du är en AI-assistent som hjälper med e-posthantering. Föreslå svar och organisering.',
        'health-monitor': 'Du är en hälsorådgivare som hjälper med hälsouppföljning. Ge ansvarsfulla hälsoråd.',
        'cal-genius': 'Du är en schemaläggningsexpert som hjälper optimera kalendrar och tidsplanering.',
        'default': 'Du är en hjälpsam AI-assistent.'
      };
      return prompts[agentType as keyof typeof prompts] || prompts.default;
    };

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openAIApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { 
            role: 'system', 
            content: getSystemPrompt(agent_type) + (context ? `\n\nKontext: ${context}` : '')
          },
          { role: 'user', content: message }
        ],
        max_tokens: 1000,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.statusText}`);
    }

    const data = await response.json();
    const aiResponse = data.choices[0].message.content;

    return new Response(JSON.stringify({ response: aiResponse }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Error in ai-chat function:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});