import { db } from './index';
import { signals, type Signal, type NewSignal } from './schema';
import { desc, eq, and, gte } from 'drizzle-orm';

/**
 * Signals Repository
 * Handles all database operations for trading signals
 */

/**
 * Insert a new signal into the database
 */
export async function createSignal(signal: Omit<NewSignal, 'id' | 'timestamp'>): Promise<Signal> {
    const [insertedSignal] = await db
        .insert(signals)
        .values({
            ...signal,
            timestamp: new Date(),
        })
        .returning();

    return insertedSignal;
}

/**
 * Get all signals, optionally filtered
 */
export async function getSignals(options?: {
    symbol?: string;
    pattern?: string;
    executed?: boolean;
    limit?: number;
    since?: Date;
}): Promise<Signal[]> {
    let query = db.select().from(signals);

    // Apply filters
    const filters = [];
    if (options?.symbol) {
        filters.push(eq(signals.symbol, options.symbol));
    }
    if (options?.pattern) {
        filters.push(eq(signals.pattern, options.pattern));
    }
    if (options?.executed !== undefined) {
        filters.push(eq(signals.executed, options.executed));
    }
    if (options?.since) {
        filters.push(gte(signals.timestamp, options.since));
    }

    if (filters.length > 0) {
        query = query.where(and(...filters)) as any;
    }

    // Order by timestamp descending
    query = query.orderBy(desc(signals.timestamp)) as any;

    // Apply limit
    if (options?.limit) {
        query = query.limit(options.limit) as any;
    }

    return await query;
}

/**
 * Get a single signal by ID
 */
export async function getSignalById(id: number): Promise<Signal | undefined> {
    const [signal] = await db
        .select()
        .from(signals)
        .where(eq(signals.id, id))
        .limit(1);

    return signal;
}

/**
 * Mark a signal as executed
 */
export async function markSignalExecuted(id: number): Promise<Signal | undefined> {
    const [updatedSignal] = await db
        .update(signals)
        .set({ executed: true })
        .where(eq(signals.id, id))
        .returning();

    return updatedSignal;
}

/**
 * Get recent unexecuted signals (for Orchestrator)
 */
export async function getUnexecutedSignals(limit: number = 10): Promise<Signal[]> {
    return await db
        .select()
        .from(signals)
        .where(eq(signals.executed, false))
        .orderBy(desc(signals.timestamp))
        .limit(limit);
}

/**
 * Get signal statistics
 */
export async function getSignalStats(options?: {
    since?: Date;
    pattern?: string;
}): Promise<{
    total: number;
    executed: number;
    pending: number;
    byPattern: Record<string, number>;
}> {
    const filters = [];
    if (options?.since) {
        filters.push(gte(signals.timestamp, options.since));
    }
    if (options?.pattern) {
        filters.push(eq(signals.pattern, options.pattern));
    }

    let query = db.select().from(signals);
    if (filters.length > 0) {
        query = query.where(and(...filters)) as any;
    }

    const allSignals = await query;

    const stats = {
        total: allSignals.length,
        executed: allSignals.filter(s => s.executed).length,
        pending: allSignals.filter(s => !s.executed).length,
        byPattern: {} as Record<string, number>
    };

    // Count by pattern
    allSignals.forEach(signal => {
        const pattern = signal.pattern || 'unknown';
        stats.byPattern[pattern] = (stats.byPattern[pattern] || 0) + 1;
    });

    return stats;
}

/**
 * Mark the most recent unexecuted signal for a symbol/action as executed
 */
export async function markLatestSignalExecuted(symbol: string, action: string): Promise<void> {
    const [latest] = await db
        .select({ id: signals.id })
        .from(signals)
        .where(and(
            eq(signals.symbol, symbol),
            eq(signals.executed, false),
            eq(signals.action, action)
        ))
        .orderBy(desc(signals.id))
        .limit(1);

    if (latest) {
        await markSignalExecuted(latest.id);
    }
}

/**
 * Delete old executed signals (cleanup)
 */
export async function cleanupOldSignals(daysToKeep: number = 30): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    // First count how many will be deleted
    const toDelete = await db
        .select({ id: signals.id })
        .from(signals)
        .where(
            and(
                eq(signals.executed, true),
                gte(signals.timestamp, cutoffDate)
            )
        );

    if (toDelete.length === 0) {
        return 0;
    }

    // Then delete them
    await db
        .delete(signals)
        .where(
            and(
                eq(signals.executed, true),
                gte(signals.timestamp, cutoffDate)
            )
        );

    return toDelete.length;
}
