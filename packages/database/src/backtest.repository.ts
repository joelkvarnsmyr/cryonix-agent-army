import { db } from './index';
import { backtestResults, type BacktestResult, type NewBacktestResult } from './schema';
import { desc, eq, and, gte } from 'drizzle-orm';

/**
 * Backtest Repository
 * Handles all database operations for backtest results
 */

/**
 * Save a new backtest result
 */
export async function saveBacktestResult(
    result: Omit<NewBacktestResult, 'id' | 'timestamp'>
): Promise<BacktestResult> {
    const [savedResult] = await db
        .insert(backtestResults)
        .values({
            ...result,
            timestamp: new Date(),
        })
        .returning();

    return savedResult;
}

/**
 * Get all backtest results, optionally filtered
 */
export async function getBacktestResults(options?: {
    userId?: number;
    status?: string;
    limit?: number;
    since?: Date;
}): Promise<BacktestResult[]> {
    let query = db.select().from(backtestResults);

    // Apply filters
    const filters = [];
    if (options?.userId) {
        filters.push(eq(backtestResults.userId, options.userId));
    }
    if (options?.status) {
        filters.push(eq(backtestResults.status, options.status));
    }
    if (options?.since) {
        filters.push(gte(backtestResults.timestamp, options.since));
    }

    if (filters.length > 0) {
        query = query.where(and(...filters)) as any;
    }

    // Order by timestamp descending
    query = query.orderBy(desc(backtestResults.timestamp)) as any;

    // Apply limit
    if (options?.limit) {
        query = query.limit(options.limit) as any;
    }

    return await query;
}

/**
 * Get a single backtest result by ID
 */
export async function getBacktestResultById(id: number): Promise<BacktestResult | undefined> {
    const [result] = await db
        .select()
        .from(backtestResults)
        .where(eq(backtestResults.id, id))
        .limit(1);

    return result;
}

/**
 * Update backtest status (e.g., from RUNNING to COMPLETED)
 */
export async function updateBacktestStatus(
    id: number,
    status: string,
    errorMessage?: string
): Promise<BacktestResult | undefined> {
    const [updatedResult] = await db
        .update(backtestResults)
        .set({
            status,
            ...(errorMessage && { errorMessage })
        })
        .where(eq(backtestResults.id, id))
        .returning();

    return updatedResult;
}

/**
 * Delete a backtest result
 */
export async function deleteBacktestResult(id: number): Promise<boolean> {
    const result = await db
        .delete(backtestResults)
        .where(eq(backtestResults.id, id))
        .returning();

    return result.length > 0;
}

/**
 * Clean up old backtest results (keep only recent ones)
 */
export async function cleanupOldBacktests(daysToKeep: number = 90): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    // First count how many will be deleted
    const toDelete = await db
        .select({ id: backtestResults.id })
        .from(backtestResults)
        .where(gte(backtestResults.timestamp, cutoffDate));

    if (toDelete.length === 0) {
        return 0;
    }

    // Then delete them
    await db
        .delete(backtestResults)
        .where(gte(backtestResults.timestamp, cutoffDate));

    return toDelete.length;
}

/**
 * Get backtest history (alias for getBacktestResults with default limit)
 */
export async function getBacktestHistory(limit: number = 20): Promise<BacktestResult[]> {
    return await getBacktestResults({ limit });
}

// ============================================================================
// STRATEGY ANALYSIS
// ============================================================================

export interface Strategy {
    id: number;
    config: any;
    metrics: any;
    sharpeRatio: number;
    winRate: number;
    totalReturn: number;
    maxDrawdown: number;
    timestamp: Date;
}

/**
 * Get best performing strategies by a specific metric
 */
