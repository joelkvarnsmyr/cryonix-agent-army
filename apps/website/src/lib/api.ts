import { mockSignals, mockStats } from './mock-data';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
const USE_MOCK = process.env.NEXT_PUBLIC_MOCK_DATA === 'true';

export interface ClosedSignal {
  symbol: string;
  pattern: string | null;
  entryPrice: number;
  exitPrice: number;
  pnlPercent: number;
  closeReason: string | null;
  holdingPeriodH: number;
  openedAt: string;
  closedAt: string;
}

export interface BuySignal {
  symbol: string;
  pattern: string | null;
  entryPrice: number;
  confidence: number;
  timestamp: string;
}

export interface SignalsResponse {
  closed: ClosedSignal[];
  buys: BuySignal[];
  generatedAt: string;
}

export interface PatternStat {
  name: string;
  trades: number;
  winRate: number;
}

export interface StatsResponse {
  totalTrades: number;
  winRate: number;
  avgHoldingTimeH: number;
  patterns: PatternStat[];
  generatedAt: string;
}

export async function fetchSignals(): Promise<SignalsResponse> {
  if (USE_MOCK) return mockSignals;
  
  const res = await fetch(`${API_URL}/api/public/signals`, {
    next: { revalidate: 60 },
  });
  if (!res.ok) throw new Error('Failed to fetch signals');
  return res.json();
}

export async function fetchStats(): Promise<StatsResponse> {
  if (USE_MOCK) return mockStats;

  const res = await fetch(`${API_URL}/api/public/stats`, {
    next: { revalidate: 300 },
  });
  if (!res.ok) throw new Error('Failed to fetch stats');
  return res.json();
}
