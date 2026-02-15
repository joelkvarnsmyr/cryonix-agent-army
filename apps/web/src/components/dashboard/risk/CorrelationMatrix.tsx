'use client';

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@cryonix/ui';

interface CorrelationMatrixProps {
    correlations: Record<string, Record<string, number>>;
}

export function CorrelationMatrix({ correlations }: CorrelationMatrixProps) {
    const assets = Object.keys(correlations).sort();

    if (assets.length === 0) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle>Correlation Matrix</CardTitle>
                    <CardDescription>Asset price correlation analysis</CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="text-sm text-muted-foreground text-center py-4">
                        No open positions to correlate.
                    </div>
                </CardContent>
            </Card>
        );
    }

    const getColor = (value: number) => {
        // correlation is -1 to 1
        // > 0.7 RED (High risk)
        // 0.4 - 0.7 YELLOW (Medium risk)
        // < 0.4 GREEN (Low/Safe)
        // Negative correlation is generally good for hedging, so Green.

        if (value >= 0.7) return 'bg-red-500/20 text-red-700 dark:text-red-400';
        if (value >= 0.4) return 'bg-yellow-500/20 text-yellow-700 dark:text-yellow-400';
        return 'bg-green-500/20 text-green-700 dark:text-green-400';
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle>Correlation Matrix</CardTitle>
                <CardDescription>
                    Identify highly correlated assets to reduce risk exposure.
                    <br />
                    <span className="text-xs text-muted-foreground">
                        Values {'>'} 0.7 indicate high correlation.
                    </span>
                </CardDescription>
            </CardHeader>
            <CardContent>
                <div className="overflow-x-auto">
                    <table className="w-full text-xs text-center border-collapse">
                        <thead>
                            <tr>
                                <th className="p-2"></th>
                                {assets.map(asset => (
                                    <th key={asset} className="p-2 font-bold rotate-45">{asset}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {assets.map(rowAsset => (
                                <tr key={rowAsset}>
                                    <td className="p-2 font-bold text-left">{rowAsset}</td>
                                    {assets.map(colAsset => {
                                        const value = correlations[rowAsset]?.[colAsset] ?? 0;
                                        const isSelf = rowAsset === colAsset;

                                        return (
                                            <td key={colAsset} className="p-1">
                                                <div
                                                    className={`
                            rounded p-2 font-mono transition-colors
                            ${isSelf ? 'bg-muted opacity-50' : getColor(value)}
                          `}
                                                >
                                                    {isSelf ? '1.0' : value.toFixed(2)}
                                                </div>
                                            </td>
                                        );
                                    })}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </CardContent>
        </Card>
    );
}
