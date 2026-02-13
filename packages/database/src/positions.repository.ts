import { db } from './index';
import { positionHistory, positions, type PositionHistory, type NewPositionHistory, type Position, type NewPosition } from './schema';
import { desc, eq, and, gte, isNull } from 'drizzle-orm';

/**
 * Position Repository
 * Handles all database operations for position tracking and history
 */

// ============================================================================
// TYPES
// ============================================================================

export interface PositionUpdate {
    quantity?: string;
    currentPrice?: string;
    stopLoss?: string;
    takeProfit?: string;
    pnl?: string;
    pnlPercent?: string;
}

// ============================================================================
// POSITION CRUD OPERATIONS
// ============================================================================

/**
 * Create a new position
 */
export async function createPosition(
    position: Omit<NewPosition, 'id' | 'openedAt'>
): Promise<Position> {
    const [newPosition] = await db
        .insert(positions)
        .values({
            ...position,
            openedAt: new Date(),
            status: position.status || 'OPEN',
        })
        .returning();

    return newPosition;
}

/**
 * Update a position (add to, reduce, modify)
 */
export async function updatePosition(
    id: number,
    update: PositionUpdate
): Promise<Position | undefined> {
    // Get existing position first
    const existingPosition = await getPositionById(id);
    if (!existingPosition) {
        return undefined;
    }

    const updateData: Partial<NewPosition> = {};

    // Handle quantity update
    if (update.quantity !== undefined) {
        updateData.quantity = update.quantity;
        // Recalculate average entry price if adding to position
        // This is a simplified version - in reality you'd track each entry
    }

    // Handle current price and P&L updates
    if (update.currentPrice !== undefined) {
        updateData.currentPrice = update.currentPrice;

        // Recalculate P&L
        const entryPrice = parseFloat(existingPosition.entryPrice as string);
        const currentPrice = parseFloat(update.currentPrice);
        const quantity = parseFloat(update.quantity || existingPosition.quantity as string);

        const entryValue = entryPrice * quantity;
        const currentValue = currentPrice * quantity;
        const pnl = currentValue - entryValue;
        const pnlPercent = entryValue > 0 ? (pnl / entryValue) * 100 : 0;

        updateData.pnl = pnl.toString();
        updateData.pnlPercent = pnlPercent.toString();
    }

    // Handle stop loss and take profit
    if (update.stopLoss !== undefined) {
        updateData.stopLoss = update.stopLoss;
    }
    if (update.takeProfit !== undefined) {
        updateData.takeProfit = update.takeProfit;
    }

    // Direct P&L override (if provided)
    if (update.pnl !== undefined) {
        updateData.pnl = update.pnl;
    }
    if (update.pnlPercent !== undefined) {
        updateData.pnlPercent = update.pnlPercent;
    }

    if (Object.keys(updateData).length === 0) {
        return existingPosition;
    }

    const [updatedPosition] = await db
        .update(positions)
        .set(updateData)
        .where(eq(positions.id, id))
        .returning();

    return updatedPosition;
}

/**
 * Save a position to history when closed
 */
export async function archivePosition(
    position: Omit<NewPositionHistory, 'id'>
): Promise<PositionHistory> {
    const [archived] = await db
        .insert(positionHistory)
        .values(position)
        .returning();

    return archived;
}

/**
 * Get position history, optionally filtered
 */
export async function getPositionHistory(options?: {
    userId?: number;
    symbol?: string;
    side?: string;
    closeReason?: string;
    pattern?: string;
    limit?: number;
    since?: Date;
}): Promise<PositionHistory[]> {
    let query = db.select().from(positionHistory);

    // Apply filters
    const filters = [];
    if (options?.userId) {
        filters.push(eq(positionHistory.userId, options.userId));
    }
    if (options?.symbol) {
        filters.push(eq(positionHistory.symbol, options.symbol));
    }
    if (options?.side) {
        filters.push(eq(positionHistory.side, options.side));
    }
    if (options?.closeReason) {
        filters.push(eq(positionHistory.closeReason, options.closeReason));
    }
    if (options?.pattern) {
        filters.push(eq(positionHistory.pattern, options.pattern));
    }
    if (options?.since) {
        filters.push(gte(positionHistory.openedAt, options.since));
    }

    if (filters.length > 0) {
        query = query.where(and(...filters)) as any;
    }

    // Order by closed date descending
    query = query.orderBy(desc(positionHistory.closedAt)) as any;

    // Apply limit
    if (options?.limit) {
        query = query.limit(options.limit) as any;
    }

    return await query;
}

