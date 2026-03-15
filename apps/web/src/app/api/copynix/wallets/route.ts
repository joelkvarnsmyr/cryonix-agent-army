import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parse } from '@iarna/toml';

export const dynamic = 'force-dynamic';

interface WalletInfo {
  address: string;
  label: string;
}

function loadWalletsFromConfig(): WalletInfo[] {
  const paths = [
    '/app/copynix.toml',
    join(process.cwd(), 'copynix.toml'),
    join(process.cwd(), '../../copynix.toml'),
  ];
  for (const filePath of paths) {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = parse(raw) as any;
    const tracked: string[] = parsed.wallets?.tracked ?? [];

    // Extract labels from TOML comments (lines starting with #)
    const lines = raw.split('\n');
    const labels: string[] = [];
    let inWalletsSection = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '[wallets]') {
        inWalletsSection = true;
        continue;
      }
      if (trimmed.startsWith('[') && trimmed !== '[wallets]') {
        inWalletsSection = false;
        continue;
      }
      if (inWalletsSection && trimmed.startsWith('# #')) {
        // Format: # #1 gambles.sol: 68.2% WR, ...
        const match = trimmed.match(/^# #\d+\s+(.+?):/);
        if (match) labels.push(match[1]);
      }
    }

    return tracked.map((address, i) => ({
      address,
      label: labels[i] ?? `Wallet ${i + 1}`,
    }));
  } catch {
    continue;
  }
  }
  return [];
}

interface WalletStats {
  [address: string]: {
    winRate?: number;
    pnl?: number;
    roi?: number;
    tradeCount?: number;
    lastActive?: string;
  };
}

export async function GET() {
  const wallets = loadWalletsFromConfig();

  let walletStats: WalletStats = {};

  try {
    const raw = await redis.get('copynix:wallet_stats');
    if (raw) {
      walletStats = JSON.parse(raw as string);
    }
  } catch (error) {
    console.error('[copynix/wallets] Redis error:', error);
  }

  const enriched = wallets.map(w => {
    const stats = walletStats[w.address] ?? null;
    return {
      ...w,
      winRate: stats?.winRate ?? null,
      pnl: stats?.pnl ?? null,
      lastActive: stats?.lastActive ?? null,
    };
  });

  return NextResponse.json({
    wallets: enriched,
    count: enriched.length,
    timestamp: new Date().toISOString(),
  });
}
