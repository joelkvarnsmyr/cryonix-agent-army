'use client';

import { useTankState } from '@/hooks/useTankState';
import { Card, CardContent, CardHeader, CardTitle, Badge } from '@cryonix/ui';
import { Activity, Radio } from 'lucide-react';

export function TankMonitor() {
    const { scout } = useTankState();

    if (scout.isLoading) return <div>Connecting to Brain...</div>;
    if (scout.isError) return <div>Error connecting to Brain</div>;

    const status = scout.state?.status || 'offline';
    const isOnline = status !== 'offline';

    return (
        <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Engine Status (Python)</CardTitle>
                {isOnline ? (
                    <Radio className="h-4 w-4 text-green-500 animate-pulse" />
                ) : (
                    <Radio className="h-4 w-4 text-gray-500" />
                )}
            </CardHeader>
            <CardContent>
                <div className="text-2xl font-bold flex items-center gap-2">
                    {status.toUpperCase()}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                    Market Scout Tank
                </p>

                {/* Debug View */}
                <div className="mt-4 bg-black/50 p-2 rounded text-xs font-mono overflow-auto max-h-[100px]">
                    {JSON.stringify(scout.state, null, 2)}
                </div>
            </CardContent>
        </Card>
    );
}