export async function getBestStrategies(
    metric: 'sharpe' | 'winRate' | 'return' | 'drawdown' = 'sharpe',
    limit: number = 10
): Promise<Strategy[]> {
    const results = await db
        .select()
        .from(backtestResults)
        .where(eq(backtestResults.status, 'COMPLETED'));

    // Map to Strategy type and extract metrics
    const strategies: Strategy[] = results.map(r => {
        const metrics = r.metrics as any || {};
        return {
            id: r.id,
            config: r.config,
            metrics: r.metrics,
            sharpeRatio: metrics.sharpeRatio || 0,
            winRate: metrics.winRate || 0,
            totalReturn: metrics.totalReturn || 0,
            maxDrawdown: metrics.maxDrawdown || 0,
            timestamp: r.timestamp,
        };
    });

    // Sort by the specified metric
    switch (metric) {
        case 'sharpe':
            strategies.sort((a, b) => b.sharpeRatio - a.sharpeRatio);
            break;
        case 'winRate':
            strategies.sort((a, b) => b.winRate - a.winRate);
            break;
        case 'return':
            strategies.sort((a, b) => b.totalReturn - a.totalReturn);
            break;
        case 'drawdown':
            // Lower drawdown is better, so sort ascending
            strategies.sort((a, b) => a.maxDrawdown - b.maxDrawdown);
            break;
    }

    return strategies.slice(0, limit);
}

/**
 * Get strategy comparison (compare multiple strategies side by side)
 */
export async function compareStrategies(ids: number[]): Promise<{
    strategies: Strategy[];
    comparison: {
        bestSharpe: Strategy | null;
        bestWinRate: Strategy | null;
        bestReturn: Strategy | null;
        lowestDrawdown: Strategy | null;
    };
}> {
    const results = await Promise.all(
        ids.map(id => getBacktestResultById(id))
    );

    const strategies: Strategy[] = results
        .filter((r): r is BacktestResult => r !== undefined)
        .map(r => {
            const metrics = r.metrics as any || {};
            return {
                id: r.id,
                config: r.config,
                metrics: r.metrics,
                sharpeRatio: metrics.sharpeRatio || 0,
                winRate: metrics.winRate || 0,
                totalReturn: metrics.totalReturn || 0,
                maxDrawdown: metrics.maxDrawdown || 0,
                timestamp: r.timestamp,
            };
        });

    const comparison = {
        bestSharpe: strategies.reduce((best, curr) =>
            curr.sharpeRatio > (best?.sharpeRatio || -Infinity) ? curr : best, null as Strategy | null),
        bestWinRate: strategies.reduce((best, curr) =>
            curr.winRate > (best?.winRate || -Infinity) ? curr : best, null as Strategy | null),
        bestReturn: strategies.reduce((best, curr) =>
            curr.totalReturn > (best?.totalReturn || -Infinity) ? curr : best, null as Strategy | null),
        lowestDrawdown: strategies.reduce((best, curr) =>
            curr.maxDrawdown < (best?.maxDrawdown || Infinity) ? curr : best, null as Strategy | null),
    };

    return { strategies, comparison };
}

/**
 * Get backtest statistics
 */
export async function getBacktestStats(options?: {
    userId?: number;
    since?: Date;
}): Promise<{
    total: number;
    completed: number;
    running: number;
    failed: number;
    avgSharpeRatio: number | null;
    bestPerformer: BacktestResult | null;
}> {
    const filters = [];
    if (options?.userId) {
        filters.push(eq(backtestResults.userId, options.userId));
    }
    if (options?.since) {
        filters.push(gte(backtestResults.timestamp, options.since));
    }

    let query = db.select().from(backtestResults);
    if (filters.length > 0) {
        query = query.where(and(...filters)) as any;
    }

    const allResults = await query;

    // Calculate statistics
    const completed = allResults.filter(r => r.status === 'COMPLETED');
    const sharpeRatios = completed
        .map(r => (r.metrics as any)?.sharpeRatio)
        .filter(s => s !== undefined && s !== null);

    const avgSharpeRatio = sharpeRatios.length > 0
        ? sharpeRatios.reduce((sum, s) => sum + s, 0) / sharpeRatios.length
        : null;

    // Find best performer by Sharpe ratio
    const bestPerformer = completed.reduce((best, current) => {
        const currentSharpe = (current.metrics as any)?.sharpeRatio || 0;
        const bestSharpe = (best?.metrics as any)?.sharpeRatio || 0;
        return currentSharpe > bestSharpe ? current : best;
    }, null as BacktestResult | null);

    return {
        total: allResults.length,
        completed: completed.length,
        running: allResults.filter(r => r.status === 'RUNNING').length,
        failed: allResults.filter(r => r.status === 'FAILED').length,
        avgSharpeRatio,
        bestPerformer,
    };
}
