'use client';

import { useState, useEffect } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
  Progress,
} from '@cryonix/ui';
import {
  TrendingUp,
  TrendingDown,
  Plus,
  X,
  RefreshCw,
  AlertTriangle,
  DollarSign,
  Percent,
  Clock,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface Position {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  quantity: number;
  entry_price: number;
  current_price: number;
  pnl: number;
  pnl_percent: number;
  stop_loss?: number;
  take_profit?: number;
  opened_at: string;
  leverage?: number;
  margin_used?: number;
}

interface PositionManagerProps {
  positions?: Position[];
  onClosePosition?: (positionId: string, exitPrice: number) => Promise<void>;
  onAddToPosition?: (positionId: string, quantity: number) => Promise<void>;
  onRefresh?: () => void;
}

export function PositionManager({
  positions: externalPositions,
  onClosePosition,
  onAddToPosition,
  onRefresh,
}: PositionManagerProps) {
  const [positions, setPositions] = useState<Position[]>(externalPositions || []);
  const [loading, setLoading] = useState(!externalPositions);
  const [closingPosition, setClosingPosition] = useState<string | null>(null);
  const [addingToPosition, setAddingToPosition] = useState<string | null>(null);
  const [addQuantity, setAddQuantity] = useState<string>('');

  // Fetch positions if not provided externally
  useEffect(() => {
    if (!externalPositions) {
      fetchPositions();
    }
  }, [externalPositions]);

  // Update internal state when external positions change
  useEffect(() => {
    if (externalPositions) {
      setPositions(externalPositions);
    }
  }, [externalPositions]);

  const fetchPositions = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/positions');
      const data = await res.json();
      if (data.success) {
        setPositions(data.positions || []);
      }
    } catch (error) {
      console.error('Failed to fetch positions:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleClosePosition = async (position: Position) => {
    setClosingPosition(position.id);
    try {
      if (onClosePosition) {
        await onClosePosition(position.id, position.current_price);
      } else {
        // Default API call
        await fetch('/api/positions', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            positionId: position.id,
            exitPrice: position.current_price,
            closeReason: 'manual_close',
          }),
        });
        fetchPositions();
      }
    } catch (error) {
      console.error('Failed to close position:', error);
    } finally {
      setClosingPosition(null);
    }
  };

  const handleAddToPosition = async (position: Position) => {
    if (!addQuantity || parseFloat(addQuantity) <= 0) return;

    setAddingToPosition(position.id);
    try {
      if (onAddToPosition) {
        await onAddToPosition(position.id, parseFloat(addQuantity));
      } else {
        // Default API call
        await fetch('/api/positions', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            positionId: position.id,
            addQuantity: parseFloat(addQuantity),
          }),
        });
        fetchPositions();
      }
      setAddQuantity('');
    } catch (error) {
      console.error('Failed to add to position:', error);
    } finally {
      setAddingToPosition(null);
    }
  };

  const handleRefresh = () => {
    if (onRefresh) {
      onRefresh();
    } else {
      fetchPositions();
    }
  };

  // Calculate total P&L
  const totalPnL = positions.reduce((sum, p) => sum + p.pnl, 0);
  const totalMarginUsed = positions.reduce((sum, p) => sum + (p.margin_used || 0), 0);

  // Calculate distance to stop loss / take profit as percentage
  const getDistanceToSL = (position: Position) => {
    if (!position.stop_loss) return null;
    return ((position.current_price - position.stop_loss) / position.current_price) * 100;
  };

  const getDistanceToTP = (position: Position) => {
    if (!position.take_profit) return null;
    return ((position.take_profit - position.current_price) / position.current_price) * 100;
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Position Manager</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex justify-between items-start">
          <div>
            <CardTitle className="flex items-center gap-2">
              Position Manager
              <Badge variant="outline">{positions.length} Open</Badge>
            </CardTitle>
            <CardDescription>
              Manage your active trading positions
            </CardDescription>
          </div>
          <div className="flex gap-2 items-center">
            <div className={`text-sm font-semibold ${totalPnL >= 0 ? 'text-green-500' : 'text-red-500'}`}>
              Total: {totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)}
            </div>
            <Button variant="outline" size="icon" onClick={handleRefresh}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Summary Stats */}
        {positions.length > 0 && (
          <div className="grid grid-cols-3 gap-3">
            <div className="p-3 bg-muted rounded-lg">
              <div className="text-xs text-muted-foreground">Positions</div>
              <div className="text-xl font-bold">{positions.length}</div>
            </div>
            <div className="p-3 bg-muted rounded-lg">
              <div className="text-xs text-muted-foreground">Total P&L</div>
              <div className={`text-xl font-bold ${totalPnL >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                {totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)}
              </div>
            </div>
            <div className="p-3 bg-muted rounded-lg">
              <div className="text-xs text-muted-foreground">Margin Used</div>
              <div className="text-xl font-bold">${totalMarginUsed.toFixed(2)}</div>
            </div>
          </div>
        )}

        {/* Positions List */}
        <div className="space-y-3">
          {positions.map((position) => {
            const isProfit = position.pnl >= 0;
            const distanceToSL = getDistanceToSL(position);
            const distanceToTP = getDistanceToTP(position);
            const isNearSL = distanceToSL !== null && Math.abs(distanceToSL) < 2;

            return (
              <div
                key={position.id}
                className={`rounded-lg border bg-card p-4 space-y-3 ${
                  isNearSL ? 'border-yellow-500/50' : 'border-border'
                }`}
              >
                {/* Header Row */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-bold">{position.symbol}</span>
                    <Badge variant={position.side === 'LONG' ? 'default' : 'destructive'}>
                      {position.side}
                    </Badge>
                    {position.leverage && position.leverage > 1 && (
                      <Badge variant="secondary">{position.leverage}x</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    {isProfit ? (
                      <TrendingUp className="h-4 w-4 text-green-500" />
                    ) : (
                      <TrendingDown className="h-4 w-4 text-red-500" />
                    )}
                    <span className={`font-semibold ${isProfit ? 'text-green-500' : 'text-red-500'}`}>
                      {isProfit ? '+' : ''}{position.pnl_percent.toFixed(2)}%
                    </span>
                  </div>
                </div>

                {/* Price Info */}
                <div className="grid grid-cols-3 gap-2 text-sm">
                  <div>
                    <span className="text-muted-foreground">Entry:</span>
                    <span className="ml-1 font-mono">${position.entry_price.toLocaleString()}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Current:</span>
                    <span className="ml-1 font-mono">${position.current_price.toLocaleString()}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Qty:</span>
                    <span className="ml-1 font-mono">{position.quantity}</span>
                  </div>
                </div>

                {/* Stop Loss / Take Profit Progress */}
                {(position.stop_loss || position.take_profit) && (
                  <div className="space-y-2">
                    {position.stop_loss && (
                      <div className="space-y-1">
                        <div className="flex justify-between text-xs">
                          <span className="text-red-500">Stop Loss: ${position.stop_loss.toLocaleString()}</span>
                          {distanceToSL !== null && (
                            <span className={distanceToSL < 2 ? 'text-yellow-500' : 'text-muted-foreground'}>
                              {distanceToSL > 0 ? '+' : ''}{distanceToSL.toFixed(2)}% away
                            </span>
                          )}
                        </div>
                        {isNearSL && (
                          <div className="flex items-center gap-1 text-xs text-yellow-500">
                            <AlertTriangle className="h-3 w-3" />
                            Approaching stop loss
                          </div>
                        )}
                      </div>
                    )}
                    {position.take_profit && (
                      <div className="flex justify-between text-xs">
                        <span className="text-green-500">Take Profit: ${position.take_profit.toLocaleString()}</span>
                        {distanceToTP !== null && (
                          <span className="text-muted-foreground">
                            {distanceToTP.toFixed(2)}% to target
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* P&L and Time */}
                <div className="flex items-center justify-between pt-2 border-t border-border">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    {formatDistanceToNow(new Date(position.opened_at), { addSuffix: true })}
                  </div>
                  <span className={`text-sm font-bold ${isProfit ? 'text-green-500' : 'text-red-500'}`}>
                    {isProfit ? '+' : ''}${position.pnl.toFixed(2)}
                  </span>
                </div>

                {/* Action Buttons */}
                <div className="flex gap-2 pt-2">
                  {/* Add to Position Dialog */}
                  <Dialog>
                    <DialogTrigger asChild>
                      <Button variant="outline" size="sm" className="flex-1">
                        <Plus className="h-3 w-3 mr-1" />
                        Add
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Add to Position</DialogTitle>
                        <DialogDescription>
                          Add more {position.symbol} to your existing {position.side} position
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-4 py-4">
                        <div className="space-y-2">
                          <Label htmlFor="quantity">Quantity to Add</Label>
                          <Input
                            id="quantity"
                            type="number"
                            step="0.001"
                            placeholder="0.00"
                            value={addQuantity}
                            onChange={(e) => setAddQuantity(e.target.value)}
                          />
                        </div>
                        <div className="text-sm text-muted-foreground">
                          Current Position: {position.quantity} @ ${position.entry_price.toFixed(2)}
                        </div>
                      </div>
                      <DialogFooter>
                        <Button
                          onClick={() => handleAddToPosition(position)}
                          disabled={addingToPosition === position.id || !addQuantity}
                        >
                          {addingToPosition === position.id ? 'Adding...' : 'Add to Position'}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>

                  {/* Close Position Button */}
                  <Button
                    variant="destructive"
                    size="sm"
                    className="flex-1"
                    onClick={() => handleClosePosition(position)}
                    disabled={closingPosition === position.id}
                  >
                    {closingPosition === position.id ? (
                      <RefreshCw className="h-3 w-3 mr-1 animate-spin" />
                    ) : (
                      <X className="h-3 w-3 mr-1" />
                    )}
                    Close
                  </Button>
                </div>
              </div>
            );
          })}
        </div>

        {/* Empty State */}
        {positions.length === 0 && (
          <div className="text-center py-8 text-muted-foreground">
            <DollarSign className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-sm">No open positions</p>
            <p className="text-xs mt-1">Positions will appear here when you execute trades</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
