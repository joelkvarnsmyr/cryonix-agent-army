import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const openAIApiKey = Deno.env.get('OPENAI_API_KEY');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { description, agentType } = await req.json();

    if (!openAIApiKey) {
      throw new Error('OpenAI API key not configured');
    }

    const systemPrompt = `Du är en expert på att skapa AI-agent flöden. Användaren beskriver vad de vill att deras agent ska göra, och du genererar ett komplett flöde med nodes och connections.

Tillgängliga node-typer:
- trigger: Startar flödet (manual, webhook, schedule)
- gpt: GPT-5 AI processing
- binance: Kryptovaluta trading (buy, sell, get_price, get_balance)
- email: E-post (send, read, reply)
- condition: Logiska villkor
- webhook: HTTP requests till externa APIs

Svara ENDAST med valid JSON i detta format:
{
  "nodes": [
    {
      "id": "unique_id",
      "type": "node_type",
      "position": { "x": number, "y": number },
      "data": {
        "label": "Node Name",
        "configurable_properties": "values"
      }
    }
  ],
  "edges": [
    {
      "id": "edge_id",
      "source": "source_node_id", 
      "target": "target_node_id"
    }
  ]
}

Skapa ett logiskt flöde med bra positionering (x: 0-800, y: 0-600) och använd svenska labels.`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openAIApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4.1-2025-04-14',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Skapa ett agent-flöde för: ${description}` }
        ],
        max_tokens: 2000,
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.statusText}`);
    }

    const data = await response.json();
    const aiResponse = data.choices[0].message.content;

    // Parse the JSON response
    let flowData;
    try {
      // Extract JSON from response (in case there's extra text)
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        flowData = JSON.parse(jsonMatch[0]);
      } else {
        flowData = JSON.parse(aiResponse);
      }
    } catch (parseError) {
      console.error('JSON Parse Error:', parseError);
      throw new Error('Could not parse AI response as valid JSON');
    }

    return new Response(JSON.stringify({ 
      success: true, 
      flow: flowData,
      description: description 
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Error in generate-flow function:', error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: error.message 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});