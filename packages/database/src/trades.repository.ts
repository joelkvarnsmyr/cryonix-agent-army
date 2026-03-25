import { db } from './index';
import { trades, type Trade, type NewTrade } from './schema';
import { desc, eq, and, gte, lte, sql } from 'drizzle-orm';

/**
 * Trades Repository
 * Handles all database operations for trade execution and history
 */

// ============================================================================
// TYPES
// ============================================================================

export interface TradeExecution {
    symbol: string;
    side: string;
    quantity: string;
    entryPrice?: string;
    exitPrice?: string;
    pnl?: string;
    fees?: string;
    confidence?: string;
    pattern?: string;
    reasoning?: string;
    status?: string;
    agentId?: string;
    userId?: number;
    configVersion?: string;
}

export interface TradeFilters {
    symbol?: string;
    side?: string;
    status?: string;
    pattern?: string;
    agentId?: string;
    userId?: number;
    since?: Date;
    until?: Date;
    limit?: number;
}

export interface TradeStats {
    totalTrades: number;
    buyTrades: number;
    sellTrades: number;
    filledTrades: number;
    pendingTrades: number;
    closedTrades: number;
    totalPnl: number;
    avgPnl: number;
    winRate: number;
    avgConfidence: number;
    bySymbol: Record<string, { count: number; pnl: number }>;
    byPattern: Record<string, { count: number; pnl: number; winRate: number }>;
}

// ============================================================================
// TRADE OPERATIONS
// ============================================================================

/**
 * Log a new trade execution
 */
export async function logTrade(trade: TradeExecution): Promise<Trade> {
    const [insertedTrade] = await db
        .insert(trades)
        .values({
            timestamp: new Date(),
            symbol: trade.symbol,
            side: trade.side,
            quantity: trade.quantity,
            entryPrice: trade.entryPrice,
            exitPrice: trade.exitPrice,
            pnl: trade.pnl,
            fees: trade.fees,
            confidence: trade.confidence,
            pattern: trade.pattern,
            reasoning: trade.reasoning,
            status: trade.status || 'PENDING',
            agentId: trade.agentId,
            userId: trade.userId,
            configVersion: trade.configVersion,
        })
        .returning();

    return insertedTrade;
}

/**
 * Get trade history with optional filters
 */
export async function getTradeHistory(filters?: TradeFilters): Promise<Trade[]> {
    let query = db.select().from(trades);

    // Apply filters
    const conditions = [];
    if (filters?.symbol) {
        conditions.push(eq(trades.symbol, filters.symbol));
    }
    if (filters?.side) {
        conditions.push(eq(trades.side, filters.side));
    }
    if (filters?.status) {
        conditions.push(eq(trades.status, filters.status));
    }
    if (filters?.pattern) {
        conditions.push(eq(trades.pattern, filters.pattern));
    }
    if (filters?.agentId) {
        conditions.push(eq(trades.agentId, filters.agentId));
    }
    if (filters?.userId) {
        conditions.push(eq(trades.userId, filters.userId));
    }
    if (filters?.since) {
        conditions.push(gte(trades.timestamp, filters.since));
    }
    if (filters?.until) {
        conditions.push(lte(trades.timestamp, filters.until));
    }

    if (conditions.length > 0) {
        query = query.where(and(...conditions)) as any;
    }

    // Order by timestamp descending (most recent first)
    query = query.orderBy(desc(trades.timestamp)) as any;

    // Apply limit
    if (filters?.limit) {
        query = query.limit(filters.limit) as any;
    }

    return await query;
}

/**
 * Get trade statistics for a given period
 */
