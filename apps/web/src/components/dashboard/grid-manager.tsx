"use client";

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, Badge } from '@cryonix/ui';
import { Grid3X3, Circle, CheckCircle, XCircle, RefreshCw } from 'lucide-react';

interface GridConfig {
  symbol: string;
  lowerBound: number;
  upperBound: number;
  buyLevels: number[];
  tpTargets: number[];
  orderSizeUsd: number;
  status: 'active' | 'completed' | 'cancelled';
  filledLevels: number[];
  reasoning: string;
  createdAt: string;
  expiresAt: string;
}

export function GridManager() {
  const [grids, setGrids] = useState<GridConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetchGrids();
    const interval = setInterval(fetchGrids, 30_000);
    return () => clearInterval(interval);
  }, []);

  async function fetchGrids() {
    try {
      const res = await fetch('/api/grid-config');
      if (res.ok) {
        const data = await res.json();
        setGrids(data.grids || []);
      }
    } catch (e) {
      console.error('Failed to fetch grids:', e);
    } finally {
      setLoading(false);
    }
  }

  async function createGrid(symbol: string) {
    setCreating(true);
    try {
      const res = await fetch('/api/grid-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, budgetUsd: 12 }),
      });
      if (res.ok) {
        await fetchGrids();
      }
    } catch (e) {
      console.error('Failed to create grid:', e);
    } finally {
      setCreating(false);
    }
  }

  async function cancelGrid(symbol: string) {
    try {
      const res = await fetch(`/api/grid-config?symbol=${encodeURIComponent(symbol)}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        await fetchGrids();
      }
    } catch (e) {
      console.error('Failed to cancel grid:', e);
    }
  }

  function getStatusColor(status: string): string {
    switch (status) {
      case 'active': return 'bg-green-500/20 text-green-400';
      case 'completed': return 'bg-blue-500/20 text-blue-400';
      case 'cancelled': return 'bg-red-500/20 text-red-400';
      default: return 'bg-muted text-muted-foreground';
    }
  }

  function getTimeRemaining(expiresAt: string): string {
    const diff = new Date(expiresAt).getTime() - Date.now();
    if (diff <= 0) return 'Expired';
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    return `${hours}h ${mins}m`;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            <Grid3X3 className="h-4 w-4 text-purple-500" />
            Grid Trading
          </span>
          <div className="flex items-center gap-2">
            <Badge variant="outline">{grids.filter(g => g.status === 'active').length} active</Badge>
            {grids.length === 0 && !creating && (
              <button
                onClick={() => createGrid('BTC/USDC')}
                className="text-xs px-2 py-1 rounded bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 transition-colors"
              >
                + New Grid
              </button>
            )}
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading && (
          <p className="text-sm text-muted-foreground">Loading...</p>
        )}

        {creating && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <RefreshCw className="h-4 w-4 animate-spin" />
            Creating grid (LLM analyzing range)...
          </div>
        )}

        {!loading && grids.length === 0 && !creating && (
          <div className="text-sm text-muted-foreground text-center py-4">
            <Grid3X3 className="h-8 w-8 mx-auto mb-2 opacity-30" />
            <p>No active grids</p>
            <p className="text-xs mt-1">Create a grid to start ladder buying in a range</p>
          </div>
        )}

        {grids.map((grid) => (
          <div
            key={grid.symbol}
            className="rounded-lg border border-border bg-card p-3 space-y-3"
          >
            {/* Header */}
            <div className="flex items-center justify-between">
              <span className="font-bold text-sm">{grid.symbol}</span>
              <div className="flex items-center gap-2">
                <Badge className={getStatusColor(grid.status)}>{grid.status}</Badge>
                {grid.status === 'active' && (
                  <button
                    onClick={() => cancelGrid(grid.symbol)}
                    className="text-xs text-red-400 hover:text-red-300"
                  >
                    Cancel
                  </button>
                )}
              </div>
            </div>

            {/* Range bar */}
            <div className="text-xs">
              <div className="flex justify-between text-muted-foreground mb-1">
                <span>${grid.lowerBound.toLocaleString()}</span>
                <span>${grid.upperBound.toLocaleString()}</span>
              </div>
              <div className="h-2 bg-muted rounded-full relative">
                {grid.buyLevels.map((level, i) => {
                  const pct = ((level - grid.lowerBound) / (grid.upperBound - grid.lowerBound)) * 100;
                  const isFilled = grid.filledLevels.includes(i);
                  return (
                    <div
                      key={i}
                      className="absolute top-1/2 -translate-y-1/2"
                      style={{ left: `${Math.min(100, Math.max(0, pct))}%` }}
                    >
                      {isFilled ? (
                        <CheckCircle className="h-3 w-3 text-green-500 -ml-1.5" />
                      ) : (
                        <Circle className="h-3 w-3 text-purple-500 -ml-1.5" />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Level details */}
            <div className="space-y-1">
              {grid.buyLevels.map((level, i) => {
                const isFilled = grid.filledLevels.includes(i);
                return (
                  <div
                    key={i}
                    className={`flex items-center justify-between text-xs ${isFilled ? 'text-green-400' : 'text-muted-foreground'}`}
                  >
                    <span className="flex items-center gap-1">
                      {isFilled ? (
                        <CheckCircle className="h-3 w-3" />
                      ) : (
                        <Circle className="h-3 w-3" />
                      )}
                      Level #{i}: ${level.toLocaleString()}
                    </span>
                    <span>TP: ${grid.tpTargets[i]?.toLocaleString()}</span>
                  </div>
                );
              })}
            </div>

            {/* Footer */}
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>${grid.orderSizeUsd}/level</span>
              <span>{grid.filledLevels.length}/{grid.buyLevels.length} filled</span>
              {grid.status === 'active' && (
                <span>{getTimeRemaining(grid.expiresAt)} left</span>
              )}
            </div>

            {/* LLM reasoning */}
            {grid.reasoning && (
              <p className="text-xs text-muted-foreground italic border-t border-border pt-2">
                {grid.reasoning}
              </p>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