/**
 * Get open positions from the positions table
 */
export async function getOpenPositions(options?: {
    userId?: number;
    symbol?: string;
}): Promise<Position[]> {
    let query = db.select().from(positions);

    const filters = [eq(positions.status, 'OPEN')];

    if (options?.userId) {
        filters.push(eq(positions.userId, options.userId));
    }
    if (options?.symbol) {
        filters.push(eq(positions.symbol, options.symbol));
    }

    query = query.where(and(...filters)) as any;

    return await query;
}

/**
 * Close a position and archive it
 */
export async function closePosition(
    positionId: number,
    exitPrice: string,
    closeReason: string,
    metadata?: any
): Promise<{ position: Position | undefined; archived: PositionHistory }> {
    // Update the position in positions table
    const [closedPosition] = await db
        .update(positions)
        .set({
            status: 'CLOSED',
            closedAt: new Date(),
            currentPrice: exitPrice,
        })
        .where(eq(positions.id, positionId))
        .returning();

    if (!closedPosition) {
        throw new Error(`Position ${positionId} not found`);
    }

    // Calculate P&L
    const entryValue = parseFloat(closedPosition.entryPrice as string) * parseFloat(closedPosition.quantity as string);
    const exitValue = parseFloat(exitPrice) * parseFloat(closedPosition.quantity as string);
    const pnl = exitValue - entryValue;
    const pnlPercent = (pnl / entryValue) * 100;

    // Calculate holding period
    const holdingPeriod = closedPosition.closedAt && closedPosition.openedAt
        ? Math.floor((closedPosition.closedAt.getTime() - closedPosition.openedAt.getTime()) / 1000)
        : 0;

    // Archive to position history
    const archived = await archivePosition({
        positionId: closedPosition.id,
        userId: closedPosition.userId,
        symbol: closedPosition.symbol,
        side: 'LONG', // Default, could be enhanced
        quantity: closedPosition.quantity,
        entryPrice: closedPosition.entryPrice,
        exitPrice,
        avgEntryPrice: closedPosition.entryPrice,
        stopLoss: closedPosition.stopLoss,
        takeProfit: closedPosition.takeProfit,
        pnl: pnl.toString(),
        pnlPercent: pnlPercent.toString(),
        fees: '0', // Placeholder
        holdingPeriod,
        openedAt: closedPosition.openedAt!,
        closedAt: closedPosition.closedAt,
        closeReason,
        signalId: null,
        pattern: null,
        metadata,
        agentId: null,
    });

    return { position: closedPosition, archived };
}

/**
 * Get position statistics
 */
export async function getPositionStats(options?: {
    userId?: number;
    since?: Date;
}): Promise<{
    totalClosed: number;
    profitable: number;
    losing: number;
    winRate: number;
    avgPnl: number;
    avgPnlPercent: number;
    avgHoldingPeriod: number;
    totalPnl: number;
    byCloseReason: Record<string, number>;
    byPattern: Record<string, { count: number; winRate: number; avgPnl: number }>;
}> {
    const filters = [];
    if (options?.userId) {
        filters.push(eq(positionHistory.userId, options.userId));
    }
    if (options?.since) {
        filters.push(gte(positionHistory.openedAt, options.since));
    }

    let query = db.select().from(positionHistory);
    if (filters.length > 0) {
        query = query.where(and(...filters)) as any;
    }

    const allPositions = await query;

    const profitable = allPositions.filter(p => parseFloat(p.pnl as string || '0') > 0).length;
    const losing = allPositions.filter(p => parseFloat(p.pnl as string || '0') < 0).length;

    const pnls = allPositions.map(p => parseFloat(p.pnl as string || '0'));
    const pnlPercents = allPositions.map(p => parseFloat(p.pnlPercent as string || '0'));
    const holdingPeriods = allPositions.map(p => p.holdingPeriod || 0);

    const avgPnl = pnls.length > 0 ? pnls.reduce((sum, p) => sum + p, 0) / pnls.length : 0;
    const avgPnlPercent = pnlPercents.length > 0
        ? pnlPercents.reduce((sum, p) => sum + p, 0) / pnlPercents.length
        : 0;
    const avgHoldingPeriod = holdingPeriods.length > 0
        ? holdingPeriods.reduce((sum, p) => sum + p, 0) / holdingPeriods.length
        : 0;
    const totalPnl = pnls.reduce((sum, p) => sum + p, 0);

    // Count by close reason
    const byCloseReason: Record<string, number> = {};
    allPositions.forEach(p => {
        const reason = p.closeReason || 'UNKNOWN';
        byCloseReason[reason] = (byCloseReason[reason] || 0) + 1;
    });

    // Stats by pattern
    const byPattern: Record<string, { count: number; winRate: number; avgPnl: number }> = {};
    allPositions.forEach(p => {
        const pattern = p.pattern || 'UNKNOWN';
        if (!byPattern[pattern]) {
            byPattern[pattern] = { count: 0, winRate: 0, avgPnl: 0 };
        }
        byPattern[pattern].count++;
    });

    // Calculate win rate and avg PnL for each pattern
    Object.keys(byPattern).forEach(pattern => {
        const patternPositions = allPositions.filter(p => (p.pattern || 'UNKNOWN') === pattern);
        const wins = patternPositions.filter(p => parseFloat(p.pnl as string || '0') > 0).length;
        const patternPnls = patternPositions.map(p => parseFloat(p.pnl as string || '0'));

        byPattern[pattern].winRate = patternPositions.length > 0 ? wins / patternPositions.length : 0;
        byPattern[pattern].avgPnl = patternPnls.length > 0
            ? patternPnls.reduce((sum, p) => sum + p, 0) / patternPnls.length
            : 0;
    });

    return {
        totalClosed: allPositions.length,
        profitable,
        losing,
        winRate: allPositions.length > 0 ? profitable / allPositions.length : 0,
        avgPnl,
        avgPnlPercent,
        avgHoldingPeriod,
        totalPnl,
        byCloseReason,
        byPattern,
    };
}

