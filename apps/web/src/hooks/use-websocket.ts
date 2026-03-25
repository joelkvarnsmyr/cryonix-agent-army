import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import type {
    TradingSignal,
    WSEventType,
    WSPriceData,
    WSTradeData,
    WSAlertData,
    Position,
    AgentStatus,
} from '@cryonix/types';

// ============================================================================
// TYPES
// ============================================================================

export interface WebSocketMessage {
    type: string;
    data?: Record<string, any>;
    timestamp?: number;
}

export interface WSConnectionStatus {
    connected: boolean;
    clientId: string | null;
    subscribedRooms: string[];
    serverTime: number | null;
}

export interface WSRealTimeState {
    signals: TradingSignal[];
    prices: Record<string, WSPriceData>;
    trades: WSTradeData[];
    positions: Position[];
    alerts: WSAlertData[];
    agentStatuses: Record<string, AgentStatus>;
}

type EventHandler<T = unknown> = (data: T) => void;
type MessageHandler = (message: WebSocketMessage) => void;

// ============================================================================
// CONSTANTS
// ============================================================================

const WS_URL = typeof window !== 'undefined'
    ? (process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:3004')
    : 'ws://localhost:3004';

const RECONNECT_DELAY = 3000;
const PING_INTERVAL = 25000;
const MAX_SIGNALS = 50;
const MAX_TRADES = 100;
const MAX_ALERTS = 20;

// ============================================================================
// MAIN HOOK
// ============================================================================

export function useWebSocket(url: string = WS_URL) {
    // Connection state
    const [connectionStatus, setConnectionStatus] = useState<WSConnectionStatus>({
        connected: false,
        clientId: null,
        subscribedRooms: [],
        serverTime: null,
    });

    // Real-time data state
    const [realTimeState, setRealTimeState] = useState<WSRealTimeState>({
        signals: [],
        prices: {},
        trades: [],
        positions: [],
        alerts: [],
        agentStatuses: {},
    });

    // Last message for backwards compatibility
    const [lastMessage, setLastMessage] = useState<WebSocketMessage | null>(null);

    // Refs
    const ws = useRef<WebSocket | null>(null);
    const reconnectTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const pingInterval = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
    const eventHandlers = useRef<Map<WSEventType, Set<EventHandler>>>(new Map());
    const messageHandlers = useRef<Set<MessageHandler>>(new Set());
    const pendingSubscriptions = useRef<string[]>([]);

    // ========================================================================
    // MESSAGE PROCESSING
    // ========================================================================

    const processMessage = useCallback((message: WebSocketMessage) => {
        const { type, data, timestamp } = message;

        // Update last message for backwards compatibility
        setLastMessage(message);

        // Notify raw message handlers
        messageHandlers.current.forEach(handler => handler(message));

        // Route based on message type
        switch (type) {
            case 'WELCOME':
                const welcomeData = data as { clientId?: string; serverTime?: number };
                setConnectionStatus(prev => ({
                    ...prev,
                    clientId: welcomeData?.clientId || null,
                    serverTime: welcomeData?.serverTime || null,
                }));
                break;

            case 'SUBSCRIBED':
                const subData = message as unknown as { rooms?: string[] };
                if (subData.rooms) {
                    setConnectionStatus(prev => ({
                        ...prev,
                        subscribedRooms: [...new Set([...prev.subscribedRooms, ...subData.rooms!])],
                    }));
                }
                break;

            case 'UNSUBSCRIBED':
                const unsubData = message as unknown as { rooms?: string[] };
                if (unsubData.rooms) {
                    setConnectionStatus(prev => ({
                        ...prev,
                        subscribedRooms: prev.subscribedRooms.filter(r => !unsubData.rooms!.includes(r)),
                    }));
                }
                break;

            case 'SIGNAL_ALERT':
            case 'signal':
                const signalData = (data as { data?: TradingSignal })?.data || data as TradingSignal;
                if (signalData) {
                    setRealTimeState(prev => ({
                        ...prev,
                        signals: [signalData, ...prev.signals].slice(0, MAX_SIGNALS),
                    }));
                    eventHandlers.current.get('signal')?.forEach(h => h(signalData));
                }
                break;

            case 'price':
                const priceData = (data as { data?: WSPriceData })?.data || data as WSPriceData;
                if (priceData?.symbol) {
                    setRealTimeState(prev => ({
                        ...prev,
                        prices: {
                            ...prev.prices,
                            [priceData.symbol]: priceData,
                        },
                    }));
                    eventHandlers.current.get('price')?.forEach(h => h(priceData));
                }
                break;

            case 'TRADE_EXECUTED':
            case 'trade':
                const tradeData = (data as { data?: WSTradeData })?.data || data as WSTradeData;
                if (tradeData) {
                    setRealTimeState(prev => ({
                        ...prev,
                        trades: [tradeData, ...prev.trades].slice(0, MAX_TRADES),
                    }));
                    eventHandlers.current.get('trade')?.forEach(h => h(tradeData));
                }
                break;

            case 'POSITION_UPDATE':
            case 'position':
                const positionUpdate = data as { position?: Position; action?: string };
                if (positionUpdate?.position) {
                    setRealTimeState(prev => {
                        const { position, action } = positionUpdate;
                        if (action === 'CLOSED') {
                            return {
                                ...prev,
                                positions: prev.positions.filter(p => p.id !== position!.id),
                            };
                        }
                        const existing = prev.positions.findIndex(p => p.id === position!.id);
                        if (existing >= 0) {
                            const updated = [...prev.positions];
                            updated[existing] = position!;
                            return { ...prev, positions: updated };
                        }
                        return { ...prev, positions: [...prev.positions, position!] };
                    });
                    eventHandlers.current.get('position')?.forEach(h => h(positionUpdate));
                }
                break;

            case 'PORTFOLIO_UPDATE':
            case 'portfolio':
                eventHandlers.current.get('portfolio')?.forEach(h => h(data));
                break;

            case 'ALERT':
            case 'RISK_WARNING':
            case 'CIRCUIT_BREAKER_TRIGGERED':
            case 'alert':
                const alertData = (data as { data?: WSAlertData })?.data || data as WSAlertData;
                if (alertData) {
                    setRealTimeState(prev => ({
                        ...prev,
                        alerts: [alertData, ...prev.alerts].slice(0, MAX_ALERTS),
                    }));
                    eventHandlers.current.get('alert')?.forEach(h => h(alertData));
                }
                break;

            case 'AGENT_STATUS':
            case 'agent_status':
                const statusData = data as { agentId?: string; status?: AgentStatus };
                if (statusData?.agentId && statusData?.status) {
                    setRealTimeState(prev => ({
                        ...prev,
                        agentStatuses: {
                            ...prev.agentStatuses,
                            [statusData.agentId!]: statusData.status!,
                        },
                    }));
                    eventHandlers.current.get('agent_status')?.forEach(h => h(statusData));
                }
                break;

            case 'PONG':
                // Server responded to ping - connection is alive
                break;

            case 'HEARTBEAT':
                // Respond to server heartbeat
                if (ws.current?.readyState === WebSocket.OPEN) {
                    ws.current.send(JSON.stringify({ type: 'PING', timestamp: Date.now() }));
                }
                break;

            case 'BROADCAST':
                // Handle nested broadcast payload
                const payload = (message as unknown as { payload?: WebSocketMessage })?.payload;
                if (payload && typeof payload === 'object') {
                    processMessage(payload as WebSocketMessage);
                }
                break;

            default:
                // Check if this is a nested event in data
                if (data && typeof data === 'object' && 'type' in (data as Record<string, unknown>)) {
                    processMessage(data as WebSocketMessage);
                }
        }
    }, []);

    // ========================================================================
    // CONNECTION MANAGEMENT
    // ========================================================================

    const connect = useCallback(() => {
        try {
            if (ws.current?.readyState === WebSocket.OPEN) {
                return;
            }

            ws.current = new WebSocket(url);

            ws.current.onopen = () => {
                console.log('[WS] Connected');
                setConnectionStatus(prev => ({ ...prev, connected: true }));

                // Send pending room subscriptions
                if (pendingSubscriptions.current.length > 0) {
                    ws.current?.send(JSON.stringify({
                        type: 'SUBSCRIBE',
                        rooms: pendingSubscriptions.current,
                    }));
                    pendingSubscriptions.current = [];
                }

                // Start ping interval
                clearInterval(pingInterval.current);
                pingInterval.current = setInterval(() => {
                    if (ws.current?.readyState === WebSocket.OPEN) {
                        ws.current.send(JSON.stringify({ type: 'PING', timestamp: Date.now() }));
                    }
                }, PING_INTERVAL);
            };

            ws.current.onmessage = (event) => {
                try {
                    const parsed = JSON.parse(event.data);
                    processMessage(parsed);
                } catch (error) {
                    console.error('[WS] Error parsing message:', error);
                }
            };

            ws.current.onclose = () => {
                console.log('[WS] Disconnected');
                setConnectionStatus(prev => ({
                    ...prev,
                    connected: false,
                    clientId: null,
                }));

                clearInterval(pingInterval.current);

                // Auto-reconnect
                clearTimeout(reconnectTimeout.current);
                reconnectTimeout.current = setTimeout(() => {
                    console.log('[WS] Attempting reconnection...');
                    connect();
                }, RECONNECT_DELAY);
            };

            ws.current.onerror = (error) => {
                console.error('[WS] Error:', error);
                ws.current?.close();
            };
        } catch (error) {
            console.error('[WS] Failed to connect:', error);
        }
    }, [url, processMessage]);

    const disconnect = useCallback(() => {
        clearTimeout(reconnectTimeout.current);
        clearInterval(pingInterval.current);
        ws.current?.close();
    }, []);

    // ========================================================================
    // MESSAGING
    // ========================================================================

    const sendMessage = useCallback((type: string, data?: Record<string, any>) => {
        if (ws.current?.readyState === WebSocket.OPEN) {
            ws.current.send(JSON.stringify({ type, ...data, timestamp: Date.now() }));
            return true;
        }
        console.warn('[WS] Cannot send message: not connected');
        return false;
    }, []);

    // ========================================================================
    // ROOM SUBSCRIPTIONS
    // ========================================================================

    const subscribe = useCallback((rooms: string | string[]) => {
        const roomList = Array.isArray(rooms) ? rooms : [rooms];

        if (ws.current?.readyState === WebSocket.OPEN) {
            ws.current.send(JSON.stringify({
                type: 'SUBSCRIBE',
                rooms: roomList,
            }));
        } else {
            // Queue for when connected
            pendingSubscriptions.current = [...new Set([...pendingSubscriptions.current, ...roomList])];
        }
    }, []);

    const unsubscribe = useCallback((rooms: string | string[]) => {
        const roomList = Array.isArray(rooms) ? rooms : [rooms];

        if (ws.current?.readyState === WebSocket.OPEN) {
            ws.current.send(JSON.stringify({
                type: 'UNSUBSCRIBE',
                rooms: roomList,
            }));
        }

        // Remove from pending if present
        pendingSubscriptions.current = pendingSubscriptions.current.filter(r => !roomList.includes(r));
    }, []);

    // ========================================================================
    // EVENT HANDLERS
    // ========================================================================

    const onEvent = useCallback(<T = unknown>(eventType: WSEventType, handler: EventHandler<T>) => {
        if (!eventHandlers.current.has(eventType)) {
            eventHandlers.current.set(eventType, new Set());
        }
        eventHandlers.current.get(eventType)!.add(handler as EventHandler);

        // Return cleanup function
        return () => {
            eventHandlers.current.get(eventType)?.delete(handler as EventHandler);
        };
    }, []);

    const onMessage = useCallback((handler: MessageHandler) => {
        messageHandlers.current.add(handler);
        return () => {
            messageHandlers.current.delete(handler);
        };
    }, []);

    // ========================================================================
    // STATE HELPERS
    // ========================================================================

    const clearSignals = useCallback(() => {
        setRealTimeState(prev => ({ ...prev, signals: [] }));
    }, []);

    const clearTrades = useCallback(() => {
        setRealTimeState(prev => ({ ...prev, trades: [] }));
    }, []);

    const clearAlerts = useCallback(() => {
        setRealTimeState(prev => ({ ...prev, alerts: [] }));
    }, []);

    const getPrice = useCallback((symbol: string): WSPriceData | undefined => {
        return realTimeState.prices[symbol];
    }, [realTimeState.prices]);

    // ========================================================================
    // LIFECYCLE
    // ========================================================================

    useEffect(() => {
        connect();

        return () => {
            disconnect();
        };
    }, [connect, disconnect]);

    // ========================================================================
    // RETURN VALUE
    // ========================================================================

    return useMemo(() => ({
        // Connection status
        isConnected: connectionStatus.connected,
        connected: connectionStatus.connected,
        clientId: connectionStatus.clientId,
        subscribedRooms: connectionStatus.subscribedRooms,

        // Real-time data
        signals: realTimeState.signals,
        prices: realTimeState.prices,
        trades: realTimeState.trades,
        positions: realTimeState.positions,
        alerts: realTimeState.alerts,
        agentStatuses: realTimeState.agentStatuses,

        // Legacy compatibility
        lastMessage,

        // Actions
        sendMessage,
        subscribe,
        unsubscribe,
        disconnect,
        reconnect: connect,

        // Event handlers
        onEvent,
        onMessage,

        // Helpers
        getPrice,
        clearSignals,
        clearTrades,
        clearAlerts,
    }), [
        connectionStatus,
        realTimeState,
        lastMessage,
        sendMessage,
        subscribe,
        unsubscribe,
        disconnect,
        connect,
        onEvent,
        onMessage,
        getPrice,
        clearSignals,
        clearTrades,
        clearAlerts,
    ]);
}

// ============================================================================
// SPECIALIZED HOOKS
// ============================================================================

/**
 * Hook for subscribing to price updates for specific symbols
 */
export function usePriceSubscription(symbols: string[]) {
    const { prices, subscribe, unsubscribe, connected } = useWebSocket();

    useEffect(() => {
        if (connected && symbols.length > 0) {
            const rooms = symbols.map(s => `price:${s}`);
            subscribe(rooms);

            return () => {
                unsubscribe(rooms);
            };
        }
    }, [connected, symbols, subscribe, unsubscribe]);

    return useMemo(() => {
        const symbolPrices: Record<string, WSPriceData | undefined> = {};
        for (const symbol of symbols) {
            symbolPrices[symbol] = prices[symbol];
        }
        return symbolPrices;
    }, [symbols, prices]);
}

/**
 * Hook for subscribing to signal updates
 */
export function useSignalSubscription() {
    const { signals, subscribe, unsubscribe, connected, onEvent, clearSignals } = useWebSocket();
    const [latestSignal, setLatestSignal] = useState<TradingSignal | null>(null);

    useEffect(() => {
        if (connected) {
            subscribe('signals');

            const cleanup = onEvent<TradingSignal>('signal', (signal) => {
                setLatestSignal(signal);
            });

            return () => {
                cleanup();
                unsubscribe('signals');
            };
        }
    }, [connected, subscribe, unsubscribe, onEvent]);

    return { signals, latestSignal, clearSignals };
}

/**
 * Hook for subscribing to trade updates
 */
export function useTradeSubscription() {
    const { trades, subscribe, unsubscribe, connected, onEvent, clearTrades } = useWebSocket();
    const [latestTrade, setLatestTrade] = useState<WSTradeData | null>(null);

    useEffect(() => {
        if (connected) {
            subscribe('trades');

            const cleanup = onEvent<WSTradeData>('trade', (trade) => {
                setLatestTrade(trade);
            });

            return () => {
                cleanup();
                unsubscribe('trades');
            };
        }
    }, [connected, subscribe, unsubscribe, onEvent]);

    return { trades, latestTrade, clearTrades };
}
