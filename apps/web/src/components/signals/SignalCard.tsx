'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription, Badge, Button } from '@cryonix/ui';
import { ChevronDown, ChevronUp, ExternalLink, ShieldCheck, ShieldAlert } from 'lucide-react';
import { SignalValidation } from './SignalValidation';
import type { TradingSignal } from '@cryonix/types';
import type { FullValidationResponse } from './types';
import { format } from 'date-fns';

interface SignalCardProps {
    signal: TradingSignal;
    validationData?: FullValidationResponse | null;
    onValidate?: (signal: TradingSignal) => void;
    validating?: boolean;
}

export function SignalCard({ signal, validationData, onValidate, validating = false }: SignalCardProps) {
    const [expanded, setExpanded] = useState(false);

    const validation = validationData?.validation;

    // Helper to format price
    const formatPrice = (price?: number) => {
        if (!price) return 'N/A';
        return price < 1 ? price.toFixed(6) : price.toFixed(2);
    };

    // Get status color for badge
    const getStatusColor = () => {
        if (!validation) return 'bg-gray-500';
        return validation.isValid ? 'bg-green-500' : 'bg-red-500';
    };

    return (
        <Card className="border-l-4 border-l-primary">
            <CardHeader className="pb-3">
                <div className="flex justify-between items-start">
                    <div>
                        <div className="flex items-center gap-2 mb-1">
                            <CardTitle className="text-lg">{signal.symbol}</CardTitle>
                            <Badge variant={signal.action === 'BUY' ? 'default' : 'destructive'}>
                                {signal.action}
                            </Badge>
                            {validation && (
                                <Badge className={`${getStatusColor()} text-white flex gap-1 items-center`}>
                                    {validation.isValid ? <ShieldCheck className="w-3 h-3" /> : <ShieldAlert className="w-3 h-3" />}
                                    {validation.isValid ? 'VALIDATED' : 'REJECTED'}
                                </Badge>
                            )}
                        </div>
                        <CardDescription className="flex items-center gap-2">
                            <span>{format(new Date(signal.timestamp), 'HH:mm:ss')}</span>
                            <span>•</span>
                            <span className="capitalize">{signal.pattern.replace('_', ' ')}</span>
                        </CardDescription>
                    </div>

                    <div className="flex gap-2">
                        {!validation && onValidate && (
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={() => onValidate(signal)}
                                disabled={validating}
                            >
                                {validating ? 'Validating...' : 'Validate'}
                            </Button>
                        )}
                        <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => setExpanded(!expanded)}
                        >
                            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </Button>
                    </div>
                </div>

                {/* Quick Stats */}
                <div className="grid grid-cols-3 gap-2 mt-4 text-sm">
                    <div className="bg-muted/50 p-2 rounded">
                        <div className="text-muted-foreground text-xs">Entry</div>
                        <div className="font-mono">{formatPrice(validation?.adjustedPrices?.entry || signal.entry_price)}</div>
                    </div>
                    <div className="bg-muted/50 p-2 rounded">
                        <div className="text-muted-foreground text-xs">Target</div>
                        <div className="font-mono text-green-500">
                            {formatPrice(validation?.adjustedPrices?.target || signal.target_price)}
                        </div>
                    </div>
                    <div className="bg-muted/50 p-2 rounded">
                        <div className="text-muted-foreground text-xs">Stop</div>
                        <div className="font-mono text-red-500">
                            {formatPrice(validation?.adjustedPrices?.stopLoss || signal.stop_loss)}
                        </div>
                    </div>
                </div>
            </CardHeader>

            {expanded && (
                <CardContent className="pt-0 border-t">
                    {validationData ? (
                        <div className="mt-4">
                            <SignalValidation
                                validation={validationData.validation}
                                votes={validationData.votes}
                                technicalIndicators={validationData.technicalIndicators}
                                marketStructure={validationData.marketStructure}
                                compact={true}
                            />
                        </div>
                    ) : (
                        <div className="mt-4 text-center text-muted-foreground text-sm py-4">
                            Run validation to see detailed analysis
                        </div>
                    )}

                    <div className="mt-4 space-y-2">
                        <div className="text-xs font-semibold uppercase text-muted-foreground">Original Reasoning</div>
                        <ul className="text-sm space-y-1 list-disc pl-4 text-muted-foreground">
                            {signal.reasoning.map((reason, i) => (
                                <li key={i}>{reason}</li>
                            ))}
                        </ul>
                    </div>
                </CardContent>
            )}
        </Card>
    );
}
