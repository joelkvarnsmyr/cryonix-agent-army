import WebSocket from 'ws';
import type {
    WebSocketMessageType,
    WebSocketMessage,
    TradingSignal,
    WSEventType,
    WSPriceData,
    WSTradeData,
    WSAlertData,
    Position,
} from '@cryonix/types';

const WS_URL = process.env.WS_URL || 'ws://localhost:3004';
const RECONNECT_DELAY = 5000;
const CONNECTION_TIMEOUT = 10000;
const MESSAGE_QUEUE_MAX = 100;

// ============================================================================
// CONNECTION POOL (Singleton Pattern)
// ============================================================================

interface PendingMessage {
    payload: unknown;
    resolve: (success: boolean) => void;
    timestamp: number;
}

class WSConnectionPool {
    private static instance: WSConnectionPool;
    private ws: WebSocket | null = null;
    private connecting: boolean = false;
    private connected: boolean = false;
    private messageQueue: PendingMessage[] = [];
    private reconnectTimer: NodeJS.Timeout | null = null;
    private agentId: string | null = null;

    private constructor() {}

    static getInstance(): WSConnectionPool {
        if (!WSConnectionPool.instance) {
            WSConnectionPool.instance = new WSConnectionPool();
        }
        return WSConnectionPool.instance;
    }

    async connect(agentId?: string): Promise<boolean> {
        if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
            return true;
        }

        if (this.connecting) {
            // Wait for existing connection attempt
            return new Promise((resolve) => {
                const checkInterval = setInterval(() => {
                    if (this.connected) {
                        clearInterval(checkInterval);
                        resolve(true);
                    } else if (!this.connecting) {
                        clearInterval(checkInterval);
                        resolve(false);
                    }
                }, 100);

                // Timeout after 10s
                setTimeout(() => {
                    clearInterval(checkInterval);
                    resolve(this.connected);
                }, CONNECTION_TIMEOUT);
            });
        }

        this.connecting = true;
        this.agentId = agentId || null;

        return new Promise((resolve) => {
            try {
                this.ws = new WebSocket(WS_URL);

                const timeout = setTimeout(() => {
                    if (!this.connected) {
                        console.error('[WS-Pool] Connection timeout');
                        this.ws?.terminate();
                        this.connecting = false;
                        resolve(false);
                    }
                }, CONNECTION_TIMEOUT);

                this.ws.on('open', () => {
                    clearTimeout(timeout);
                    this.connected = true;
                    this.connecting = false;
                    console.log('[WS-Pool] Connected to WebSocket server');

                    // Register as agent if agentId provided
                    if (this.agentId) {
                        this.ws?.send(JSON.stringify({
                            type: 'REGISTER_AGENT',
                            agentId: this.agentId,
                            timestamp: Date.now(),
                        }));
                    }

                    // Flush queued messages
                    this.flushQueue();
                    resolve(true);
                });

                this.ws.on('close', () => {
                    this.connected = false;
                    this.connecting = false;
                    console.log('[WS-Pool] Disconnected from WebSocket server');

                    // Schedule reconnect
                    this.scheduleReconnect();
                });

                this.ws.on('error', (err) => {
                    console.error('[WS-Pool] WebSocket error:', err.message);
                    clearTimeout(timeout);
                    this.connecting = false;

                    if (!this.connected) {
                        resolve(false);
                    }
                });

                this.ws.on('message', (data) => {
                    try {
                        const message = JSON.parse(data.toString());
                        // Handle server responses if needed
                        if (message.type === 'ERROR') {
                            console.error('[WS-Pool] Server error:', message.message);
                        }
                    } catch {
                        // Ignore parse errors for incoming messages
                    }
                });

            } catch (error) {
                console.error('[WS-Pool] Connection error:', error);
                this.connecting = false;
                resolve(false);
            }
        });
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer) return;

        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            console.log('[WS-Pool] Attempting reconnection...');
            await this.connect(this.agentId || undefined);
        }, RECONNECT_DELAY);
    }

    private flushQueue(): void {
        while (this.messageQueue.length > 0 && this.connected) {
            const pending = this.messageQueue.shift();
            if (pending) {
                this.sendImmediate(pending.payload)
                    .then(pending.resolve)
                    .catch(() => pending.resolve(false));
            }
        }
    }

    private async sendImmediate(payload: unknown): Promise<boolean> {
        return new Promise((resolve) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                resolve(false);
                return;
            }

            this.ws.send(JSON.stringify(payload), (err) => {
                if (err) {
                    console.error('[WS-Pool] Send error:', err);
                    resolve(false);
                } else {
                    resolve(true);
                }
            });
        });
    }

    async send(payload: unknown): Promise<boolean> {
        // If connected, send immediately
        if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
            return this.sendImmediate(payload);
        }

        // Queue message if not connected
        if (this.messageQueue.length >= MESSAGE_QUEUE_MAX) {
            console.warn('[WS-Pool] Message queue full, dropping oldest message');
            this.messageQueue.shift();
        }

        return new Promise((resolve) => {
            this.messageQueue.push({
                payload,
                resolve,
                timestamp: Date.now(),
            });

            // Ensure connection is being attempted
            if (!this.connecting && !this.connected) {
                this.connect(this.agentId || undefined);
            }
        });
    }

    disconnect(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }

        this.connected = false;
        this.connecting = false;
    }

    isConnected(): boolean {
        return this.connected && this.ws?.readyState === WebSocket.OPEN;
    }
}

