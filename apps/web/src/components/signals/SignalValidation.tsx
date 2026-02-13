'use client';

import { Card, CardContent, CardHeader, CardTitle, Badge, Progress } from '@cryonix/ui';
import { TrendingUp, TrendingDown, Minus, AlertTriangle, CheckCircle2, Clock } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import type { SourceVote, TechnicalIndicators, MarketStructure, ValidationDetails } from './types';

interface SignalValidationProps {
    validation: ValidationDetails;
    votes: SourceVote[];
    technicalIndicators: TechnicalIndicators;
    marketStructure: MarketStructure;
    compact?: boolean;
}

export function SignalValidation({
    validation,
    votes,
    technicalIndicators,
    marketStructure,
    compact = false,
}: SignalValidationProps) {
    // Format source name for display
    const formatSourceName = (source: string): string => {
        return source
            .split('_')
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    };

    // Get action icon
    const getActionIcon = (action: 'BUY' | 'SELL' | 'WAIT') => {
        switch (action) {
            case 'BUY':
                return <TrendingUp className="w-4 h-4 text-green-500" />;
            case 'SELL':
                return <TrendingDown className="w-4 h-4 text-red-500" />;
            case 'WAIT':
                return <Minus className="w-4 h-4 text-yellow-500" />;
        }
    };

    // Get action color
    const getActionColor = (action: 'BUY' | 'SELL' | 'WAIT'): string => {
        switch (action) {
            case 'BUY':
                return '#22c55e';
            case 'SELL':
                return '#ef4444';
            case 'WAIT':
                return '#eab308';
        }
    };

    // Get risk color
    const getRiskColor = (risk: 'low' | 'medium' | 'high' | 'extreme'): string => {
        switch (risk) {
            case 'low':
                return 'bg-green-500';
            case 'medium':
                return 'bg-yellow-500';
            case 'high':
                return 'bg-orange-500';
            case 'extreme':
                return 'bg-red-500';
        }
    };

    // Get timing color
    const getTimingColor = (timing: 'excellent' | 'good' | 'fair' | 'poor'): string => {
        switch (timing) {
            case 'excellent':
                return 'bg-green-500';
            case 'good':
                return 'bg-blue-500';
            case 'fair':
                return 'bg-yellow-500';
            case 'poor':
                return 'bg-red-500';
        }
    };

    // Prepare chart data for source votes
    const chartData = votes.map((vote) => ({
        name: formatSourceName(vote.source),
        confidence: vote.confidence * 100,
        action: vote.action,
    }));

    return (
        <div className={`space-y-4 ${compact ? 'text-sm' : ''}`}>
            {/* Validation Header */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    {validation.isValid ? (
                        <>
                            <CheckCircle2 className="w-5 h-5 text-green-500" />
                            <span className="font-semibold text-green-500">Signal Validated</span>
                        </>
                    ) : (
                        <>
                            <AlertTriangle className="w-5 h-5 text-red-500" />
                            <span className="font-semibold text-red-500">Validation Failed</span>
                        </>
                    )}
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Clock className="w-3 h-3" />
                    <span>{validation.processingTimeMs}ms</span>
                </div>
            </div>

            {/* Consensus & Confidence */}
            <div className="grid grid-cols-2 gap-4">
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm">Consensus Level</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="space-y-2">
                            <div className="text-2xl font-bold">
                                {(validation.consensusLevel * 100).toFixed(0)}%
                            </div>
                            <Progress
                                value={validation.consensusLevel * 100}
                                className="h-2"
                            />
                        </div>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm">Validated Confidence</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="space-y-2">
                            <div className="text-2xl font-bold">
                                {(validation.validatedConfidence * 100).toFixed(0)}%
                            </div>
                            <Progress
                                value={validation.validatedConfidence * 100}
                                className="h-2"
                            />
                        </div>
                    </CardContent>
                </Card>
            </div>

            {/* Source Votes Visualization */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-sm">Source Votes</CardTitle>
                </CardHeader>
                <CardContent>
                    <ResponsiveContainer width="100%" height={compact ? 150 : 200}>
                        <BarChart data={chartData}>
                            <XAxis
                                dataKey="name"
                                tick={{ fontSize: 10 }}
                                angle={-45}
                                textAnchor="end"
                                height={60}
                            />
                            <YAxis tick={{ fontSize: 10 }} />
                            <Tooltip
                                content={({ active, payload }) => {
                                    if (active && payload && payload.length) {
                                        const data = payload[0].payload;
                                        return (
                                            <div className="bg-background border border-border rounded-lg p-2 shadow-lg">
                                                <div className="font-semibold">{data.name}</div>
                                                <div className="flex items-center gap-2 mt-1">
                                                    {getActionIcon(data.action)}
                                                    <span>{data.action}</span>
                                                </div>
                                                <div className="text-sm text-muted-foreground">
                                                    Confidence: {data.confidence.toFixed(1)}%
                                                </div>
                                            </div>
                                        );
                                    }
                                    return null;
                                }}
                            />
                            <Bar dataKey="confidence" radius={[4, 4, 0, 0]}>
                                {chartData.map((entry, index) => (
                                    <Cell key={`cell-${index}`} fill={getActionColor(entry.action)} />
                                ))}
                            </Bar>
                        </BarChart>
                    </ResponsiveContainer>
                </CardContent>
            </Card>

            {/* Sentiment Gauge */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-sm">Market Sentiment</CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="space-y-3">
                        <div>
                            <div className="flex justify-between text-xs mb-1">
                                <span className="text-green-500">Bullish</span>
                                <span className="font-semibold">{(validation.bullishSentiment * 100).toFixed(0)}%</span>
                            </div>
                            <Progress value={validation.bullishSentiment * 100} className="h-2 bg-muted" />
                        </div>
                        <div>
                            <div className="flex justify-between text-xs mb-1">
                                <span className="text-red-500">Bearish</span>
                                <span className="font-semibold">{(validation.bearishSentiment * 100).toFixed(0)}%</span>
                            </div>
                            <Progress value={validation.bearishSentiment * 100} className="h-2 bg-muted" />
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* Risk & Timing */}
            <div className="grid grid-cols-2 gap-4">
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm">Risk Level</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <Badge className={`${getRiskColor(validation.riskLevel)} text-white mb-2`}>
                            {validation.riskLevel.toUpperCase()}
                        </Badge>
                        {validation.riskFactors.length > 0 && (
                            <div className="text-xs text-muted-foreground space-y-1 mt-2">
                                {validation.riskFactors.map((factor, i) => (
                                    <div key={i} className="flex items-start gap-1">
                                        <span>•</span>
                                        <span>{factor}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm">Entry Timing</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <Badge className={`${getTimingColor(validation.entryTiming)} text-white mb-2`}>
                            {validation.entryTiming.toUpperCase()}
                        </Badge>
                        <div className="text-xs text-muted-foreground mt-2">
                            {validation.timingReasoning}
                        </div>
                    </CardContent>
                </Card>
            </div>

            {!compact && (
                <>
                    {/* Technical Indicators Snapshot */}
                    <Card>
                        <CardHeader>
                            <CardTitle className="text-sm">Technical Indicators</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
                                <div className="p-2 bg-muted rounded">
                                    <div className="text-muted-foreground">RSI (14)</div>
                                    <div className={`font-semibold ${technicalIndicators.rsi14 > 70 ? 'text-red-500' :
                                        technicalIndicators.rsi14 < 30 ? 'text-green-500' : ''
                                        }`}>
                                        {technicalIndicators.rsi14.toFixed(1)}
                                    </div>
                                </div>
                                <div className="p-2 bg-muted rounded">
                                    <div className="text-muted-foreground">MACD</div>
                                    <div className={`font-semibold ${technicalIndicators.macdHistogram > 0 ? 'text-green-500' : 'text-red-500'
                                        }`}>
                                        {technicalIndicators.macd.toFixed(2)}
                                    </div>
                                </div>
                                <div className="p-2 bg-muted rounded">
                                    <div className="text-muted-foreground">Volume Ratio</div>
                                    <div className="font-semibold">
                                        {technicalIndicators.volumeRatio.toFixed(2)}x
                                    </div>
                                </div>
                                <div className="p-2 bg-muted rounded">
                                    <div className="text-muted-foreground">SMA 20</div>
                                    <div className="font-semibold">
                                        ${technicalIndicators.sma20.toFixed(2)}
                                    </div>
                                </div>
                                <div className="p-2 bg-muted rounded">
                                    <div className="text-muted-foreground">SMA 50</div>
                                    <div className="font-semibold">
                                        ${technicalIndicators.sma50.toFixed(2)}
                                    </div>
                                </div>
                                <div className="p-2 bg-muted rounded">
                                    <div className="text-muted-foreground">ATR (14)</div>
                                    <div className="font-semibold">
                                        ${technicalIndicators.atr14.toFixed(2)}
                                    </div>
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    {/* Market Structure */}
                    <Card>
                        <CardHeader>
                            <CardTitle className="text-sm">Market Structure</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="grid grid-cols-2 gap-3 text-xs">
                                <div>
                                    <div className="text-muted-foreground">Trend</div>
                                    <div className="font-semibold capitalize flex items-center gap-2">
                                        {marketStructure.trend === 'uptrend' && <TrendingUp className="w-4 h-4 text-green-500" />}
                                        {marketStructure.trend === 'downtrend' && <TrendingDown className="w-4 h-4 text-red-500" />}
                                        {marketStructure.trend === 'sideways' && <Minus className="w-4 h-4 text-yellow-500" />}
                                        {marketStructure.trend}
                                    </div>
                                </div>
                                <div>
                                    <div className="text-muted-foreground">Trend Strength</div>
                                    <div className="font-semibold">
                                        {(marketStructure.trendStrength * 100).toFixed(0)}%
                                    </div>
                                </div>
                                <div>
                                    <div className="text-muted-foreground">Volatility</div>
                                    <div className="font-semibold capitalize">{marketStructure.volatilityState}</div>
                                </div>
                                <div>
                                    <div className="text-muted-foreground">Volume</div>
                                    <div className="font-semibold capitalize">{marketStructure.volumeState}</div>
                                </div>
                                <div>
                                    <div className="text-muted-foreground">Support</div>
                                    <div className="font-semibold text-green-500">
                                        ${marketStructure.nearestSupport.toFixed(2)}
                                    </div>
                                </div>
                                <div>
                                    <div className="text-muted-foreground">Resistance</div>
                                    <div className="font-semibold text-red-500">
                                        ${marketStructure.nearestResistance.toFixed(2)}
                                    </div>
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                </>
            )}
        </div>
    );
}
