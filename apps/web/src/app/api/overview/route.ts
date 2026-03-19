import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

interface InstanceData {
  id: string;
  label: string;
  accent: string;
  status: 'online' | 'offline' | 'degraded';
  portfolioValue: number;
  dailyPnl: number;
  dailyPnlPct: number;
  totalPnl: number;
  winRate: number;
  totalTrades: number;
  openPositions: number;
  maxPositions: number;
  recentTrades: Array<{
    symbol: string;
    side: string;
    pnl: number;
    timestamp: string;
  }>;
  equityCurve: Array<{ date: string; value: number }>;
}

interface OverviewPayload {
  timestamp: string;
  totalPortfolioValue: number;
  totalDailyPnl: number;
  blendedWinRate: number;
  instancesOnline: number;
  instancesTotal: number;
  instances: InstanceData[];
}

const BASE_URL = process.env.NEXTJS_API_URL || 'http://localhost:3000';

async function safeFetch(url: string, timeoutMs = 5000): Promise<any> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchCryonix(): Promise<InstanceData> {
  const [portfolio, autoTrade, journal] = await Promise.all([
    safeFetch(`${BASE_URL}/api/portfolio`),
    safeFetch(`${BASE_URL}/api/auto-trade`),
    safeFetch(`${BASE_URL}/api/analytics/journal?days=30`),
  ]);

  const positions = autoTrade?.positions ?? [];
  const summary = journal?.summary ?? {};
  const equityData = journal?.journal?.map((t: any) => ({
    date: t.closedAt?.split('T')[0] ?? '',
    value: t.cumulativePnl ?? 0,
  })) ?? [];

  return {
    id: 'cryonix',
    label: 'CRYONIX',
    accent: 'cyan',
    status: portfolio ? 'online' : 'offline',
    portfolioValue: portfolio?.totalValue ?? 0,
    dailyPnl: autoTrade?.dailyState?.dailyPnl ?? 0,
    dailyPnlPct: autoTrade?.dailyState?.dailyPnlPct ?? 0,
    totalPnl: summary.totalPnl ?? 0,
    winRate: summary.winRate ?? 0,
    totalTrades: summary.totalTrades ?? 0,
    openPositions: positions.length,
    maxPositions: 3,
    recentTrades: (journal?.journal ?? []).slice(0, 5).map((t: any) => ({
      symbol: t.symbol,
      side: t.side ?? 'BUY',
      pnl: t.pnl ?? 0,
      timestamp: t.closedAt ?? t.openedAt ?? '',
    })),
    equityCurve: equityData,
  };
}

async function fetchVedic(): Promise<InstanceData> {
  const [status, trades] = await Promise.all([
    safeFetch(`${BASE_URL}/api/vedic/status`),
    safeFetch(`${BASE_URL}/api/vedic/trades`),
  ]);

  // Response shape: { scout, moon, planets, trader, btd, futures, bayes, timestamp }
  const trader = status?.trader ?? {};
  const btd = status?.btd ?? {};
  const futures = status?.futures ?? {};
  const totalBalance = (trader.balance ?? 0) + (btd.balance ?? 0) + (futures.balance ?? 0);
  const totalPnl = (trader.totalPnl ?? 0) + (btd.totalPnl ?? 0) + (futures.totalPnl ?? 0);
  const totalTrades = (trader.trades ?? 0) + (btd.trades ?? 0) + (futures.trades ?? 0);
  const totalWins = (trader.wins ?? 0) + (btd.wins ?? 0) + (futures.wins ?? 0);
  const openPositions = (trader.openPositions ?? 0) + (btd.openPositions ?? 0) + (futures.openPositions ?? 0);

  return {
    id: 'vedic',
    label: 'VEDIC',
    accent: 'purple',
    status: status?.scout?.running ? 'online' : 'offline',
    portfolioValue: totalBalance,
    dailyPnl: 0,
    dailyPnlPct: 0,
    totalPnl,
    winRate: totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0,
    totalTrades,
    openPositions,
    maxPositions: 10,
    recentTrades: (trades?.trades ?? []).slice(0, 5).map((t: any) => ({
      symbol: t.base_asset ?? t.symbol ?? '',
      side: t.action ?? 'BUY',
      pnl: t.pnl ?? 0,
      timestamp: t.timestamp ?? '',
    })),
    equityCurve: [],
  };
}

