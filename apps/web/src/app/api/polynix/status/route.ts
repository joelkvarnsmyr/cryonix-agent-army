import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parse } from '@iarna/toml';

export const dynamic = 'force-dynamic';

function getConfig(): { paperTrading: boolean; arbThreshold: number; minEdgePct: number; feeRate: number; maxBetSize: number; maxPositions: number } {
  try {
    const filePath = join(process.cwd(), '..', '..', 'polynix.toml');
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = parse(raw) as any;
    return {
      paperTrading: parsed.broker?.paper_trading ?? true,
      arbThreshold: parsed.strategy?.arb_threshold ?? 0.96,
      minEdgePct: parsed.strategy?.min_edge_pct ?? 2.0,
      feeRate: parsed.risk?.fee_rate ?? 0.0156,
      maxBetSize: parsed.capital?.max_bet_size_usd ?? 10,
      maxPositions: parsed.capital?.max_concurrent_positions ?? 5,
    };
  } catch {
    return { paperTrading: true, arbThreshold: 0.96, minEdgePct: 2.0, feeRate: 0.0156, maxBetSize: 10, maxPositions: 5 };
  }
}

export async function GET() {
  const config = getConfig();

  let agentStatus: string | null = null;
  let account: any = null;
  let risk: any = null;

  try {
    const [statusRaw, accountRaw, riskRaw] = await Promise.all([
      redis.get('polynix:status'),
      redis.get('polynix:account'),
      redis.get('polynix:risk'),
    ]);

    agentStatus = (statusRaw as string) ?? null;
    if (accountRaw) try { account = JSON.parse(accountRaw as string); } catch { /* ignore */ }
    if (riskRaw) try { risk = JSON.parse(riskRaw as string); } catch { /* ignore */ }
  } catch (error) {
    console.error('[polynix/status] Redis error:', error);
  }

  return NextResponse.json({
    status: agentStatus,
    agent: {
      running: agentStatus === 'running',
      paperTrading: config.paperTrading,
      lastPoll: new Date().toISOString(),
    },
    config: {
      arbThreshold: config.arbThreshold,
      minEdgePct: config.minEdgePct,
      feeRate: config.feeRate,
      maxBetSize: config.maxBetSize,
      maxPositions: config.maxPositions,
    },
    account,
    risk,
    timestamp: new Date().toISOString(),
  });
}