/**
 * Get currently open positions count and value
 */
export async function getOpenPositionsSummary(userId?: number): Promise<{
    count: number;
    totalValue: number;
    positions: Position[];
}> {
    const openPositions = await getOpenPositions({ userId });

    const totalValue = openPositions.reduce((sum, p) => {
        const price = parseFloat(p.currentPrice as string || p.entryPrice as string || '0');
        const qty = parseFloat(p.quantity as string || '0');
        return sum + (price * qty);
    }, 0);

    return {
        count: openPositions.length,
        totalValue,
        positions: openPositions,
    };
}

/**
 * Update position details (stop loss, take profit)
 */
export async function updatePositionLevels(
    positionId: number,
    updates: {
        stopLoss?: string;
        takeProfit?: string;
        currentPrice?: string;
    }
): Promise<Position | undefined> {
    const updateData: any = {};

    if (updates.stopLoss !== undefined) {
        updateData.stopLoss = updates.stopLoss;
    }
    if (updates.takeProfit !== undefined) {
        updateData.takeProfit = updates.takeProfit;
    }
    if (updates.currentPrice !== undefined) {
        updateData.currentPrice = updates.currentPrice;
        // Recalculate PnL if current price is updated
        const [existingPosition] = await db
            .select()
            .from(positions)
            .where(eq(positions.id, positionId))
            .limit(1);

        if (existingPosition) {
            const entryValue = parseFloat(existingPosition.entryPrice as string) * parseFloat(existingPosition.quantity as string);
            const currentValue = parseFloat(updates.currentPrice) * parseFloat(existingPosition.quantity as string);
            const pnl = currentValue - entryValue;
            const pnlPercent = (pnl / entryValue) * 100;

            updateData.pnl = pnl.toString();
            updateData.pnlPercent = pnlPercent.toString();
        }
    }

    if (Object.keys(updateData).length === 0) {
        return undefined;
    }

    const [updatedPosition] = await db
        .update(positions)
        .set(updateData)
        .where(eq(positions.id, positionId))
        .returning();

    return updatedPosition;
}

/**
 * Get position by ID
 */
export async function getPositionById(positionId: number): Promise<Position | undefined> {
    const [position] = await db
        .select()
        .from(positions)
        .where(eq(positions.id, positionId))
        .limit(1);

    return position;
}

/**
 * Clean up old position history
 */
export async function cleanupOldPositionHistory(daysToKeep: number = 365): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    // First count how many will be deleted
    const toDelete = await db
        .select({ id: positionHistory.id })
        .from(positionHistory)
        .where(gte(positionHistory.closedAt, cutoffDate));

    if (toDelete.length === 0) {
        return 0;
    }

    // Then delete them
    await db
        .delete(positionHistory)
        .where(gte(positionHistory.closedAt, cutoffDate));

    return toDelete.length;
}
