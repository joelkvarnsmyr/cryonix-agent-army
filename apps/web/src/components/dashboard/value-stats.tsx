'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, Badge } from "@cryonix/ui";
import { DollarSign, TrendingUp, Activity, Zap } from 'lucide-react';

interface ValueMetrics {
    totalApiCost: number;
    totalTradingProfit: number;
    netValueCreated: number;
    roi: number;
    requestCount: number;
}

export function ValueStats() {
    const [metrics, setMetrics] = useState<ValueMetrics>({
        totalApiCost: 0,
        totalTradingProfit: 0,
        netValueCreated: 0,
        roi: 0,
        requestCount: 0
    });

    // Simulate fetching / listening to WS updates in real implementation
    // For now, we mock the "Pulse" to show the UI
    useEffect(() => {
        const interval = setInterval(() => {
            // In a real app, this would fetch from an API route that queries the RoiTracker
            // For demo purposes, we simulate small incremental costs and potential profits
            setMetrics(prev => ({
                ...prev,
                totalApiCost: prev.totalApiCost + 0.00004, // Simulating a heartbeat cost
                // totalTradingProfit: prev.totalTradingProfit // This would update on trade close
            }));
        }, 5000);

        return () => clearInterval(interval);
    }, []);

    const isProfitable = metrics.netValueCreated >= 0;

    return (
        <Card className="border-cyan-500/30 bg-black/40 backdrop-blur-md">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-cyan-400 flex items-center gap-2">
                    <Activity className="h-4 w-4" />
                    Value Creation Engine
                </CardTitle>
                <Badge variant={isProfitable ? "default" : "destructive"} className="text-xs">
                    {isProfitable ? "VALUE ACCRETIVE" : "BURNING CAPITAL"}
                </Badge>
            </CardHeader>
            <CardContent>
                <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">Net Value Created</p>
                        <div className={`text-2xl font-bold ${isProfitable ? 'text-green-400' : 'text-red-400'}`}>
                            ${metrics.netValueCreated.toFixed(4)}
                        </div>
                        <div className="text-xs text-muted-foreground flex items-center gap-1">
                            ROI: <span className={metrics.roi >= 0 ? 'text-green-400' : 'text-red-400'}>
                                {metrics.roi.toFixed(1)}%
                            </span>
                        </div>
                    </div>
                    <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">Operating Costs (API)</p>
                        <div className="text-2xl font-bold text-orange-400">
                            ${metrics.totalApiCost.toFixed(5)}
                        </div>
                        <div className="text-xs text-muted-foreground flex items-center gap-1">
                            <Zap className="h-3 w-3" /> {metrics.requestCount} AI Actions
                        </div>
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}
