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
    const { botId, symbol, marketData, riskSettings } = await req.json();

    if (!openAIApiKey) {
      throw new Error('OpenAI API key not configured');
    }

    console.log('🤖 Starting AI market analysis for:', symbol);

    // Construct detailed prompt for trading analysis
    const prompt = `Du är en expert krypto-trader och ska analysera marknadsdata för ${symbol}.

MARKNADSDATA:
- Pris: $${marketData.price}
- 24h förändring: ${marketData.change_percent_24h}%
- 24h volym: ${marketData.volume_24h}
- 24h hög: $${marketData.high_24h}
- 24h låg: $${marketData.low_24h}

RISKINSTÄLLNINGAR:
- Risknivå: ${riskSettings.riskLevel}
- Max trade-belopp: ${riskSettings.maxTradeAmount * 100}% av portfölj
- Stop loss: ${riskSettings.stopLoss * 100}%

Baserat på denna data, ge mig:
1. Din handelsbeslut (buy/sell/hold)
2. Föreslagen kvantitet i USDT (max ${riskSettings.maxTradeAmount * 1000} USDT)
3. Stop loss nivå
4. Take profit nivå
5. Konfidensgrad (1-10)
6. Resonemang för beslutet

Svara ENDAST med valid JSON i detta format:
{
  "decision": "buy|sell|hold",
  "suggestedQuantity": number,
  "stopLoss": number,
  "takeProfit": number,
  "confidence": number,
  "reasoning": "string",
  "technicalIndicators": {
    "trend": "bullish|bearish|neutral",
    "momentum": "strong|weak|neutral",
    "volatility": "high|medium|low"
  }
}`;

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
            content: 'Du är en professionell krypto-trader med 10+ års erfarenhet. Analysera alltid data noggrant och ge konservativa, riskmedvetna råd.'
          },
          { role: 'user', content: prompt }
        ],
        max_tokens: 1000,
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.statusText}`);
    }

    const aiData = await response.json();
    const aiResponse = aiData.choices[0].message.content;

    // Parse AI response
    let analysis;
    try {
      // Extract JSON from response
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        analysis = JSON.parse(jsonMatch[0]);
      } else {
        analysis = JSON.parse(aiResponse);
      }
    } catch (parseError) {
      console.error('JSON Parse Error:', parseError);
      // Fallback analysis
      analysis = {
        decision: 'hold',
        suggestedQuantity: 0,
        stopLoss: marketData.price * (1 - riskSettings.stopLoss),
        takeProfit: marketData.price * 1.02,
        confidence: 5,
        reasoning: 'AI analysis failed, defaulting to hold position',
        technicalIndicators: {
          trend: 'neutral',
          momentum: 'neutral',
          volatility: 'medium'
        }
      };
    }

    // Add metadata
    const result = {
      success: true,
      botId,
      symbol,
      timestamp: new Date().toISOString(),
      analysis,
      marketConditions: {
        price: marketData.price,
        volatility: Math.abs(marketData.change_percent_24h) > 5 ? 'high' : 'medium',
        volume: marketData.volume_24h > 1000000 ? 'high' : 'medium'
      }
    };

    console.log('✅ AI analysis completed:', {
      decision: analysis.decision,
      confidence: analysis.confidence,
      quantity: analysis.suggestedQuantity
    });

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in market-analysis-ai:', error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: error.message,
      timestamp: new Date().toISOString()
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});