export async function getTradeStats(
    period: 'day' | 'week' | 'month',
    options?: { userId?: number; symbol?: string }
): Promise<TradeStats> {
    // Calculate the start date based on period
    const since = new Date();
    switch (period) {
        case 'day':
            since.setDate(since.getDate() - 1);
            break;
        case 'week':
            since.setDate(since.getDate() - 7);
            break;
        case 'month':
            since.setMonth(since.getMonth() - 1);
            break;
    }

    const filters: TradeFilters = { since };
    if (options?.userId) {
        filters.userId = options.userId;
    }
    if (options?.symbol) {
        filters.symbol = options.symbol;
    }

    const allTrades = await getTradeHistory(filters);

    // Calculate statistics
    const closedTrades = allTrades.filter(t => t.status === 'CLOSED');
    const tradesWithPnl = closedTrades.filter(t => t.pnl !== null);
    const winningTrades = tradesWithPnl.filter(t => parseFloat(t.pnl as string) > 0);

    const pnls = tradesWithPnl.map(t => parseFloat(t.pnl as string || '0'));
    const totalPnl = pnls.reduce((sum, p) => sum + p, 0);
    const avgPnl = pnls.length > 0 ? totalPnl / pnls.length : 0;

    const confidences = allTrades
        .filter(t => t.confidence !== null)
        .map(t => parseFloat(t.confidence as string));
    const avgConfidence = confidences.length > 0
        ? confidences.reduce((sum, c) => sum + c, 0) / confidences.length
        : 0;

    // Group by symbol
    const bySymbol: Record<string, { count: number; pnl: number }> = {};
    allTrades.forEach(trade => {
        const symbol = trade.symbol;
        if (!bySymbol[symbol]) {
            bySymbol[symbol] = { count: 0, pnl: 0 };
        }
        bySymbol[symbol].count++;
        bySymbol[symbol].pnl += parseFloat(trade.pnl as string || '0');
    });

    // Group by pattern
    const byPattern: Record<string, { count: number; pnl: number; winRate: number }> = {};
    allTrades.forEach(trade => {
        const pattern = trade.pattern || 'UNKNOWN';
        if (!byPattern[pattern]) {
            byPattern[pattern] = { count: 0, pnl: 0, winRate: 0 };
        }
        byPattern[pattern].count++;
        byPattern[pattern].pnl += parseFloat(trade.pnl as string || '0');
    });

    // Calculate win rate for each pattern
    Object.keys(byPattern).forEach(pattern => {
        const patternTrades = closedTrades.filter(t => (t.pattern || 'UNKNOWN') === pattern);
        const patternWithPnl = patternTrades.filter(t => t.pnl !== null);
        const patternWins = patternWithPnl.filter(t => parseFloat(t.pnl as string) > 0);
        byPattern[pattern].winRate = patternWithPnl.length > 0
            ? patternWins.length / patternWithPnl.length
            : 0;
    });

    return {
        totalTrades: allTrades.length,
        buyTrades: allTrades.filter(t => t.side === 'BUY').length,
        sellTrades: allTrades.filter(t => t.side === 'SELL').length,
        filledTrades: allTrades.filter(t => t.status === 'FILLED').length,
        pendingTrades: allTrades.filter(t => t.status === 'PENDING').length,
        closedTrades: closedTrades.length,
        totalPnl,
        avgPnl,
        winRate: tradesWithPnl.length > 0 ? winningTrades.length / tradesWithPnl.length : 0,
        avgConfidence,
        bySymbol,
        byPattern,
    };
}

// ============================================================================
// SINGLE TRADE OPERATIONS
// ============================================================================

/**
 * Get a single trade by ID
 */
export async function getTradeById(id: number): Promise<Trade | undefined> {
    const [trade] = await db
        .select()
        .from(trades)
        .where(eq(trades.id, id))
        .limit(1);

    return trade;
}

/**
 * Update trade status
 */
export async function updateTradeStatus(
    id: number,
    status: string,
    updates?: {
        exitPrice?: string;
        pnl?: string;
    }
): Promise<Trade | undefined> {
    const updateData: Partial<NewTrade> = { status };

    if (updates?.exitPrice) {
        updateData.exitPrice = updates.exitPrice;
    }
    if (updates?.pnl) {
        updateData.pnl = updates.pnl;
    }

    const [updatedTrade] = await db
        .update(trades)
        .set(updateData)
        .where(eq(trades.id, id))
        .returning();

    return updatedTrade;
}

/**
 * Close a trade with exit price and calculate P&L
 */
