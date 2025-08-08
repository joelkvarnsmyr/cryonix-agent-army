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
    const { botId, symbol, action, quantity, price } = await req.json();

    console.log('🛡️ Starting risk analysis for:', { symbol, action, quantity, price });

    // Get current portfolio state (simplified - in real app, fetch from DB)
    const currentBalance = 1000; // USDT
    const maxRiskPerTrade = 0.05; // 5% of portfolio
    const maxPositionSize = 0.2; // 20% of portfolio in single asset

    // Calculate risk metrics
    const tradeValue = quantity * price;
    const riskPercentage = tradeValue / currentBalance;
    const potentialLoss = tradeValue * 0.02; // Assuming 2% stop loss

    // Risk assessment rules
    const riskChecks = {
      positionSize: {
        check: riskPercentage <= maxRiskPerTrade,
        current: riskPercentage,
        limit: maxRiskPerTrade,
        severity: riskPercentage > maxRiskPerTrade ? 'high' : 'low'
      },
      balanceCheck: {
        check: tradeValue <= currentBalance * 0.9, // Keep 10% cash
        current: tradeValue,
        available: currentBalance * 0.9,
        severity: tradeValue > currentBalance * 0.9 ? 'high' : 'low'
      },
      volatilityRisk: {
        check: Math.abs(potentialLoss / currentBalance) <= 0.02, // Max 2% portfolio risk
        current: potentialLoss / currentBalance,
        limit: 0.02,
        severity: Math.abs(potentialLoss / currentBalance) > 0.02 ? 'medium' : 'low'
      }
    };

    // Calculate overall risk score (1-10, where 10 is highest risk)
    let riskScore = 1;
    if (!riskChecks.positionSize.check) riskScore += 3;
    if (!riskChecks.balanceCheck.check) riskScore += 4;
    if (!riskChecks.volatilityRisk.check) riskScore += 2;

    // Determine if trade should be approved
    const approved = Object.values(riskChecks).every(check => check.check);
    
    // Generate recommendations
    const recommendations = [];
    if (!riskChecks.positionSize.check) {
      const adjustedQuantity = Math.floor((currentBalance * maxRiskPerTrade) / price);
      recommendations.push({
        type: 'position_adjustment',
        message: `Reduce quantity to ${adjustedQuantity} to stay within risk limits`,
        adjustedQuantity
      });
    }

    if (!riskChecks.balanceCheck.check) {
      recommendations.push({
        type: 'insufficient_balance',
        message: 'Insufficient balance for this trade size',
        requiredBalance: tradeValue
      });
    }

    if (!riskChecks.volatilityRisk.check) {
      recommendations.push({
        type: 'high_volatility',
        message: 'Consider reducing position size due to high volatility',
        suggestedReduction: 0.5
      });
    }

    // Calculate suggested stop loss and take profit
    const stopLossPrice = action === 'buy' ? price * 0.98 : price * 1.02;
    const takeProfitPrice = action === 'buy' ? price * 1.05 : price * 0.95;

    const result = {
      success: true,
      botId,
      symbol,
      timestamp: new Date().toISOString(),
      riskAnalysis: {
        approved,
        riskScore,
        tradeValue,
        riskPercentage: riskPercentage * 100,
        potentialLoss,
        checks: riskChecks,
        recommendations
      },
      tradingParameters: {
        maxQuantity: Math.floor((currentBalance * maxRiskPerTrade) / price),
        stopLossPrice,
        takeProfitPrice,
        recommendedQuantity: approved ? quantity : Math.floor((currentBalance * maxRiskPerTrade) / price)
      },
      portfolioStatus: {
        currentBalance,
        availableBalance: currentBalance * 0.9,
        riskBudget: currentBalance * maxRiskPerTrade,
        utilizationPercentage: (tradeValue / currentBalance) * 100
      }
    };

    console.log('✅ Risk analysis completed:', {
      approved,
      riskScore,
      recommendations: recommendations.length
    });

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in risk-analysis:', error);
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