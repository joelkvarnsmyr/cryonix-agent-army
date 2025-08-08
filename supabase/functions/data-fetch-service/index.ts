import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { symbols, timeframe = '1m', newsKeywords = [] } = await req.json();

    console.log('📊 Fetching market data for:', symbols);

    // 1. Fetch crypto prices from Binance API
    const pricePromises = symbols.map(async (symbol: string) => {
      try {
        const response = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`);
        const data = await response.json();
        
        return {
          symbol,
          price: parseFloat(data.lastPrice),
          change_percent_24h: parseFloat(data.priceChangePercent),
          volume_24h: parseFloat(data.volume),
          high_24h: parseFloat(data.highPrice),
          low_24h: parseFloat(data.lowPrice),
          timestamp: Date.now()
        };
      } catch (error) {
        console.error(`Error fetching ${symbol}:`, error);
        return { symbol, error: error.message };
      }
    });

    const marketData = await Promise.all(pricePromises);
    const successful = marketData.filter(data => !data.error);
    const failed = marketData.filter(data => data.error);

    // 2. Fetch recent news sentiment (simplified)
    let newsData = [];
    if (newsKeywords.length > 0) {
      try {
        // In a real implementation, you'd use a news API like NewsAPI or Alpha Vantage
        newsData = [
          {
            keyword: newsKeywords[0],
            sentiment: 'positive',
            score: 0.7,
            articles_count: 15,
            summary: 'General market sentiment appears bullish based on recent news'
          }
        ];
      } catch (error) {
        console.error('Error fetching news:', error);
      }
    }

    // 3. Get fear & greed index (simplified)
    let fearGreedIndex = 50; // Default neutral
    try {
      const fgResponse = await fetch('https://api.alternative.me/fng/');
      const fgData = await fgResponse.json();
      fearGreedIndex = parseInt(fgData.data[0].value);
    } catch (error) {
      console.error('Error fetching fear & greed index:', error);
    }

    const result = {
      success: true,
      timestamp: new Date().toISOString(),
      marketData: {
        successful,
        failed,
        totalSymbols: symbols.length,
        successRate: (successful.length / symbols.length) * 100
      },
      newsData,
      fearGreedIndex,
      timeframe
    };

    console.log('✅ Market data fetched successfully:', {
      symbols: successful.length,
      failed: failed.length,
      news: newsData.length,
      fearGreed: fearGreedIndex
    });

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in data-fetch-service:', error);
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