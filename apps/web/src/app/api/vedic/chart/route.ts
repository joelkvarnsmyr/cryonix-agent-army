import { NextResponse } from "next/server";
import ccxt from "ccxt";

export const dynamic = "force-dynamic";

/**
 * GET /api/vedic/chart?symbol=BTC&days=365
 *
 * Merges historical vedic scores (from engine) with OHLCV prices (from CCXT).
 * Returns aligned daily data points for the overlay chart.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const symbol = (searchParams.get("symbol") ?? "BTC").toUpperCase();
  const days = Math.min(Number(searchParams.get("days") ?? 365), 730);

  try {
    // Fetch vedic historical data from engine
    const engineUrl = process.env.ENGINE_URL ?? "http://localhost:8000";
    const vedicRes = await fetch(
      `${engineUrl}/vedic/historical?symbol=${symbol}&days=${days}&interval=daily`,
      { signal: AbortSignal.timeout(120_000) }
    );

    if (!vedicRes.ok) {
      return NextResponse.json(
        { error: `Engine error: ${vedicRes.status}` },
        { status: 502 }
      );
    }

    const vedicData = await vedicRes.json();

    // Fetch OHLCV prices from CCXT (daily candles)
    const exchange = new ccxt.binance({ enableRateLimit: true });
    const pair = `${symbol}/USDC`;
    const since = Date.now() - days * 86400_000;

    // CCXT OHLCV type is not number[][] so we use any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allCandles: any[] = [];
    let cursor = since;
    while (cursor < Date.now()) {
      const batch = await exchange.fetchOHLCV(pair, "1d", cursor, 1000);
      if (!batch.length) break;
      allCandles.push(...batch);
      cursor = Number(batch[batch.length - 1][0]) + 86400_000;
      if (batch.length < 1000) break;
    }

    // Build price lookup by date string
    const priceByDate: Record<string, { open: number; high: number; low: number; close: number; volume: number }> = {};
    for (const c of allCandles) {
      const d = new Date(Number(c[0])).toISOString().slice(0, 10);
      priceByDate[d] = {
        open: Number(c[1]),
        high: Number(c[2]),
        low: Number(c[3]),
        close: Number(c[4]),
        volume: Number(c[5]),
      };
    }

    // Merge: vedic data + price data aligned by date
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const merged = vedicData.data.map((v: any) => {
      const price = priceByDate[v.date as string];
      return {
        ...v,
        price: price?.close ?? null,
        open: price?.open ?? null,
        high: price?.high ?? null,
        low: price?.low ?? null,
        volume: price?.volume ?? null,
      };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }).filter((p: any) => p.price !== null);

    return NextResponse.json({
      symbol,
      days,
      points: merged.length,
      data: merged,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
