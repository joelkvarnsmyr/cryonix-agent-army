'use client';

import {
    LineChart,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
    ReferenceLine
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@cryonix/ui';
import { format } from 'date-fns';

interface EquityCurveProps {
    data: Array<{ timestamp: string; equity: number }>;
    initialCapital?: number;
}

export function EquityCurveChart({ data, initialCapital = 10000 }: EquityCurveProps) {
    if (!data || data.length === 0) {
        return (
            <Card className="h-[400px] flex items-center justify-center">
                <div className="text-muted-foreground">No equity data available</div>
            </Card>
        );
    }

    // Format data for chart
    const chartData = data.map(d => ({
        date: new Date(d.timestamp).getTime(), // Use timestamp for XAxis
        equity: d.equity,
        formattedDate: format(new Date(d.timestamp), 'MMM d, HH:mm')
    }));

    const minEquity = Math.min(...chartData.map(d => d.equity)) * 0.99;
    const maxEquity = Math.max(...chartData.map(d => d.equity)) * 1.01;

    const CustomTooltip = ({ active, payload, label }: any) => {
        if (active && payload && payload.length) {
            return (
                <div className="bg-background border border-border p-2 rounded shadow-lg text-xs">
                    <p className="font-semibold">{format(label, 'PP pp')}</p>
                    <p className="text-primary font-mono">
                        ${payload[0].value.toFixed(2)}
                    </p>
                </div>
            );
        }
        return null;
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle>Equity Curve</CardTitle>
                <CardDescription>Account balance growth over time</CardDescription>
            </CardHeader>
            <CardContent>
                <div className="h-[350px] w-full">
                    <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={chartData}>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                            <XAxis
                                dataKey="date"
                                type="number"
                                domain={['dataMin', 'dataMax']}
                                scale="time"
                                tickFormatter={(unixTime) => format(unixTime, 'MM/dd')}
                                stroke="hsl(var(--muted-foreground))"
                                fontSize={12}
                                tickMargin={10}
                            />
                            <YAxis
                                domain={[minEquity, maxEquity]}
                                tickFormatter={(value) => `$${value}`}
                                stroke="hsl(var(--muted-foreground))"
                                fontSize={12}
                                width={60}
                            />
                            <Tooltip content={<CustomTooltip />} />
                            <ReferenceLine y={initialCapital} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" />
                            <Line
                                type="monotone"
                                dataKey="equity"
                                stroke="hsl(var(--primary))"
                                strokeWidth={2}
                                dot={false}
                                activeDot={{ r: 4 }}
                            />
                        </LineChart>
                    </ResponsiveContainer>
                </div>
            </CardContent>
        </Card>
    );
}
