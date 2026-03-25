'use client';

import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@cryonix/ui';
import { getMonth, getYear } from 'date-fns';

interface MonthlyHeatmapProps {
    data: Array<{ timestamp: string; equity: number }>;
}

export function MonthlyHeatmap({ data }: MonthlyHeatmapProps) {
    const monthlyReturns = useMemo(() => {
        if (!data || data.length < 2) return [];

        const returns: Record<string, { start: number; end: number; year: number; month: number }> = {};

        // Group by month
        // Note: This logic assumes data is sorted by timestamp asc
        data.forEach((point) => {
            const date = new Date(point.timestamp);
            // Valid date?
            if (isNaN(date.getTime())) return;

            const key = `${getYear(date)}-${getMonth(date)}`;

            if (!returns[key]) {
                returns[key] = {
                    start: point.equity,
                    end: point.equity,
                    year: getYear(date),
                    month: getMonth(date)
                };
            } else {
                returns[key].end = point.equity;
            }
        });

        return Object.values(returns).map(m => ({
            year: m.year,
            month: m.month,
            returnPct: ((m.end - m.start) / m.start) * 100
        })).sort((a, b) => (b.year - a.year) || (b.month - a.month));

    }, [data]);

    if (monthlyReturns.length === 0) {
        return (
            <Card className="flex items-center justify-center p-6">
                <div className="text-muted-foreground">Not enough data for monthly analysis</div>
            </Card>
        );
    }

    // Get unique years
    const years = Array.from(new Set(monthlyReturns.map(r => r.year))).sort((a, b) => b - a);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    const getReturnFor = (year: number, monthIdx: number) => {
        return monthlyReturns.find(r => r.year === year && r.month === monthIdx);
    };

    const getColor = (val: number) => {
        if (val === 0) return 'bg-muted';
        if (val > 0) {
            if (val > 20) return 'bg-emerald-600 text-white';
            if (val > 10) return 'bg-emerald-500 text-white';
            if (val > 5) return 'bg-emerald-400 text-white';
            return 'bg-emerald-200 text-emerald-900';
        } else {
            if (val < -20) return 'bg-rose-600 text-white';
            if (val < -10) return 'bg-rose-500 text-white';
            if (val < -5) return 'bg-rose-400 text-white';
            return 'bg-rose-200 text-rose-900';
        }
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle>Monthly Returns</CardTitle>
                <CardDescription>Performance by month</CardDescription>
            </CardHeader>
            <CardContent>
                <div className="overflow-x-auto">
                    <table className="w-full text-xs text-center border-collapse">
                        <thead>
                            <tr>
                                <th className="p-2 text-left font-semibold">Year</th>
                                {months.map(m => <th key={m} className="p-2 font-medium text-muted-foreground">{m}</th>)}
                                <th className="p-2 font-semibold">YTD</th>
                            </tr>
                        </thead>
                        <tbody>
                            {years.map(year => {
                                const yearReturns = monthlyReturns.filter(r => r.year === year);
                                // Simplify YTD as sum of monthly returns (approximation - technically should be compounded)
                                // (1+r1)*(1+r2)... - 1
                                const ytd = (yearReturns.reduce((acc, curr) => acc * (1 + curr.returnPct / 100), 1) - 1) * 100;

                                return (
                                    <tr key={year} className="border-t border-border">
                                        <td className="p-2 text-left font-bold">{year}</td>
                                        {months.map((_, monthIdx) => {
                                            const data = getReturnFor(year, monthIdx);
                                            return (
                                                <td key={monthIdx} className="p-1">
                                                    {data ? (
                                                        <div className={`rounded p-2 font-mono ${getColor(data.returnPct)}`}>
                                                            {data.returnPct > 0 ? '+' : ''}{data.returnPct.toFixed(1)}%
                                                        </div>
                                                    ) : (
                                                        <div className="text-muted-foreground">-</div>
                                                    )}
                                                </td>
                                            );
                                        })}
                                        <td className={`p-2 font-bold ${ytd >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                            {ytd > 0 ? '+' : ''}{ytd.toFixed(1)}%
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </CardContent>
        </Card>
    );
}
