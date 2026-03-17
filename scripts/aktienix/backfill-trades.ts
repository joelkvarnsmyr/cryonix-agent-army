/**
 * Backfill aktienix_trades from Alpaca order history.
 * Run: npx tsx scripts/aktienix/backfill-trades.ts
 *
 * Fetches all filled orders from Alpaca and inserts them into Postgres
 * (skips duplicates via ON CONFLICT on order_id).
 */

import { Client } from 'pg';

const ALPACA_BASE = 'https://paper-api.alpaca.markets';
const API_KEY = process.env.ALPACA_PAPER_API_KEY || process.env.ALPACA_API_KEY || '';
const API_SECRET = process.env.ALPACA_PAPER_API_SECRET || process.env.ALPACA_API_SECRET || '';
const POSTGRES_URL = process.env.POSTGRES_URL || '';

if (!API_KEY || !API_SECRET) {
  console.error('Missing ALPACA_PAPER_API_KEY / ALPACA_PAPER_API_SECRET');
  process.exit(1);
}

if (!POSTGRES_URL) {
  console.error('Missing POSTGRES_URL');
  process.exit(1);
}

interface AlpacaOrder {
  id: string;
  symbol: string;
  side: string;
  qty: string;
  filled_qty: string;
  filled_avg_price: string;
  status: string;
  created_at: string;
  filled_at: string;
  type: string;
  notional: string | null;
}

async function fetchOrders(): Promise<AlpacaOrder[]> {
  const allOrders: AlpacaOrder[] = [];
  let after: string | undefined;

  while (true) {
    const params = new URLSearchParams({
      status: 'filled',
      limit: '500',
      direction: 'asc',
    });
    if (after) params.set('after', after);

    const res = await fetch(`${ALPACA_BASE}/v2/orders?${params}`, {
      headers: {
        'APCA-API-KEY-ID': API_KEY,
        'APCA-API-SECRET-KEY': API_SECRET,
      },
    });

    if (!res.ok) {
      console.error(`Alpaca API error: ${res.status} ${await res.text()}`);
      break;
    }

    const orders: AlpacaOrder[] = await res.json();
    if (orders.length === 0) break;

    allOrders.push(...orders);
    after = orders[orders.length - 1].id;
    console.log(`Fetched ${allOrders.length} orders so far...`);

    if (orders.length < 500) break;
  }

  return allOrders;
}

async function main() {
  console.log('Fetching filled orders from Alpaca...');
  const orders = await fetchOrders();
  console.log(`Total filled orders: ${orders.length}`);

  if (orders.length === 0) {
    console.log('No orders to backfill.');
    return;
  }

  const pg = new Client({ connectionString: POSTGRES_URL });
  await pg.connect();

  // Ensure order_id unique constraint exists
  await pg.query(`
    DO $$ BEGIN
      ALTER TABLE aktienix_trades ADD CONSTRAINT aktienix_trades_order_id_unique UNIQUE (order_id);
    EXCEPTION
      WHEN duplicate_table THEN NULL;
      WHEN duplicate_object THEN NULL;
    END $$;
  `);

  let inserted = 0;
  let skipped = 0;

  for (const order of orders) {
    const qty = parseFloat(order.filled_qty || order.qty);
    const price = parseFloat(order.filled_avg_price);
    const dollarAmount = qty * price;

    try {
      const result = await pg.query(
        `INSERT INTO aktienix_trades
         (timestamp, symbol, side, qty, fill_price, dollar_amount, realized_pnl,
          confidence, reasoning, exit_reason, broker, paper_trading, is_day_trade, order_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL, $7, NULL, 'alpaca', true, false, $8, NULL)
         ON CONFLICT (order_id) DO NOTHING`,
        [
          order.filled_at || order.created_at,
          order.symbol,
          order.side.toUpperCase(),
          qty,
          price,
          dollarAmount,
          `Backfilled from Alpaca (type: ${order.type})`,
          order.id,
        ],
      );

      if (result.rowCount && result.rowCount > 0) {
        inserted++;
      } else {
        skipped++;
      }
    } catch (err: any) {
      console.warn(`Failed to insert order ${order.id}: ${err.message}`);
    }
  }

  console.log(`\nBackfill complete: ${inserted} inserted, ${skipped} skipped (duplicates)`);

  // Also sync current positions to aktienix_positions
  console.log('\nSyncing current positions from Alpaca...');
  const posRes = await fetch(`${ALPACA_BASE}/v2/positions`, {
    headers: {
      'APCA-API-KEY-ID': API_KEY,
      'APCA-API-SECRET-KEY': API_SECRET,
    },
  });

  if (posRes.ok) {
    const positions: any[] = await posRes.json();

    // Clear old positions
    await pg.query(`DELETE FROM aktienix_positions`);

    for (const pos of positions) {
      await pg.query(
        `INSERT INTO aktienix_positions
         (symbol, qty, avg_entry_price, current_price, market_value, unrealized_pl, opened_at, status, broker, paper_trading)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), 'OPEN', 'alpaca', true)`,
        [
          pos.symbol,
          parseFloat(pos.qty),
          parseFloat(pos.avg_entry_price),
          parseFloat(pos.current_price),
          parseFloat(pos.market_value),
          parseFloat(pos.unrealized_pl),
        ],
      );
    }
    console.log(`Synced ${positions.length} open positions to Postgres`);
  }

  // Also write positions to Redis for dashboard
  try {
    const Redis = (await import('ioredis')).default;
    const redis = new Redis(process.env.KV_URL || 'redis://localhost:6379');

    if (posRes.ok) {
      const positions: any[] = await (await fetch(`${ALPACA_BASE}/v2/positions`, {
        headers: { 'APCA-API-KEY-ID': API_KEY, 'APCA-API-SECRET-KEY': API_SECRET },
      })).json();

      const mapped = positions.map(p => ({
        symbol: p.symbol,
        qty: parseFloat(p.qty),
        avgEntryPrice: parseFloat(p.avg_entry_price),
        currentPrice: parseFloat(p.current_price),
        marketValue: parseFloat(p.market_value),
        unrealizedPl: parseFloat(p.unrealized_pl),
        unrealizedPlPct: parseFloat(p.unrealized_plpc) * 100,
        openedAt: new Date().toISOString(),
      }));

      await redis.set('aktienix:positions', JSON.stringify(mapped), 'EX', 3600);
      console.log(`Written ${mapped.length} positions to Redis (aktienix:positions)`);
    }

    await redis.quit();
  } catch (err: any) {
    console.warn('Redis sync failed (non-critical):', err.message);
  }

  await pg.end();
}

main().catch(console.error);