async function fetchAktienix(): Promise<InstanceData> {
  const [portfolio, trades] = await Promise.all([
    safeFetch(`${BASE_URL}/api/aktienix/portfolio`),
    safeFetch(`${BASE_URL}/api/aktienix/trades?limit=20`),
  ]);

  // Portfolio response: { portfolioValue, buyingPower, settledCash, dailyPnl, dailyPnlPct }
  // Trades summary: { total, winRate (0-1 ratio), totalPnl }
  const summary = trades?.summary ?? {};

  return {
    id: 'aktienix',
    label: 'AKTIENIX',
    accent: 'violet',
    status: portfolio ? 'online' : 'offline',
    portfolioValue: portfolio?.portfolioValue ?? 0,
    dailyPnl: portfolio?.dailyPnl ?? 0,
    dailyPnlPct: portfolio?.dailyPnlPct ?? 0,
    totalPnl: summary.totalPnl ?? 0,
    winRate: (summary.winRate ?? 0) * 100, // API returns 0-1 ratio, normalize to 0-100
    totalTrades: summary.total ?? 0,
    openPositions: 0, // portfolio route does not include positions count
    maxPositions: 5,
    recentTrades: (trades?.trades ?? []).slice(0, 5).map((t: any) => ({
      symbol: t.symbol ?? '',
      side: t.side ?? 'BUY',
      pnl: t.realizedPnl ?? 0,
      timestamp: t.timestamp ?? '',
    })),
    equityCurve: [],
  };
}

async function fetchSolanix(): Promise<InstanceData> {
  const [data, positions] = await Promise.all([
    safeFetch(`${BASE_URL}/api/solanix/status`),
    safeFetch(`${BASE_URL}/api/solanix/positions`),
  ]);

  // Response: { status: string|null, account: object|null, risk, shadows, timestamp }
  const account = data?.account ?? {};

  return {
    id: 'solanix',
    label: 'SOLANIX',
    accent: 'amber',
    status: data?.status === 'running' ? 'online' : 'offline',
    portfolioValue: account.portfolioValue ?? account.portfolio_value ?? 0,
    dailyPnl: account.dailyPnl ?? account.daily_pnl ?? 0,
    dailyPnlPct: account.dailyPnlPct ?? 0,
    totalPnl: account.totalPnl ?? account.total_pnl ?? 0,
    winRate: account.winRate ?? 0,
    totalTrades: account.totalTrades ?? 0,
    openPositions: (positions?.positions ?? []).length,
    maxPositions: 5,
    recentTrades: [],
    equityCurve: [],
  };
}

async function fetchPolynix(): Promise<InstanceData> {
  const [data, trades] = await Promise.all([
    safeFetch(`${BASE_URL}/api/polynix/status`),
    safeFetch(`${BASE_URL}/api/polynix/trades`),
  ]);

  // Response: { status, agent: { running, paperTrading }, account, risk, lastSignal, timestamp }
  const account = data?.account ?? {};

  return {
    id: 'polynix',
    label: 'POLYNIX',
    accent: 'orange',
    status: data?.agent?.running ? 'online' : 'offline',
    portfolioValue: account.balance ?? 0,
    dailyPnl: data?.risk?.daily_pnl ?? data?.risk?.dailyPnl ?? 0,
    dailyPnlPct: 0,
    totalPnl: account.total_pnl ?? account.totalPnl ?? 0,
    winRate: account.winRate ?? 0,
    totalTrades: account.trades ?? 0,
    openPositions: account.openBets ?? 0,
    maxPositions: 10,
    recentTrades: (trades?.trades ?? []).slice(0, 5).map((t: any) => ({
      symbol: t.asset ?? t.market_title ?? '',
      side: t.side ?? 'YES',
      pnl: t.realized_pnl ?? t.realizedPnl ?? 0,
      timestamp: t.settled_at ?? '',
    })),
    equityCurve: [],
  };
}

