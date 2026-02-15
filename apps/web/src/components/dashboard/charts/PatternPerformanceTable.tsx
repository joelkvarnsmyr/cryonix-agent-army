'use client';

import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription, Badge } from '@cryonix/ui';

interface Trade {
    side: string;
    entry_price: number;
    exit_price: number;
    pnl: number;
    exit_reason: string;
    pattern?: string;
}

interface PatternPerformanceTableProps {
    trades: Array<Trade>;
}

interface PatternStats {
    pattern: string;
    count: number;
    wins: number;
    losses: number;
    totalPnl: number;
}

export function PatternPerformanceTable({ trades }: PatternPerformanceTableProps) {
    const stats = useMemo(() => {
        if (!trades || trades.length === 0) return [];

        const patternMap: Record<string, PatternStats> = {};

        trades.forEach(trade => {
            const pattern = trade.pattern || 'Unknown';

            if (!patternMap[pattern]) {
                patternMap[pattern] = {
                    pattern,
                    count: 0,
                    wins: 0,
                    losses: 0,
                    totalPnl: 0
                };
            }

            const p = patternMap[pattern];
            p.count++;
            p.totalPnl += trade.pnl;
            if (trade.pnl > 0) p.wins++;
            else p.losses++;
        });

        return Object.values(patternMap)
            .map(p => ({
                ...p,
                winRate: (p.wins / p.count) * 100,
                avgPnl: p.totalPnl / p.count,
                profitFactor: Math.abs(p.losses) > 0 ? (p.totalPnl + Math.abs(p.totalPnl)) / Math.abs(p.totalPnl) : 99 // Simplified logic, real PF needs gross profit / gross loss
            }))
            .sort((a, b) => b.totalPnl - a.totalPnl);
    }, [trades]);

    if (stats.length === 0) return null;

    return (
        <Card>
            <CardHeader>
                <CardTitle>Pattern Performance</CardTitle>
                <CardDescription>Breakdown of strategy performance by pattern</CardDescription>
            </CardHeader>
            <CardContent>
                <div className="overflow-x-auto">
                    <table className="w-full text-sm text-left">
                        <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                            <tr>
                                <th className="p-3 rounded-tl">Pattern</th>
                                <th className="p-3 text-right">Trades</th>
                                <th className="p-3 text-right">Win Rate</th>
                                <th className="p-3 text-right">Total PnL</th>
                                <th className="p-3 text-right rounded-tr">Avg PnL</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {stats.map((stat) => (
                                <tr key={stat.pattern} className="hover:bg-muted/20">
                                    <td className="p-3 font-medium capitalize">
                                        {stat.pattern.replace(/_/g, ' ')}
                                    </td>
                                    <td className="p-3 text-right font-mono">{stat.count}</td>
                                    <td className="p-3 text-right">
                                        <div className="flex items-center justify-end gap-2">
                                            <span className={stat.winRate >= 50 ? 'text-green-600' : 'text-red-600'}>
                                                {stat.winRate.toFixed(1)}%
                                            </span>
                                            <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
                                                <div
                                                    className={`h-full ${stat.winRate >= 50 ? 'bg-green-500' : 'bg-red-500'}`}
                                                    style={{ width: `${stat.winRate}%` }}
                                                />
                                            </div>
                                        </div>
                                    </td>
                                    <td className={`p-3 text-right font-bold ${stat.totalPnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                        {stat.totalPnl >= 0 ? '+' : '-'}${Math.abs(stat.totalPnl).toFixed(2)}
                                    </td>
                                    <td className={`p-3 text-right ${stat.avgPnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                        {stat.avgPnl >= 0 ? '+' : '-'}${Math.abs(stat.avgPnl).toFixed(2)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </CardContent>
        </Card>
    );
}
