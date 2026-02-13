import { WebSocketServer, WebSocket } from 'ws';
import type { RawData } from 'ws';
import { createServer, IncomingMessage } from 'http';
import { WebSocketPayloadSchema } from '@cryonix/types';

const PORT = parseInt(process.env.WS_PORT || '3004', 10);

// Create HTTP server
const server = createServer();

// Create WebSocket server
const wss = new WebSocketServer({ server });

console.log(`🚀 WebSocket Server starting on port ${PORT}...`);

// ============================================================================
// CLIENT & ROOM MANAGEMENT
// ============================================================================

interface ClientInfo {
    ws: WebSocket;
    id: string;
    isAgent: boolean;
    agentId?: string;
    subscribedRooms: Set<string>;
    lastPing: number;
}

// Store connections with metadata
const clients = new Map<WebSocket, ClientInfo>();

// Room-based subscriptions (e.g., "price:BTC/USDT", "signals", "trades")
const rooms = new Map<string, Set<WebSocket>>();

// Generate unique client ID
let clientIdCounter = 0;
function generateClientId(): string {
    return `client_${Date.now()}_${++clientIdCounter}`;
}

// ============================================================================
// ROOM MANAGEMENT FUNCTIONS
// ============================================================================

function joinRoom(ws: WebSocket, room: string): void {
    if (!rooms.has(room)) {
        rooms.set(room, new Set());
    }
    rooms.get(room)!.add(ws);

    const clientInfo = clients.get(ws);
    if (clientInfo) {
        clientInfo.subscribedRooms.add(room);
    }

    console.log(`📥 Client joined room: ${room}`);
}

function leaveRoom(ws: WebSocket, room: string): void {
    const roomClients = rooms.get(room);
    if (roomClients) {
        roomClients.delete(ws);
        if (roomClients.size === 0) {
            rooms.delete(room);
        }
    }

    const clientInfo = clients.get(ws);
    if (clientInfo) {
        clientInfo.subscribedRooms.delete(room);
    }

    console.log(`📤 Client left room: ${room}`);
}

function leaveAllRooms(ws: WebSocket): void {
    const clientInfo = clients.get(ws);
    if (clientInfo) {
        for (const room of clientInfo.subscribedRooms) {
            leaveRoom(ws, room);
        }
    }
}

// ============================================================================
// BROADCAST FUNCTIONS
// ============================================================================

function broadcast(data: unknown): void {
    const message = JSON.stringify(data);
    for (const [ws, clientInfo] of clients) {
        if (ws.readyState === WebSocket.OPEN && !clientInfo.isAgent) {
            ws.send(message);
        }
    }
}

function broadcastToRoom(room: string, data: unknown): void {
    const message = JSON.stringify(data);
    const roomClients = rooms.get(room);

    if (roomClients) {
        for (const ws of roomClients) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(message);
            }
        }
    }
}

function broadcastToAgents(data: unknown): void {
    const message = JSON.stringify(data);
    for (const [ws, clientInfo] of clients) {
        if (ws.readyState === WebSocket.OPEN && clientInfo.isAgent) {
            ws.send(message);
        }
    }
}

// ============================================================================
// EVENT TYPE HANDLERS
// ============================================================================

type WSEventType = 'signal' | 'price' | 'trade' | 'alert' | 'position' | 'portfolio' | 'agent_status';

interface WSEvent {
    type: WSEventType;
    data: unknown;
    timestamp: number;
    room?: string;
}

function handleEventBroadcast(event: WSEvent): void {
    const { type, data, timestamp, room } = event;

    const payload = {
        type,
        data,
        timestamp: timestamp || Date.now(),
    };

    // Route event to appropriate recipients
    switch (type) {
        case 'signal':
            // Broadcast to 'signals' room and all clients
            broadcastToRoom('signals', payload);
            broadcast({ ...payload, type: 'SIGNAL_ALERT' });
            break;

        case 'price':
            // Broadcast to symbol-specific price room
            const priceData = data as { symbol: string; price: number };
            if (priceData.symbol) {
                broadcastToRoom(`price:${priceData.symbol}`, payload);
            }
            // Also broadcast to general 'prices' room
            broadcastToRoom('prices', payload);
            break;

        case 'trade':
            // Broadcast to 'trades' room
            broadcastToRoom('trades', payload);
            broadcast({ ...payload, type: 'TRADE_EXECUTED' });
            break;

        case 'alert':
            // Broadcast to all clients
            broadcast({ ...payload, type: 'ALERT' });
            break;

        case 'position':
            // Broadcast position updates
            broadcastToRoom('positions', payload);
            broadcast({ ...payload, type: 'POSITION_UPDATE' });
            break;

        case 'portfolio':
            // Broadcast portfolio updates
            broadcast({ ...payload, type: 'PORTFOLIO_UPDATE' });
            break;

        case 'agent_status':
            // Broadcast agent status updates
            broadcast({ ...payload, type: 'AGENT_STATUS' });
            break;

        default:
            // Generic broadcast for unknown types
            if (room) {
                broadcastToRoom(room, payload);
            } else {
                broadcast(payload);
            }
    }
}