// ============================================================================
// PUBLIC API - TYPED PUBLISH METHODS
// ============================================================================

/**
 * Get singleton connection pool instance
 */
export function getConnectionPool(): WSConnectionPool {
    return WSConnectionPool.getInstance();
}

/**
 * Initialize the WebSocket publisher with an agent ID
 * This should be called once when the server starts
 */
export async function initializePublisher(agentId: string): Promise<boolean> {
    const pool = getConnectionPool();
    return pool.connect(agentId);
}

/**
 * Generic publish function - publishes a typed event
 */
export async function publishEvent<T = unknown>(
    eventType: WSEventType,
    data: T,
    room?: string
): Promise<boolean> {
    const pool = getConnectionPool();

    const payload = {
        type: 'BROADCAST',
        event: {
            type: eventType,
            data,
            timestamp: Date.now(),
            room,
        },
    };

    return pool.send(payload);
}

/**
 * Publish a trading signal
 */
export async function publishSignal(signal: TradingSignal): Promise<boolean> {
    return publishEvent('signal', signal);
}

/**
 * Publish a price update for a symbol
 */
export async function publishPrice(priceData: WSPriceData): Promise<boolean> {
    return publishEvent('price', priceData, `price:${priceData.symbol}`);
}

/**
 * Publish multiple price updates
 */
export async function publishPrices(prices: WSPriceData[]): Promise<boolean> {
    const pool = getConnectionPool();
    let success = true;

    for (const price of prices) {
        const result = await publishPrice(price);
        if (!result) success = false;
    }

    return success;
}

/**
 * Publish a trade execution
 */
export async function publishTrade(trade: WSTradeData): Promise<boolean> {
    return publishEvent('trade', trade);
}

/**
 * Publish a position update
 */
export async function publishPosition(
    position: Position,
    action: 'OPENED' | 'UPDATED' | 'CLOSED'
): Promise<boolean> {
    return publishEvent('position', { position, action });
}

/**
 * Publish a portfolio update
 */
export async function publishPortfolio(portfolioData: unknown): Promise<boolean> {
    return publishEvent('portfolio', portfolioData);
}

/**
 * Publish an alert/notification
 */
export async function publishAlert(alert: WSAlertData): Promise<boolean> {
    return publishEvent('alert', alert);
}

/**
 * Publish agent status update
 */
export async function publishAgentStatus(
    agentId: string,
    status: 'idle' | 'running' | 'paused' | 'error',
    message?: string
): Promise<boolean> {
    return publishEvent('agent_status', { agentId, status, message });
}

/**
 * Broadcast to a specific room
 */
export async function broadcastToRoom(room: string, data: unknown): Promise<boolean> {
    const pool = getConnectionPool();

    const payload = {
        type: 'BROADCAST',
        room,
        payload: data,
    };

    return pool.send(payload);
}

/**
 * Legacy function for backwards compatibility
 * Publishes a message to the WebSocket server using the old API
 */
export async function publishToWebSocket<T = unknown>(
    type: WebSocketMessageType,
    data: T
): Promise<boolean> {
    const pool = getConnectionPool();

    const message: WebSocketMessage<T> = {
        type,
        timestamp: Date.now(),
        data,
    };

    const payload = {
        type: 'BROADCAST',
        payload: message,
    };

    return pool.send(payload);
}

/**
 * Disconnect the publisher
 * Call this when shutting down the server
 */
export function disconnectPublisher(): void {
    const pool = getConnectionPool();
    pool.disconnect();
}

/**
 * Check if publisher is connected
 */
export function isPublisherConnected(): boolean {
    const pool = getConnectionPool();
    return pool.isConnected();
}
