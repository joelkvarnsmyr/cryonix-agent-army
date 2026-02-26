import { SignalsResponse, StatsResponse, ClosedSignal, BuySignal } from './api';

const MOCK_CLOSED_SIGNALS: ClosedSignal[] = [
  {
    symbol: 'INJ/USDT',
    pattern: 'DIP_BUY + DEEP_VALUE_CRASH',
    entryPrice: 32.45,
    exitPrice: 33.85,
    pnlPercent: 4.31,
    closeReason: 'Trailing Stop',
    holdingPeriodH: 14,
    openedAt: new Date(Date.now() - 86400000 * 2).toISOString(),
    closedAt: new Date(Date.now() - 86400000 * 1.5).toISOString(),
  },
  {
    symbol: 'DOT/USDT',
    pattern: 'DIP_BUY',
    entryPrice: 7.12,
    exitPrice: 7.34,
    pnlPercent: 3.09,
    closeReason: 'Trailing Stop',
    holdingPeriodH: 8,
    openedAt: new Date(Date.now() - 86400000 * 3).toISOString(),
    closedAt: new Date(Date.now() - 86400000 * 2.7).toISOString(),
  },
  {
    symbol: 'SUI/USDT',
    pattern: 'DEEP_VALUE_CRASH',
    entryPrice: 1.85,
    exitPrice: 1.91,
    pnlPercent: 2.94,
    closeReason: 'Take Profit',
    holdingPeriodH: 5,
    openedAt: new Date(Date.now() - 86400000 * 4).toISOString(),
    closedAt: new Date(Date.now() - 86400000 * 3.8).toISOString(),
  },
  {
    symbol: 'ADA/USDT',
    pattern: 'BOLLINGER_SQUEEZE',
    entryPrice: 0.58,
    exitPrice: 0.60,
    pnlPercent: 2.71,
    closeReason: 'Trailing Stop',
    holdingPeriodH: 22,
    openedAt: new Date(Date.now() - 86400000 * 5).toISOString(),
    closedAt: new Date(Date.now() - 86400000 * 4.1).toISOString(),
  },
  {
    symbol: 'RENDER/USDT',
    pattern: 'DIP_BUY',
    entryPrice: 6.42,
    exitPrice: 6.55,
    pnlPercent: 1.95,
    closeReason: 'Trailing Stop',
    holdingPeriodH: 12,
    openedAt: new Date(Date.now() - 86400000 * 6).toISOString(),
    closedAt: new Date(Date.now() - 86400000 * 5.5).toISOString(),
  }
];

const MOCK_BUY_SIGNALS: BuySignal[] = [
  {
    symbol: 'SOL/USDT',
    pattern: 'DIP_BUY',
    entryPrice: 145.20,
    confidence: 0.84,
    timestamp: new Date(Date.now() - 3600000 * 2).toISOString(),
  },
  {
    symbol: 'LINK/USDT',
    pattern: 'BOLLINGER_SQUEEZE',
    entryPrice: 18.45,
    confidence: 0.78,
    timestamp: new Date(Date.now() - 3600000 * 5).toISOString(),
  },
  {
    symbol: 'AVAX/USDT',
    pattern: 'DEEP_VALUE_CRASH',
    entryPrice: 35.12,
    confidence: 0.91,
    timestamp: new Date(Date.now() - 3600000 * 8).toISOString(),
  }
];

export const mockSignals: SignalsResponse = {
  closed: MOCK_CLOSED_SIGNALS,
  buys: MOCK_BUY_SIGNALS,
  generatedAt: new Date().toISOString(),
};

export const mockStats: StatsResponse = {
  totalTrades: 26,
  winRate: 73.1,
  avgHoldingTimeH: 12.4,
  patterns: [
    { name: 'DIP_BUY', trades: 14, winRate: 78.5 },
    { name: 'DEEP_VALUE_CRASH', trades: 8, winRate: 87.5 },
    { name: 'BOLLINGER_SQUEEZE', trades: 4, winRate: 50.0 }
  ],
  generatedAt: new Date().toISOString(),
};
