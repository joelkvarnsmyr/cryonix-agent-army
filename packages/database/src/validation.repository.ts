import { db } from './index';
import { validationHistory, type ValidationHistory, type NewValidationHistory } from './schema';
import { desc, eq, and, gte } from 'drizzle-orm';

/**
 * Validation Repository
 * Handles all database operations for signal validation history
 */

/**
 * Save a new validation record
 */
export async function saveValidation(
    validation: Omit<NewValidationHistory, 'id' | 'timestamp'>
): Promise<ValidationHistory> {
    const [savedValidation] = await db
        .insert(validationHistory)
        .values({
            ...validation,
            timestamp: new Date(),
        })
        .returning();

    return savedValidation;
}

/**
 * Get validation history, optionally filtered
 */
export async function getValidationHistory(options?: {
    symbol?: string;
    signalId?: number;
    approved?: boolean;
    consensusLevel?: string;
    limit?: number;
    since?: Date;
}): Promise<ValidationHistory[]> {
    let query = db.select().from(validationHistory);

    // Apply filters
    const filters = [];
    if (options?.symbol) {
        filters.push(eq(validationHistory.symbol, options.symbol));
    }
    if (options?.signalId) {
        filters.push(eq(validationHistory.signalId, options.signalId));
    }
    if (options?.approved !== undefined) {
        filters.push(eq(validationHistory.approved, options.approved));
    }
    if (options?.consensusLevel) {
        filters.push(eq(validationHistory.consensusLevel, options.consensusLevel));
    }
    if (options?.since) {
        filters.push(gte(validationHistory.timestamp, options.since));
    }

    if (filters.length > 0) {
        query = query.where(and(...filters)) as any;
    }

    // Order by timestamp descending
    query = query.orderBy(desc(validationHistory.timestamp)) as any;

    // Apply limit
    if (options?.limit) {
        query = query.limit(options.limit) as any;
    }

    return await query;
}

/**
 * Get a single validation record by ID
 */
export async function getValidationById(id: number): Promise<ValidationHistory | undefined> {
    const [validation] = await db
        .select()
        .from(validationHistory)
        .where(eq(validationHistory.id, id))
        .limit(1);

    return validation;
}

/**
 * Get validation statistics
 */
export async function getValidationStats(options?: {
    since?: Date;
    symbol?: string;
}): Promise<{
    total: number;
    approved: number;
    rejected: number;
    approvalRate: number;
    byConsensus: Record<string, number>;
    byRiskLevel: Record<string, number>;
    avgConfidenceAdjustment: number;
}> {
    const filters = [];
    if (options?.since) {
        filters.push(gte(validationHistory.timestamp, options.since));
    }
    if (options?.symbol) {
        filters.push(eq(validationHistory.symbol, options.symbol));
    }

    let query = db.select().from(validationHistory);
    if (filters.length > 0) {
        query = query.where(and(...filters)) as any;
    }

    const allValidations = await query;

    const approved = allValidations.filter(v => v.approved).length;
    const rejected = allValidations.length - approved;

    // Count by consensus level
    const byConsensus: Record<string, number> = {};
    allValidations.forEach(v => {
        const level = v.consensusLevel || 'UNKNOWN';
        byConsensus[level] = (byConsensus[level] || 0) + 1;
    });

    // Count by risk level
    const byRiskLevel: Record<string, number> = {};
    allValidations.forEach(v => {
        const level = v.riskLevel || 'UNKNOWN';
        byRiskLevel[level] = (byRiskLevel[level] || 0) + 1;
    });

    // Calculate average confidence adjustment
    const confidenceAdjustments = allValidations
        .filter(v => v.originalConfidence && v.adjustedConfidence)
        .map(v => {
            const original = parseFloat(v.originalConfidence as string);
            const adjusted = parseFloat(v.adjustedConfidence as string);
            return adjusted - original;
        });

    const avgConfidenceAdjustment = confidenceAdjustments.length > 0
        ? confidenceAdjustments.reduce((sum, adj) => sum + adj, 0) / confidenceAdjustments.length
        : 0;

    return {
        total: allValidations.length,
        approved,
        rejected,
        approvalRate: allValidations.length > 0 ? approved / allValidations.length : 0,
        byConsensus,
        byRiskLevel,
        avgConfidenceAdjustment,
    };
}

/**
 * Get recent validations for a specific signal
 */
export async function getValidationsForSignal(signalId: number): Promise<ValidationHistory[]> {
    return await db
        .select()
        .from(validationHistory)
        .where(eq(validationHistory.signalId, signalId))
        .orderBy(desc(validationHistory.timestamp));
}

/**
 * Clean up old validation records
 */
export async function cleanupOldValidations(daysToKeep: number = 60): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    // First count how many will be deleted
    const toDelete = await db
        .select({ id: validationHistory.id })
        .from(validationHistory)
        .where(gte(validationHistory.timestamp, cutoffDate));

    if (toDelete.length === 0) {
        return 0;
    }

    // Then delete them
    await db
        .delete(validationHistory)
        .where(gte(validationHistory.timestamp, cutoffDate));

    return toDelete.length;
}

/**
 * Get accuracy metrics for the validator
 * (Requires comparing validation predictions with actual trade outcomes)
 */
export async function getValidatorAccuracy(options?: {
    since?: Date;
}): Promise<{
    totalValidated: number;
    correctPredictions: number;
    accuracy: number;
    strongConsensusAccuracy: number;
    moderateConsensusAccuracy: number;
}> {
    const filters = [];
    if (options?.since) {
        filters.push(gte(validationHistory.timestamp, options.since));
    }

    let query = db.select().from(validationHistory);
    if (filters.length > 0) {
        query = query.where(and(...filters)) as any;
    }

    const validations = await query;

    // Note: This is a placeholder for actual accuracy calculation
    // In practice, you'd need to join with actual trade outcomes
    const strongConsensus = validations.filter(v => v.consensusLevel === 'STRONG');
    const moderateConsensus = validations.filter(v => v.consensusLevel === 'MODERATE');

    return {
        totalValidated: validations.length,
        correctPredictions: 0, // Placeholder
        accuracy: 0, // Placeholder
        strongConsensusAccuracy: strongConsensus.length > 0 ? 0.85 : 0, // Placeholder
        moderateConsensusAccuracy: moderateConsensus.length > 0 ? 0.65 : 0, // Placeholder
    };
}