// ============================================================================
// MESSAGE HANDLERS
// ============================================================================

interface ParsedMessage {
    type: string;
    payload?: unknown;
    agentId?: string;
    timestamp?: number;
    room?: string;
    rooms?: string[];
    event?: WSEvent;
}

function handleMessage(ws: WebSocket, message: RawData): void {
    try {
        const parsed: ParsedMessage = JSON.parse(message.toString());

        // Validate message structure
        const validation = WebSocketPayloadSchema.safeParse(parsed);

        if (!validation.success) {
            console.warn('⚠️ Invalid message format:', validation.error.format());
            ws.send(JSON.stringify({
                type: 'ERROR',
                message: 'Invalid message format',
                timestamp: Date.now(),
            }));
            return;
        }

        const validatedData = validation.data;
        const clientInfo = clients.get(ws);

        // Handle different message types
        switch (validatedData.type) {
            case 'REGISTER_AGENT':
                if (clientInfo) {
                    clientInfo.isAgent = true;
                    clientInfo.agentId = validatedData.agentId;
                    console.log(`🤖 Agent registered: ${validatedData.agentId}`);

                    // Auto-subscribe agents to relevant rooms
                    joinRoom(ws, 'agents');
                    joinRoom(ws, 'signals');
                    joinRoom(ws, 'trades');

                    ws.send(JSON.stringify({
                        type: 'AGENT_REGISTERED',
                        agentId: validatedData.agentId,
                        timestamp: Date.now(),
                    }));
                }
                break;

            case 'BROADCAST':
                // Check if this is a typed event
                if (parsed.event) {
                    handleEventBroadcast(parsed.event);
                } else if (parsed.room) {
                    // Broadcast to specific room
                    broadcastToRoom(parsed.room, validatedData.payload);
                } else {
                    // General broadcast
                    broadcast(validatedData.payload);
                }
                break;

            case 'PING':
                if (clientInfo) {
                    clientInfo.lastPing = Date.now();
                }
                ws.send(JSON.stringify({ type: 'PONG', timestamp: Date.now() }));
                break;

            default:
                // Handle custom message types
                handleCustomMessage(ws, validatedData.type, parsed);
        }
    } catch (error) {
        console.error('Error parsing message:', error);
        ws.send(JSON.stringify({
            type: 'ERROR',
            message: 'Failed to parse message',
            timestamp: Date.now(),
        }));
    }
}

function handleCustomMessage(ws: WebSocket, type: string, parsed: ParsedMessage): void {
    const clientInfo = clients.get(ws);

    switch (type) {
        // Room subscription management
        case 'SUBSCRIBE':
            if (parsed.rooms && Array.isArray(parsed.rooms)) {
                for (const room of parsed.rooms) {
                    joinRoom(ws, room);
                }
                ws.send(JSON.stringify({
                    type: 'SUBSCRIBED',
                    rooms: parsed.rooms,
                    timestamp: Date.now(),
                }));
            } else if (parsed.room) {
                joinRoom(ws, parsed.room);
                ws.send(JSON.stringify({
                    type: 'SUBSCRIBED',
                    rooms: [parsed.room],
                    timestamp: Date.now(),
                }));
            }
            break;

        case 'UNSUBSCRIBE':
            if (parsed.rooms && Array.isArray(parsed.rooms)) {
                for (const room of parsed.rooms) {
                    leaveRoom(ws, room);
                }
            } else if (parsed.room) {
                leaveRoom(ws, parsed.room);
            }
            ws.send(JSON.stringify({
                type: 'UNSUBSCRIBED',
                rooms: parsed.rooms || [parsed.room],
                timestamp: Date.now(),
            }));
            break;

        case 'GET_ROOMS':
            ws.send(JSON.stringify({
                type: 'ROOMS_LIST',
                rooms: clientInfo ? Array.from(clientInfo.subscribedRooms) : [],
                timestamp: Date.now(),
            }));
            break;

        case 'GET_STATUS':
            ws.send(JSON.stringify({
                type: 'STATUS',
                clientId: clientInfo?.id,
                isAgent: clientInfo?.isAgent,
                subscribedRooms: clientInfo ? Array.from(clientInfo.subscribedRooms) : [],
                connectedClients: clients.size,
                activeRooms: rooms.size,
                timestamp: Date.now(),
            }));
            break;

        // Event publishing (for agents)
        case 'SIGNAL_ALERT':
        case 'TRADE_EXECUTED':
        case 'POSITION_UPDATE':
        case 'RISK_WARNING':
        case 'CIRCUIT_BREAKER_TRIGGERED':
        case 'ORCHESTRATOR_STATUS_UPDATE':
        case 'AGENT_STATUS':
            // Forward these as events
            if (clientInfo?.isAgent) {
                handleEventBroadcast({
                    type: mapMessageTypeToEventType(type),
                    data: parsed.payload,
                    timestamp: parsed.timestamp || Date.now(),
                });
            }
            break;

        default:
            // By default, if an agent sends a message, broadcast it to all UI clients
            if (clientInfo?.isAgent) {
                broadcast(parsed);
            }
    }
}