async function fetchCopynix(): Promise<InstanceData> {
  const [data, trades] = await Promise.all([
    safeFetch(`${BASE_URL}/api/copynix/status`),
    safeFetch(`${BASE_URL}/api/copynix/trades?limit=20`),
  ]);

  // Response: { status, paperTrading, trackedWallets, portfolioValue (top-level!),
  //             totalPositions, tradesToday, account, risk, timestamp }
  const summary = trades?.summary ?? {};

  return {
    id: 'copynix',
    label: 'COPYNIX',
    accent: 'cyan',
    status: data?.status === 'running' ? 'online' : 'offline',
    portfolioValue: data?.portfolioValue ?? 0, // top-level field, not inside account
    dailyPnl: data?.risk?.dailyPnlDollar ?? 0,
    dailyPnlPct: 0,
    totalPnl: summary.totalPnl ?? 0,
    winRate: summary.winRate ?? 0,
    totalTrades: summary.totalTrades ?? 0,
    openPositions: data?.totalPositions ?? 0,
    maxPositions: 5,
    recentTrades: (trades?.trades ?? []).slice(0, 5).map((t: any) => ({
      symbol: t.symbol ?? '',
      side: t.side ?? 'BUY',
      pnl: t.realized_pnl ?? t.realizedPnl ?? 0,
      timestamp: t.timestamp ?? '',
    })),
    equityCurve: trades?.equityCurve ?? [],
  };
}

async function fetchPsinix(): Promise<InstanceData> {
  const [data, trades] = await Promise.all([
    safeFetch(`${BASE_URL}/api/psinix/status`),
    safeFetch(`${BASE_URL}/api/psinix/trades?limit=20`),
  ]);

  // Response: raw Redis 'psinix:state' pass-through, or { status: 'offline' }
  const isOnline = data && data.status !== 'offline';
  const summary = trades?.summary ?? {};

  return {
    id: 'psinix',
    label: 'ΨNIX',
    accent: 'violet',
    status: isOnline ? 'online' : 'offline',
    portfolioValue: data?.portfolioValue ?? data?.portfolio_value ?? 0,
    dailyPnl: 0,
    dailyPnlPct: 0,
    totalPnl: data?.total_pnl ?? data?.totalPnl ?? summary.totalPnl ?? 0,
    winRate: data?.winRate != null ? data.winRate : (summary.winRate ?? 0),
    totalTrades: (data?.wins ?? 0) + (data?.losses ?? 0) || (summary.total ?? 0),
    openPositions: data?.positions ?? 0,
    maxPositions: 3,
    recentTrades: (trades?.trades ?? []).slice(0, 5).map((t: any) => ({
      symbol: t.symbol ?? '',
      side: t.side ?? 'BUY',
      pnl: t.realized_pnl ?? t.realizedPnl ?? 0,
      timestamp: t.timestamp ?? '',
    })),
    equityCurve: [],
  };
}

export async function GET() {
  const instances = await Promise.all([
    fetchCryonix(),
    fetchVedic(),
    fetchAktienix(),
    fetchSolanix(),
    fetchPolynix(),
    fetchCopynix(),
    fetchPsinix(),
  ]);

  const totalPortfolioValue = instances.reduce((sum, i) => sum + i.portfolioValue, 0);
  const totalDailyPnl = instances.reduce((sum, i) => sum + i.dailyPnl, 0);
  const totalTrades = instances.reduce((sum, i) => sum + i.totalTrades, 0);
  const weightedWinRate = totalTrades > 0
    ? instances.reduce((sum, i) => sum + i.winRate * i.totalTrades, 0) / totalTrades
    : 0;
  const instancesOnline = instances.filter(i => i.status === 'online').length;

  const payload: OverviewPayload = {
    timestamp: new Date().toISOString(),
    totalPortfolioValue,
    totalDailyPnl,
    blendedWinRate: weightedWinRate,
    instancesOnline,
    instancesTotal: instances.length,
    instances,
  };

  return NextResponse.json(payload);
}
