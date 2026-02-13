import { NextRequest, NextResponse } from 'next/server';
import {
    getOpenPositions,
    getPositionHistory,
    closePosition,
    getPositionStats,
    getOpenPositionsSummary,
    updatePositionLevels,
    getPositionById,
} from '@cryonix/database';
import { publishToWebSocket } from '@/lib/ws-publisher';
import type { WSPayloadPosition } from '@cryonix/types';
import { ClosePositionRequestSchema } from '@cryonix/types';

/**
 * GET /api/positions
 * List open or closed positions with filtering
 */
export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const action = searchParams.get('action') || 'open';
        const userId = searchParams.get('userId') ? parseInt(searchParams.get('userId')!) : undefined;
        const symbol = searchParams.get('symbol') || undefined;
        const limit = searchParams.get('limit') ? parseInt(searchParams.get('limit')!) : 50;
        const since = searchParams.get('since') ? new Date(searchParams.get('since')!) : undefined;

        switch (action) {
            case 'open': {
                // Get current open positions
                const positions = await getOpenPositions({ userId, symbol });
                return NextResponse.json({
                    success: true,
                    count: positions.length,
                    positions,
                });
            }

            case 'summary': {
                // Get summary of open positions
                const summary = await getOpenPositionsSummary(userId);
                return NextResponse.json({
                    success: true,
                    data: summary,
                });
            }

            case 'history': {
                // Get position history (closed positions)
                const closeReason = searchParams.get('closeReason') || undefined;
                const pattern = searchParams.get('pattern') || undefined;
                const side = searchParams.get('side') || undefined;

                const history = await getPositionHistory({
                    userId,
                    symbol,
                    closeReason,
                    pattern,
                    side,
                    limit,
                    since,
                });

                return NextResponse.json({
                    success: true,
                    count: history.length,
                    positions: history,
                });
            }

            case 'stats': {
                // Get position statistics
                const stats = await getPositionStats({ userId, since });
                return NextResponse.json({
                    success: true,
                    data: stats,
                });
            }

            default:
                return NextResponse.json(
                    { error: 'Invalid action. Use: open, summary, history, or stats' },
                    { status: 400 }
                );
        }
    } catch (error) {
        console.error('[API/Positions] GET Error:', error);
        return NextResponse.json(
            { error: 'Failed to fetch positions', details: String(error) },
            { status: 500 }
        );
    }
}

/**
 * POST /api/positions/close
 * Manually close a position
 */
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();

        // Validate request with Zod
        const validation = ClosePositionRequestSchema.safeParse(body);

        if (!validation.success) {
            return NextResponse.json(
                {
                    success: false,
                    error: 'Validation failed',
                    details: validation.error.format(),
                },
                { status: 400 }
            );
        }

        const data = validation.data;
        const { positionId, exitPrice, closeReason, metadata } = data;

        // Close the position
        const result = await closePosition(
            Number(positionId),
            exitPrice.toString(),
            closeReason,
            metadata
        );

        // Notify frontend via WebSocket
        if (result.position) {
            const payload: WSPayloadPosition = {
                position: {
                    ...result.position,
                    status: 'CLOSED', // Ensure status reflects the change
                    currentPrice: exitPrice.toString(),
                    closedAt: new Date(),
                } as any,
                action: 'CLOSED',
            };

            await publishToWebSocket('POSITION_UPDATE', payload);
        }

        return NextResponse.json({
            success: true,
            message: `Position ${positionId} closed`,
            position: result.position,
            archived: result.archived,
        });
    } catch (error) {
        console.error('[API/Positions] POST Error:', error);
        return NextResponse.json(
            { error: 'Failed to close position', details: String(error) },
            { status: 500 }
        );
    }
}

/**
 * PUT /api/positions
 * Update position details (e.g., stop loss, take profit, current price)
 */
export async function PUT(request: NextRequest) {
    try {
        const body = await request.json();
        const { positionId, stopLoss, takeProfit, currentPrice } = body;

        if (!positionId) {
            return NextResponse.json(
                { success: false, error: 'Missing positionId' },
                { status: 400 }
            );
        }

        // Build update object
        const updates: { stopLoss?: string; takeProfit?: string; currentPrice?: string } = {};

        if (stopLoss !== undefined) {
            updates.stopLoss = stopLoss.toString();
        }
        if (takeProfit !== undefined) {
            updates.takeProfit = takeProfit.toString();
        }
        if (currentPrice !== undefined) {
            updates.currentPrice = currentPrice.toString();
        }

        if (Object.keys(updates).length === 0) {
            return NextResponse.json(
                { success: false, error: 'No updates provided. Provide stopLoss, takeProfit, or currentPrice.' },
                { status: 400 }
            );
        }

        // Update position levels
        const updatedPosition = await updatePositionLevels(Number(positionId), updates);

        if (!updatedPosition) {
            return NextResponse.json(
                { success: false, error: `Position ${positionId} not found` },
                { status: 404 }
            );
        }

        // Notify frontend via WebSocket
        const payload: WSPayloadPosition = {
            position: updatedPosition as any,
            action: 'UPDATED',
        };
        await publishToWebSocket('POSITION_UPDATE', payload);

        return NextResponse.json({
            success: true,
            message: `Position ${positionId} updated`,
            position: updatedPosition,
        });
    } catch (error) {
        console.error('[API/Positions] PUT Error:', error);
        return NextResponse.json(
            { error: 'Failed to update position', details: String(error) },
            { status: 500 }
        );
    }
}

/**
 * DELETE /api/positions?id=:positionId&exitPrice=:price
 * Close a position by ID
 */
export async function DELETE(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const positionId = searchParams.get('id');
        const exitPrice = searchParams.get('exitPrice');
        const closeReason = searchParams.get('closeReason') || 'MANUAL';

        if (!positionId) {
            return NextResponse.json(
                { success: false, error: 'Missing position id query parameter' },
                { status: 400 }
            );
        }

        // Get the position to check if it exists and get current price
        const position = await getPositionById(Number(positionId));

        if (!position) {
            return NextResponse.json(
                { success: false, error: `Position ${positionId} not found` },
                { status: 404 }
            );
        }

        if (position.status === 'CLOSED') {
            return NextResponse.json(
                { success: false, error: `Position ${positionId} is already closed` },
                { status: 400 }
            );
        }

        // Use provided exit price or current price from position
        const finalExitPrice = exitPrice || position.currentPrice || position.entryPrice;

        if (!finalExitPrice) {
            return NextResponse.json(
                { success: false, error: 'Cannot determine exit price. Provide exitPrice parameter.' },
                { status: 400 }
            );
        }

        // Close the position
        const result = await closePosition(
            Number(positionId),
            finalExitPrice.toString(),
            closeReason,
            { closedVia: 'API_DELETE' }
        );

        // Notify frontend via WebSocket
        if (result.position) {
            const payload: WSPayloadPosition = {
                position: {
                    ...result.position,
                    status: 'CLOSED',
                    currentPrice: finalExitPrice.toString(),
                    closedAt: new Date(),
                } as any,
                action: 'CLOSED',
            };
            await publishToWebSocket('POSITION_UPDATE', payload);
        }

        return NextResponse.json({
            success: true,
            message: `Position ${positionId} closed`,
            position: result.position,
            archived: result.archived,
        });
    } catch (error) {
        console.error('[API/Positions] DELETE Error:', error);
        return NextResponse.json(
            { error: 'Failed to close position', details: String(error) },
            { status: 500 }
        );
    }
}
