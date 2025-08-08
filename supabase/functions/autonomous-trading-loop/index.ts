import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { botId, symbols = ['BTCUSDT'], interval = 60000 } = await req.json(); // Default 1 minute

    console.log('🔄 Starting autonomous trading loop for bot:', botId);

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Main trading cycle
    async function executeTradingCycle() {
      try {
        console.log('📊 Step 1: Fetching market data...');
        
        // 1. Fetch market data
        const dataResponse = await supabase.functions.invoke('data-fetch-service', {
          body: {
            symbols,
            timeframe: '1m',
            newsKeywords: ['bitcoin', 'crypto', 'btc']
          }
        });

        if (dataResponse.error) {
          throw new Error(`Data fetch failed: ${dataResponse.error}`);
        }

        const marketData = dataResponse.data.marketData?.successful?.[0];
        if (!marketData) {
          throw new Error('No market data available');
        }

        console.log('🤖 Step 2: Running AI analysis...');

        // 2. AI Market Analysis
        const analysisResponse = await supabase.functions.invoke('market-analysis-ai', {
          body: {
            botId,
            symbol: symbols[0],
            marketData,
            riskSettings: {
              riskLevel: 'medium',
              maxTradeAmount: 0.05,
              stopLoss: 0.02
            }
          }
        });

        if (analysisResponse.error) {
          throw new Error(`AI analysis failed: ${analysisResponse.error}`);
        }

        const aiAnalysis = analysisResponse.data.analysis;
        console.log('📈 AI Decision:', aiAnalysis.decision, 'Confidence:', aiAnalysis.confidence);

        // 3. Risk Analysis (only if AI suggests buy/sell)
        if (aiAnalysis.decision !== 'hold') {
          console.log('⚖️ Step 3: Running risk analysis...');

          const riskResponse = await supabase.functions.invoke('risk-analysis', {
            body: {
              botId,
              symbol: symbols[0],
              action: aiAnalysis.decision,
              quantity: aiAnalysis.suggestedQuantity || 50,
              price: marketData.price
            }
          });

          if (riskResponse.error) {
            throw new Error(`Risk analysis failed: ${riskResponse.error}`);
          }

          const riskAnalysis = riskResponse.data.riskAnalysis;
          console.log('🛡️ Risk approved:', riskAnalysis.approved, 'Score:', riskAnalysis.riskScore);

          // 4. Execute trade if approved (TESTNET only for now)
          if (riskAnalysis.approved && aiAnalysis.confidence >= 7) {
            console.log('✅ Executing trade...');
            
            // In production, this would call Binance API
            // For now, we just log the trade
            const trade = {
              symbol: symbols[0],
              side: aiAnalysis.decision.toUpperCase(),
              quantity: riskAnalysis.tradingParameters.recommendedQuantity,
              price: marketData.price,
              stopLoss: riskAnalysis.tradingParameters.stopLossPrice,
              takeProfit: riskAnalysis.tradingParameters.takeProfitPrice,
              timestamp: new Date().toISOString(),
              status: 'TESTNET_EXECUTED'
            };

            console.log('🎯 Trade executed (TESTNET):', trade);

            // Save trade to database
            const { error: dbError } = await supabase
              .from('trades')
              .insert([{
                bot_id: botId,
                symbol: trade.symbol,
                side: trade.side,
                quantity: trade.quantity,
                price: trade.price,
                stop_loss: trade.stopLoss,
                take_profit: trade.takeProfit,
                status: trade.status,
                confidence: aiAnalysis.confidence,
                risk_score: riskAnalysis.riskScore
              }]);

            if (dbError) {
              console.error('Failed to save trade:', dbError);
            }

            return {
              cycleComplete: true,
              action: 'trade_executed',
              trade,
              aiAnalysis,
              riskAnalysis
            };
          } else {
            console.log('❌ Trade rejected - Low confidence or high risk');
            return {
              cycleComplete: true,
              action: 'trade_rejected',
              reason: riskAnalysis.approved ? 'low_confidence' : 'high_risk',
              aiAnalysis,
              riskAnalysis
            };
          }
        } else {
          console.log('⏸️ AI recommends HOLD - No trade executed');
          return {
            cycleComplete: true,
            action: 'hold',
            aiAnalysis,
            marketData
          };
        }

      } catch (error) {
        console.error('❌ Trading cycle error:', error);
        return {
          cycleComplete: true,
          action: 'error',
          error: error.message
        };
      }
    }

    // Execute one trading cycle
    const result = await executeTradingCycle();

    console.log('🏁 Trading cycle completed:', result.action);

    return new Response(JSON.stringify({
      success: true,
      botId,
      timestamp: new Date().toISOString(),
      cycle: result
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in autonomous-trading-loop:', error);
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