function mapMessageTypeToEventType(messageType: string): WSEventType {
    const mapping: Record<string, WSEventType> = {
        'SIGNAL_ALERT': 'signal',
        'TRADE_EXECUTED': 'trade',
        'POSITION_UPDATE': 'position',
        'RISK_WARNING': 'alert',
        'CIRCUIT_BREAKER_TRIGGERED': 'alert',
        'ORCHESTRATOR_STATUS_UPDATE': 'agent_status',
        'AGENT_STATUS': 'agent_status',
    };
    return mapping[messageType] || 'alert';
}

// ============================================================================
// CONNECTION HANDLING
// ============================================================================

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const ip = req.socket.remoteAddress;
    const clientId = generateClientId();

    console.log(`🔌 New connection from ${ip} (${clientId})`);

    // Register client
    const clientInfo: ClientInfo = {
        ws,
        id: clientId,
        isAgent: false,
        subscribedRooms: new Set(),
        lastPing: Date.now(),
    };
    clients.set(ws, clientInfo);

    // Auto-subscribe to default rooms
    joinRoom(ws, 'global');

    // Send welcome message
    ws.send(JSON.stringify({
        type: 'WELCOME',
        data: {
            message: 'Connected to Cryonix WebSocket Server',
            clientId,
            serverTime: Date.now(),
        },
        timestamp: Date.now(),
    }));

    // Handle incoming messages
    ws.on('message', (message: RawData) => handleMessage(ws, message));

    // Handle connection close
    ws.on('close', () => {
        console.log(`❌ Connection closed: ${ip} (${clientId})`);
        leaveAllRooms(ws);
        clients.delete(ws);
    });

    // Handle errors
    ws.on('error', (error: Error) => {
        console.error(`⚠️ WebSocket error for ${clientId}: ${error.message}`);
    });
});

// ============================================================================
// HEARTBEAT & CLEANUP
// ============================================================================

const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const CLIENT_TIMEOUT = 90000; // 90 seconds

setInterval(() => {
    const now = Date.now();

    for (const [ws, clientInfo] of clients) {
        // Check for stale connections
        if (now - clientInfo.lastPing > CLIENT_TIMEOUT) {
            console.log(`⏱️ Client ${clientInfo.id} timed out, disconnecting...`);
            ws.terminate();
            leaveAllRooms(ws);
            clients.delete(ws);
            continue;
        }

        // Send heartbeat
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'HEARTBEAT',
                timestamp: now,
            }));
        }
    }

    // Log stats
    console.log(`📊 Stats: ${clients.size} clients, ${rooms.size} rooms`);
}, HEARTBEAT_INTERVAL);

// ============================================================================
// SERVER START
// ============================================================================

server.listen(PORT, () => {
    console.log(`✅ WebSocket Server running on ws://localhost:${PORT}`);
    console.log(`📡 Ready to accept connections...`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down WebSocket server...');

    // Close all connections
    for (const [ws] of clients) {
        ws.close(1000, 'Server shutting down');
    }

    wss.close(() => {
        console.log('✅ WebSocket server closed');
        process.exit(0);
    });
});

// Export for external use (e.g., from API routes)
export { broadcast, broadcastToRoom, handleEventBroadcast, clients, rooms };
