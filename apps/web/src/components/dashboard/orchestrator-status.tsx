"use client";

import { Card, CardContent, CardHeader, CardTitle } from '@cryonix/ui';
import { Activity, Play, Square, AlertTriangle, CheckCircle2, XCircle, Loader2, Wifi } from 'lucide-react';
import { useState, useEffect } from 'react';
import { useWebSocket } from '@/hooks/use-websocket';

interface OrchestratorStatus {
    status: string;
    isRunning: boolean;
    enableAutoTrading: boolean;
    emergencyStop: boolean;
    registeredAgents: Array<{
        id: string;
        name: string;
        status: string;
    }>;
    lastScanTime: string | null;
    dailyPnL: number;
    dailyPnLPercent: number;
    portfolioValue: number;
}

export function OrchestratorStatus() {
    const [status, setStatus] = useState<OrchestratorStatus | null>(null);
    const { isConnected } = useWebSocket();
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [actionLoading, setActionLoading] = useState<'start' | 'stop' | null>(null);

    const fetchStatus = async () => {
        try {
            setError(null);
            const response = await fetch('/api/orchestrator/status');
            if (!response.ok) {
                throw new Error('Failed to fetch orchestrator status');
            }
            const data = await response.json();
            if (data.success) {
                setStatus(data.data);
            } else {
                setError(data.error || 'Unknown error');
            }
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    const handleStart = async () => {
        try {
            setActionLoading('start');
            setError(null);
            const response = await fetch('/api/orchestrator/start', {
                method: 'POST',
            });
            const data = await response.json();
            if (!data.success) {
                throw new Error(data.error || 'Failed to start orchestrator');
            }
            await fetchStatus();
        } catch (err: any) {
            setError(err.message);
        } finally {
            setActionLoading(null);
        }
    };

    const handleStop = async () => {
        try {
            setActionLoading('stop');
            setError(null);
            const response = await fetch('/api/orchestrator/stop', {
                method: 'POST',
            });
            const data = await response.json();
            if (!data.success) {
                throw new Error(data.error || 'Failed to stop orchestrator');
            }
            await fetchStatus();
        } catch (err: any) {
            setError(err.message);
        } finally {
            setActionLoading(null);
        }
    };

    useEffect(() => {
        fetchStatus();

        // Refresh every 5 seconds
        const interval = setInterval(fetchStatus, 5000);
        return () => clearInterval(interval);
    }, []);

    if (loading && !status) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <Activity className="h-5 w-5" />
                        Orchestrator
                    </CardTitle>
                </CardHeader>
                <CardContent className="flex items-center justify-center py-8">
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                </CardContent>
            </Card>
        );
    }

    const getStatusColor = (agentStatus: string) => {
        switch (agentStatus) {
            case 'running':
                return 'text-green-500';
            case 'idle':
                return 'text-gray-500';
            case 'error':
                return 'text-red-500';
            default:
                return 'text-gray-400';
        }
    };

    const getStatusIcon = (agentStatus: string) => {
        switch (agentStatus) {
            case 'running':
                return <CheckCircle2 className="h-4 w-4" />;
            case 'error':
                return <XCircle className="h-4 w-4" />;
            default:
                return <Activity className="h-4 w-4" />;
        }
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <Activity className="h-5 w-5" />
                        Orchestrator
                    </div>
                    <div className="flex items-center gap-2">
                        {/* WebSocket Status */}
                        <div className={`p-1.5 rounded-full ${isConnected ? 'bg-green-100 text-green-600 dark:bg-green-900/30' : 'bg-red-100 text-red-600 dark:bg-red-900/30'}`} title={isConnected ? "WebSocket Connected" : "WebSocket Disconnected"}>
                            <Wifi className="h-3 w-3" />
                        </div>

                        {status?.isRunning ? (
                            <span className="flex items-center gap-1 text-xs text-green-500">
                                <span className="relative flex h-2 w-2">
                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                                    <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                                </span>
                                Running
                            </span>
                        ) : (
                            <span className="text-xs text-gray-500">Stopped</span>
                        )}
                    </div>
                </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
                {/* Error Message */}
                {error && (
                    <div className="text-xs bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 p-2 rounded">
                        {error}
                    </div>
                )}

                {/* Emergency Stop Warning */}
                {status?.emergencyStop && (
                    <div className="flex items-center gap-2 text-xs bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 p-2 rounded">
                        <AlertTriangle className="h-4 w-4" />
                        <span className="font-semibold">Emergency Stop Triggered!</span>
                    </div>
                )}

                {/* Auto-Trading Status */}
                <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Auto-Trading</span>
                    <span className={status?.enableAutoTrading ? 'text-green-500 font-semibold' : 'text-gray-500'}>
                        {status?.enableAutoTrading ? '✅ ENABLED' : '⚠️ DISABLED'}
                    </span>
                </div>

                {/* Daily P&L */}
                {status && status.dailyPnL !== undefined && (
                    <div className="space-y-1">
                        <span className="text-xs text-muted-foreground">Daily P&L</span>
                        <div className="flex items-baseline gap-2">
                            <span className={`text-xl font-bold ${status.dailyPnL >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                                ${status.dailyPnL.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                            <span className={`text-sm ${status.dailyPnLPercent >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                                ({status.dailyPnLPercent >= 0 ? '+' : ''}{status.dailyPnLPercent.toFixed(2)}%)
                            </span>
                        </div>
                    </div>
                )}

                {/* Registered Agents */}
                {status?.registeredAgents && status.registeredAgents.length > 0 && (
                    <div className="space-y-2">
                        <p className="text-xs font-medium text-muted-foreground">Registered Agents</p>
                        <div className="space-y-1">
                            {status.registeredAgents.map((agent) => (
                                <div key={agent.id} className="flex items-center justify-between text-xs">
                                    <span className="font-medium">{agent.name}</span>
                                    <div className={`flex items-center gap-1 ${getStatusColor(agent.status)}`}>
                                        {getStatusIcon(agent.status)}
                                        <span className="capitalize">{agent.status}</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Last Scan Time */}
                {status?.lastScanTime && (
                    <div className="text-xs text-muted-foreground">
                        Last scan: {new Date(status.lastScanTime).toLocaleTimeString()}
                    </div>
                )}

                {/* Control Buttons */}
                <div className="flex gap-2 pt-2">
                    {!status?.isRunning ? (
                        <button
                            onClick={handleStart}
                            disabled={actionLoading === 'start'}
                            className="flex-1 flex items-center justify-center gap-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-400 text-white text-sm font-medium py-2 px-4 rounded transition-colors"
                        >
                            {actionLoading === 'start' ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <Play className="h-4 w-4" />
                            )}
                            Start
                        </button>
                    ) : (
                        <button
                            onClick={handleStop}
                            disabled={actionLoading === 'stop'}
                            className="flex-1 flex items-center justify-center gap-2 bg-red-600 hover:bg-red-700 disabled:bg-gray-400 text-white text-sm font-medium py-2 px-4 rounded transition-colors"
                        >
                            {actionLoading === 'stop' ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <Square className="h-4 w-4" />
                            )}
                            Stop
                        </button>
                    )}
                </div>

                {/* Safety Notice */}
                {!status?.enableAutoTrading && (
                    <div className="text-xs text-muted-foreground text-center pt-2 border-t">
                        ⚠️ Trades will be logged for manual review
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
