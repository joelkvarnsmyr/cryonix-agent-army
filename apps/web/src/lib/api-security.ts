import { NextRequest, NextResponse } from 'next/server';

// Rate limiting configuration
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMITS: Record<string, number> = {
  trade: 5,      // 5 trades per minute
  analyze: 10,   // 10 analyses per minute
  market: 60,    // 60 market requests per minute
  default: 30,   // 30 requests per minute for other endpoints
};

// In-memory rate limit store (use Redis in production)
const rateLimitStore = new Map<string, { count: number; resetTime: number }>();

/**
 * Get client identifier for rate limiting
 */
function getClientId(request: NextRequest): string {
  // Try to get real IP from various headers
  const forwardedFor = request.headers.get('x-forwarded-for');
  const realIp = request.headers.get('x-real-ip');
  const cfConnectingIp = request.headers.get('cf-connecting-ip');

  return cfConnectingIp || realIp || forwardedFor?.split(',')[0] || 'unknown';
}

/**
 * Check rate limit for a client
 */
export function checkRateLimit(
  request: NextRequest,
  endpoint: string
): { allowed: boolean; remaining: number; resetIn: number } {
  const clientId = getClientId(request);
  const key = `${clientId}:${endpoint}`;
  const limit = RATE_LIMITS[endpoint] || RATE_LIMITS.default;
  const now = Date.now();

  const entry = rateLimitStore.get(key);

  if (!entry || now > entry.resetTime) {
    // Reset window
    rateLimitStore.set(key, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true, remaining: limit - 1, resetIn: RATE_LIMIT_WINDOW_MS };
  }

  if (entry.count >= limit) {
    return {
      allowed: false,
      remaining: 0,
      resetIn: entry.resetTime - now
    };
  }

  entry.count++;
  return {
    allowed: true,
    remaining: limit - entry.count,
    resetIn: entry.resetTime - now
  };
}

/**
 * Rate limit response
 */
export function rateLimitResponse(resetIn: number): NextResponse {
  return NextResponse.json(
    {
      status: 'error',
      error: 'Too many requests. Please try again later.',
      code: 'RATE_LIMITED'
    },
    {
      status: 429,
      headers: {
        'Retry-After': Math.ceil(resetIn / 1000).toString(),
        'X-RateLimit-Remaining': '0',
      }
    }
  );
}

/**
 * Validate trading parameters
 */
export interface TradeValidation {
  valid: boolean;
  error?: string;
}

export function validateTradeParams(params: {
  symbol?: string;
  side?: string;
  amount?: number;
  price?: number;
}): TradeValidation {
  const { symbol, side, amount, price } = params;

  // Required fields
  if (!symbol || typeof symbol !== 'string') {
    return { valid: false, error: 'Symbol is required and must be a string' };
  }

  if (!side || !['buy', 'sell'].includes(side.toLowerCase())) {
    return { valid: false, error: 'Side must be "buy" or "sell"' };
  }

  if (amount === undefined || typeof amount !== 'number') {
    return { valid: false, error: 'Amount is required and must be a number' };
  }

  // Amount validation
  if (amount <= 0) {
    return { valid: false, error: 'Amount must be positive' };
  }

  if (amount > 1000000) {
    return { valid: false, error: 'Amount exceeds maximum allowed (1,000,000)' };
  }

  // Price validation (if provided)
  if (price !== undefined) {
    if (typeof price !== 'number' || price <= 0) {
      return { valid: false, error: 'Price must be a positive number' };
    }
  }

  // Symbol format validation (e.g., BTCUSDT)
  const symbolRegex = /^[A-Z0-9]{2,10}(\/[A-Z0-9]{2,10})?$/i;
  if (!symbolRegex.test(symbol)) {
    return { valid: false, error: 'Invalid symbol format' };
  }

  return { valid: true };
}

/**
 * Validate backtest parameters
 */
export function validateBacktestParams(params: {
  symbols?: string[];
  startDate?: string;
  endDate?: string;
  initialCapital?: number;
}): TradeValidation {
  const { symbols, startDate, endDate, initialCapital } = params;

  if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
    return { valid: false, error: 'At least one symbol is required' };
  }

  if (symbols.length > 10) {
    return { valid: false, error: 'Maximum 10 symbols allowed' };
  }

  if (!startDate || !endDate) {
    return { valid: false, error: 'Start and end dates are required' };
  }

  const start = new Date(startDate);
  const end = new Date(endDate);

  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return { valid: false, error: 'Invalid date format' };
  }

  if (start >= end) {
    return { valid: false, error: 'Start date must be before end date' };
  }

  // Maximum 1 year backtest
  const maxDays = 365;
  const daysDiff = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
  if (daysDiff > maxDays) {
    return { valid: false, error: `Maximum backtest period is ${maxDays} days` };
  }

  if (initialCapital !== undefined) {
    if (typeof initialCapital !== 'number' || initialCapital <= 0) {
      return { valid: false, error: 'Initial capital must be a positive number' };
    }
    if (initialCapital > 10000000) {
      return { valid: false, error: 'Initial capital exceeds maximum (10,000,000)' };
    }
  }

  return { valid: true };
}

/**
 * Sanitize error message for client
 */
export function sanitizeError(error: unknown): string {
  if (error instanceof Error) {
    // Remove sensitive information from error messages
    const message = error.message
      .replace(/api[-_]?key/gi, '[REDACTED]')
      .replace(/secret/gi, '[REDACTED]')
      .replace(/password/gi, '[REDACTED]')
      .replace(/token/gi, '[REDACTED]');

    // Truncate long messages
    return message.length > 200 ? message.substring(0, 200) + '...' : message;
  }

  return 'An unexpected error occurred';
}

/**
 * Add security headers to response
 */
export function addSecurityHeaders(response: NextResponse): NextResponse {
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-XSS-Protection', '1; mode=block');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return response;
}

/**
 * Log API request for audit
 */
export function logApiRequest(
  request: NextRequest,
  endpoint: string,
  action: string,
  details?: Record<string, unknown>
): void {
  const clientId = getClientId(request);
  const timestamp = new Date().toISOString();

  console.log(JSON.stringify({
    type: 'API_AUDIT',
    timestamp,
    clientId,
    endpoint,
    action,
    method: request.method,
    ...details,
  }));
}
