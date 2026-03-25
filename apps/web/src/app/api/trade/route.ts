import { NextRequest, NextResponse } from 'next/server';
import ccxt from 'ccxt';
import {
  checkRateLimit,
  rateLimitResponse,
  validateTradeParams,
  sanitizeError,
  addSecurityHeaders,
  logApiRequest,
} from '@/lib/api-security';

// Initialize Binance exchange
const isTestnet = process.env.BINANCE_TESTNET === 'true';
const exchange = new ccxt.binance({
  apiKey: process.env.BINANCE_API_KEY,
  secret: process.env.BINANCE_API_SECRET,
  enableRateLimit: true,
  sandbox: isTestnet,
});

// Set testnet URLs if using testnet
if (isTestnet) {
  exchange.setSandboxMode(true);
}

export async function POST(request: NextRequest) {
  // Rate limiting
  const rateLimit = checkRateLimit(request, 'trade');
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.resetIn);
  }

  try {
    const body = await request.json();
    const { symbol, side, type, amount, price, stopLoss, takeProfit } = body;

    // Validate parameters
    const validation = validateTradeParams({ symbol, side, amount, price });
    if (!validation.valid) {
      return NextResponse.json(
        { success: false, error: validation.error, code: 'INVALID_PARAMS' },
        { status: 400 }
      );
    }

    // Log the trade request
    logApiRequest(request, 'trade', 'CREATE_ORDER', {
      symbol,
      side,
      type: type || 'market',
      amount,
    });

    let order;
    const orderType = type?.toLowerCase() || 'market';

    if (orderType === 'market') {
      // Market order
      order = await exchange.createMarketOrder(
        symbol,
        side.toLowerCase(),
        amount
      );
    } else if (orderType === 'limit') {
      // Limit order
      if (!price) {
        return NextResponse.json(
          { success: false, error: 'Price required for limit orders' },
          { status: 400 }
        );
      }
      order = await exchange.createLimitOrder(
        symbol,
        side.toLowerCase(),
        amount,
        price
      );
    } else {
      return NextResponse.json(
        { success: false, error: 'Invalid order type. Use "market" or "limit"' },
        { status: 400 }
      );
    }

    // If stop loss is specified, create a stop loss order
    let stopLossOrder = null;
    if (stopLoss && order.status === 'closed') {
      try {
        const slSide = side.toLowerCase() === 'buy' ? 'sell' : 'buy';
        stopLossOrder = await exchange.createOrder(
          symbol,
          'STOP_LOSS_LIMIT',
          slSide,
          amount,
          stopLoss * 0.999, // Slightly below stop price
          { stopPrice: stopLoss }
        );
      } catch (slError: any) {
        console.error('Stop loss order failed:', slError.message);
      }
    }

    // If take profit is specified, create a take profit order
    let takeProfitOrder = null;
    if (takeProfit && order.status === 'closed') {
      try {
        const tpSide = side.toLowerCase() === 'buy' ? 'sell' : 'buy';
        takeProfitOrder = await exchange.createLimitOrder(
          symbol,
          tpSide,
          amount,
          takeProfit
        );
      } catch (tpError: any) {
        console.error('Take profit order failed:', tpError.message);
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        order: {
          id: order.id,
          symbol: order.symbol,
          side: order.side,
          type: order.type,
          amount: order.amount,
          price: order.price || order.average,
          status: order.status,
          filled: order.filled,
          cost: order.cost,
          timestamp: order.timestamp,
        },
        stopLossOrder: stopLossOrder ? {
          id: stopLossOrder.id,
          stopPrice: stopLoss,
        } : null,
        takeProfitOrder: takeProfitOrder ? {
          id: takeProfitOrder.id,
          targetPrice: takeProfit,
        } : null,
      },
    });
  } catch (error: unknown) {
    console.error('Trade API Error:', error);
    logApiRequest(request, 'trade', 'ERROR', { error: sanitizeError(error) });

    const response = NextResponse.json(
      { success: false, error: sanitizeError(error), code: 'EXCHANGE_ERROR' },
      { status: 500 }
    );
    return addSecurityHeaders(response);
  }
}

// GET - Fetch open orders
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get('symbol');

    if (!symbol) {
      return NextResponse.json(
        { success: false, error: 'Missing symbol query parameter' },
        { status: 400 }
      );
    }

    const openOrders = await exchange.fetchOpenOrders(symbol);

    return NextResponse.json({
      success: true,
      data: openOrders.map((order) => ({
        id: order.id,
        symbol: order.symbol,
        side: order.side,
        type: order.type,
        amount: order.amount,
        price: order.price,
        filled: order.filled,
        remaining: order.remaining,
        status: order.status,
        timestamp: order.timestamp,
      })),
    });
  } catch (error: any) {
    console.error('Open Orders API Error:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

// DELETE - Cancel order
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const orderId = searchParams.get('orderId');
    const symbol = searchParams.get('symbol');

    if (!orderId || !symbol) {
      return NextResponse.json(
        { success: false, error: 'Missing orderId or symbol' },
        { status: 400 }
      );
    }

    const result = await exchange.cancelOrder(orderId, symbol);

    return NextResponse.json({
      success: true,
      data: {
        id: result.id,
        status: 'cancelled',
      },
    });
  } catch (error: any) {
    console.error('Cancel Order API Error:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