export async function closeTrade(
    id: number,
    exitPrice: string
): Promise<Trade | undefined> {
    // First get the trade to calculate P&L
    const trade = await getTradeById(id);
    if (!trade) {
        return undefined;
    }

    // Calculate P&L
    const entryValue = parseFloat(trade.entryPrice as string || '0') * parseFloat(trade.quantity as string);
    const exitValue = parseFloat(exitPrice) * parseFloat(trade.quantity as string);
    const pnl = trade.side === 'BUY'
        ? exitValue - entryValue
        : entryValue - exitValue;

    const [closedTrade] = await db
        .update(trades)
        .set({
            status: 'CLOSED',
            exitPrice,
            pnl: pnl.toString(),
        })
        .where(eq(trades.id, id))
        .returning();

    return closedTrade;
}

/**
 * Fill a pending trade
 */
export async function fillTrade(
    id: number,
    entryPrice: string
): Promise<Trade | undefined> {
    const [filledTrade] = await db
        .update(trades)
        .set({
            status: 'FILLED',
            entryPrice,
        })
        .where(eq(trades.id, id))
        .returning();

    return filledTrade;
}

// ============================================================================
// QUERY HELPERS
// ============================================================================

/**
 * Get recent trades (shortcut for getTradeHistory with limit)
 */
export async function getRecentTrades(limit: number = 10): Promise<Trade[]> {
    return await getTradeHistory({ limit });
}

/**
 * Get pending trades
 */
export async function getPendingTrades(): Promise<Trade[]> {
    return await getTradeHistory({ status: 'PENDING' });
}

/**
 * Get filled (active) trades
 */
export async function getFilledTrades(): Promise<Trade[]> {
    return await getTradeHistory({ status: 'FILLED' });
}

/**
 * Get trades by agent
 */
export async function getTradesByAgent(agentId: string, limit?: number): Promise<Trade[]> {
    return await getTradeHistory({ agentId, limit });
}

// ============================================================================
// CLEANUP
// ============================================================================

/**
 * Clean up old closed trades
 */
export async function cleanupOldTrades(daysToKeep: number = 90): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    // Count trades to delete
    const toDelete = await db
        .select({ id: trades.id })
        .from(trades)
        .where(
            and(
                eq(trades.status, 'CLOSED'),
                lte(trades.timestamp, cutoffDate)
            )
        );

    if (toDelete.length === 0) {
        return 0;
    }

    // Delete old closed trades
    await db
        .delete(trades)
        .where(
            and(
                eq(trades.status, 'CLOSED'),
                lte(trades.timestamp, cutoffDate)
            )
        );

    return toDelete.length;
}

/**
 * Get daily trade summary
 */
export async function getDailyTradeSummary(date?: Date): Promise<{
    date: string;
    totalTrades: number;
    totalVolume: number;
    totalPnl: number;
    winRate: number;
    bestTrade: Trade | null;
    worstTrade: Trade | null;
}> {
    const targetDate = date || new Date();
    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);

    const dayTrades = await getTradeHistory({
        since: startOfDay,
        until: endOfDay,
    });

    const closedTrades = dayTrades.filter(t => t.status === 'CLOSED');
    const tradesWithPnl = closedTrades.filter(t => t.pnl !== null);
    const winningTrades = tradesWithPnl.filter(t => parseFloat(t.pnl as string) > 0);

    const pnls = tradesWithPnl.map(t => parseFloat(t.pnl as string || '0'));
    const totalPnl = pnls.reduce((sum, p) => sum + p, 0);

    const volumes = dayTrades.map(t => {
        const price = parseFloat(t.entryPrice as string || '0');
        const qty = parseFloat(t.quantity as string || '0');
        return price * qty;
    });
    const totalVolume = volumes.reduce((sum, v) => sum + v, 0);

    // Find best and worst trades
    let bestTrade: Trade | null = null;
    let worstTrade: Trade | null = null;
    let bestPnl = -Infinity;
    let worstPnl = Infinity;

    tradesWithPnl.forEach(trade => {
        const pnl = parseFloat(trade.pnl as string);
        if (pnl > bestPnl) {
            bestPnl = pnl;
            bestTrade = trade;
        }
        if (pnl < worstPnl) {
            worstPnl = pnl;
            worstTrade = trade;
        }
    });

    return {
        date: targetDate.toISOString().split('T')[0],
        totalTrades: dayTrades.length,
        totalVolume,
        totalPnl,
        winRate: tradesWithPnl.length > 0 ? winningTrades.length / tradesWithPnl.length : 0,
        bestTrade,
        worstTrade,
    };
}
