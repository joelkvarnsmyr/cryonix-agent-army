'use client';

import useSWR from 'swr';
import type { TradingSignal as Signal } from '@cryonix/types';

// Fetcher for SWR
const fetcher = (url: string) => fetch(url).then((res) => res.json());

interface TankState {
    status: string;
    lastActive: string;
    details: any;
}

export function useTankState() {
    // Poll every 2 seconds
    const { data: scoutState, error: scoutError } = useSWR<TankState>(
        '/api/tanks/status?id=MarketScout',
        fetcher,
        { refreshInterval: 2000 }
    );

    const { data: pendingTrades, mutate: refreshTrades } = useSWR<Signal[]>(
        '/api/tanks/approvals',
        fetcher,
        { refreshInterval: 2000 }
    );

    return {
        scout: {
            state: scoutState,
            isLoading: !scoutState && !scoutError,
            isError: scoutError,
        },
        pendingTrades: {
            data: pendingTrades || [],
            refresh: refreshTrades,
        },
    };
}
