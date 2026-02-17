/**
 * Cryonix WebSocket Server (Production Docker version)
 * Simplified - no TypeScript/Zod dependency.
 * Handles real-time dashboard updates: signals, trades, positions, prices.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { getToml } from './lib/load-toml.mjs';

const PORT = parseInt(process.env.WS_PORT || '3004', 10);

const server = createServer();
const wss = new WebSocketServer({ server });

// Client & room management
const clients = new Map();
const rooms = new Map();
let clientIdCounter = 0;

function generateClientId() {
  return `client_${Date.now()}_${++clientIdCounter}`;
}

function joinRoom(ws, room) {
  if (!rooms.has(room)) rooms.set(room, new Set());
  rooms.get(room).add(ws);
  const info = clients.get(ws);
  if (info) info.subscribedRooms.add(room);
}

function leaveRoom(ws, room) {
  const r = rooms.get(room);
  if (r) { r.delete(ws); if (r.size === 0) rooms.delete(room); }
  const info = clients.get(ws);
  if (info) info.subscribedRooms.delete(room);
}

function leaveAllRooms(ws) {
  const info = clients.get(ws);
  if (info) for (const room of info.subscribedRooms) leaveRoom(ws, room);
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const [ws, info] of clients) {
    if (ws.readyState === WebSocket.OPEN && !info.isAgent) ws.send(msg);
  }
}

function broadcastToRoom(room, data) {
  const msg = JSON.stringify(data);
  const r = rooms.get(room);
  if (r) for (const ws of r) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
}

const eventTypeMap = {
  'SIGNAL_ALERT': 'signal', 'TRADE_EXECUTED': 'trade',
  'POSITION_UPDATE': 'position', 'RISK_WARNING': 'alert',
  'AGENT_STATUS': 'agent_status',
};

function handleEventBroadcast(event) {
  const payload = { type: event.type, data: event.data, timestamp: event.timestamp || Date.now() };
  switch (event.type) {
    case 'signal': broadcastToRoom('signals', payload); broadcast({ ...payload, type: 'SIGNAL_ALERT' }); break;
    case 'price': broadcastToRoom('prices', payload); break;
    case 'trade': broadcastToRoom('trades', payload); broadcast({ ...payload, type: 'TRADE_EXECUTED' }); break;
    case 'position': broadcastToRoom('positions', payload); broadcast({ ...payload, type: 'POSITION_UPDATE' }); break;
    default: broadcast(payload);
  }
}

function handleMessage(ws, message) {
  try {
    const parsed = JSON.parse(message.toString());
    const info = clients.get(ws);

    switch (parsed.type) {
      case 'REGISTER_AGENT':
        if (info) {
          info.isAgent = true; info.agentId = parsed.agentId;
          joinRoom(ws, 'agents'); joinRoom(ws, 'signals'); joinRoom(ws, 'trades');
          ws.send(JSON.stringify({ type: 'AGENT_REGISTERED', agentId: parsed.agentId, timestamp: Date.now() }));
        }
        break;
      case 'BROADCAST':
        if (parsed.event) handleEventBroadcast(parsed.event);
        else if (parsed.room) broadcastToRoom(parsed.room, parsed.payload);
        else broadcast(parsed.payload);
        break;
      case 'PING':
        if (info) info.lastPing = Date.now();
        ws.send(JSON.stringify({ type: 'PONG', timestamp: Date.now() }));
        break;
      case 'SUBSCRIBE':
        const subRooms = parsed.rooms || (parsed.room ? [parsed.room] : []);
        for (const room of subRooms) joinRoom(ws, room);
        ws.send(JSON.stringify({ type: 'SUBSCRIBED', rooms: subRooms, timestamp: Date.now() }));
        break;
      case 'UNSUBSCRIBE':
        const unsubRooms = parsed.rooms || (parsed.room ? [parsed.room] : []);
        for (const room of unsubRooms) leaveRoom(ws, room);
        ws.send(JSON.stringify({ type: 'UNSUBSCRIBED', rooms: unsubRooms, timestamp: Date.now() }));
        break;
      case 'GET_STATUS':
        ws.send(JSON.stringify({
          type: 'STATUS', clientId: info?.id, isAgent: info?.isAgent,
          subscribedRooms: info ? Array.from(info.subscribedRooms) : [],
          connectedClients: clients.size, activeRooms: rooms.size, timestamp: Date.now(),
        }));
        break;
      default:
        // Forward agent messages to UI clients
        if (info?.isAgent) {
          const evType = eventTypeMap[parsed.type];
          if (evType) handleEventBroadcast({ type: evType, data: parsed.payload, timestamp: parsed.timestamp });
          else broadcast(parsed);
        }
    }
  } catch (err) {
    ws.send(JSON.stringify({ type: 'ERROR', message: 'Failed to parse message', timestamp: Date.now() }));
  }
}

wss.on('connection', (ws, req) => {
  const clientId = generateClientId();
  clients.set(ws, { ws, id: clientId, isAgent: false, subscribedRooms: new Set(), lastPing: Date.now() });
  joinRoom(ws, 'global');
  ws.send(JSON.stringify({ type: 'WELCOME', data: { message: 'Connected to Cryonix WS', clientId, serverTime: Date.now() }, timestamp: Date.now() }));
  ws.on('message', (msg) => handleMessage(ws, msg));
  ws.on('close', () => { leaveAllRooms(ws); clients.delete(ws); });
  ws.on('error', (err) => console.error(`WS error ${clientId}: ${err.message}`));
});

// Heartbeat
const WS_HEARTBEAT_MS = getToml('timing', 'ws_heartbeat_ms', 30000);
const WS_TIMEOUT_MS = getToml('timing', 'ws_timeout_ms', 90000);

setInterval(() => {
  const now = Date.now();
  for (const [ws, info] of clients) {
    if (now - info.lastPing > WS_TIMEOUT_MS) { ws.terminate(); leaveAllRooms(ws); clients.delete(ws); continue; }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'HEARTBEAT', timestamp: now }));
  }
}, WS_HEARTBEAT_MS);

server.listen(PORT, () => console.log(`WS Server running on ws://0.0.0.0:${PORT}`));
process.on('SIGTERM', () => { for (const [ws] of clients) ws.close(1000); wss.close(() => process.exit(0)); });
process.on('SIGINT', () => { for (const [ws] of clients) ws.close(1000); wss.close(() => process.exit(0)); });
