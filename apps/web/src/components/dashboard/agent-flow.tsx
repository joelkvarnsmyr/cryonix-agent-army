"use client";

import { Card, CardContent } from '@cryonix/ui';
import { useSystemHealth } from '@/hooks/useSystemHealth';
import { useAutoTrade } from '@/hooks/useAutoTrade';
import { useTankState } from '@/hooks/useTankState';
import { useWebSocket } from '@/hooks/use-websocket';

interface FlowNode {
  id: string;
  label: string;
  sublabel: string;
  status: 'active' | 'idle' | 'down';
  metrics?: string;
  x: number;
  y: number;
  color: string;
}

interface FlowEdge {
  from: string;
  to: string;
  label?: string;
  active: boolean;
}

function StatusIndicator({ status }: { status: 'active' | 'idle' | 'down' }) {
  const colors = {
    active: 'bg-emerald-400',
    idle: 'bg-amber-400',
    down: 'bg-red-400',
  };
  return (
    <span className={`inline-block h-2 w-2 rounded-full ${colors[status]} ${status === 'active' ? 'animate-pulse-dot' : ''}`} />
  );
}

export function AgentFlow() {
  const { health } = useSystemHealth(15000);
  const { data: autoTrade } = useAutoTrade(10000);
  const { scout, pendingTrades } = useTankState();
  const { isConnected } = useWebSocket();

  // Derive statuses from real data
  const services = health?.services || [];
  const redisStatus = services.find(s => s.name === 'Redis')?.status || 'down';
  const pgStatus = services.find(s => s.name === 'Postgres')?.status || 'down';
  const engineStatus = services.find(s => s.name === 'Python Engine')?.status || 'down';
  const scoutState = scout.state?.status || 'offline';

  const getNodeStatus = (id: string): 'active' | 'idle' | 'down' => {
    switch (id) {
      case 'market': return 'active'; // Binance is always available
      case 'scout': return scoutState === 'active' || scoutState === 'scanning' ? 'active' : scoutState === 'offline' ? 'down' : 'idle';
      case 'quant': return engineStatus === 'healthy' ? 'active' : engineStatus === 'degraded' ? 'idle' : 'down';
      case 'risk': return engineStatus === 'healthy' ? 'active' : 'down';
      case 'redis': return redisStatus === 'healthy' ? 'active' : redisStatus === 'degraded' ? 'idle' : 'down';
      case 'grok': return autoTrade?.config?.AI_VALIDATION ? 'active' : 'idle';
      case 'autotrader': return autoTrade?.status === 'active' ? 'active' : 'down';
      case 'binance': return 'active';
      case 'postgres': return pgStatus === 'healthy' ? 'active' : pgStatus === 'degraded' ? 'idle' : 'down';
      case 'ws': return isConnected ? 'active' : 'down';
      case 'dashboard': return 'active';
      default: return 'idle';
    }
  };

  const pending = autoTrade?.queues?.pending || 0;
  const approved = autoTrade?.queues?.approved || 0;
  const tradesExecuted = autoTrade?.dailyState?.tradesExecuted || 0;
  const positions = autoTrade?.positions?.length || 0;

  // Node definitions with positions for SVG layout
  // Layout: left-to-right flow with branches
  const nodes: FlowNode[] = [
    { id: 'market', label: 'Binance', sublabel: 'Market Data', status: getNodeStatus('market'), metrics: '15 pairs', x: 40, y: 60, color: '#f59e0b' },
    { id: 'scout', label: 'MarketScout', sublabel: 'Python Tank', status: getNodeStatus('scout'), metrics: '10s loop', x: 180, y: 60, color: '#00d4ff' },
    { id: 'quant', label: 'QuantGuild', sublabel: '7 Detectors', status: getNodeStatus('quant'), metrics: 'RSI+BB+MACD', x: 320, y: 35, color: '#a78bfa' },
    { id: 'risk', label: 'RiskGate', sublabel: 'Filter', status: getNodeStatus('risk'), metrics: `${pending} queued`, x: 320, y: 90, color: '#f87171' },
    { id: 'redis', label: 'Redis', sublabel: 'Queue', status: getNodeStatus('redis'), metrics: `${pending}p/${approved}a`, x: 460, y: 60, color: '#ef4444' },
    { id: 'autotrader', label: 'AutoTrader', sublabel: '30s Poll', status: getNodeStatus('autotrader'), metrics: `${tradesExecuted} today`, x: 600, y: 40, color: '#10b981' },
    { id: 'grok', label: 'GROK AI', sublabel: 'Validation', status: getNodeStatus('grok'), metrics: '2nd opinion', x: 600, y: 90, color: '#8b5cf6' },
    { id: 'binance', label: 'Binance', sublabel: 'Execution', status: getNodeStatus('binance'), metrics: `${positions} open`, x: 740, y: 60, color: '#f59e0b' },
    { id: 'postgres', label: 'Postgres', sublabel: 'History', status: getNodeStatus('postgres'), metrics: '15 tables', x: 460, y: 135, color: '#3b82f6' },
    { id: 'ws', label: 'WebSocket', sublabel: 'Real-time', status: getNodeStatus('ws'), metrics: isConnected ? 'LIVE' : 'OFF', x: 740, y: 135, color: '#06b6d4' },
    { id: 'dashboard', label: 'Dashboard', sublabel: 'You', status: getNodeStatus('dashboard'), x: 870, y: 60, color: '#00d4ff' },
  ];

  const edges: FlowEdge[] = [
    { from: 'market', to: 'scout', label: 'OHLCV', active: getNodeStatus('scout') === 'active' },
    { from: 'scout', to: 'quant', active: getNodeStatus('quant') === 'active' },
    { from: 'scout', to: 'risk', active: getNodeStatus('risk') === 'active' },
    { from: 'quant', to: 'redis', label: 'signals', active: pending > 0 },
    { from: 'risk', to: 'redis', active: pending > 0 },
    { from: 'redis', to: 'autotrader', label: 'queue', active: getNodeStatus('autotrader') === 'active' },
    { from: 'redis', to: 'grok', active: getNodeStatus('grok') === 'active' },
    { from: 'autotrader', to: 'binance', label: 'execute', active: tradesExecuted > 0 },
    { from: 'grok', to: 'autotrader', label: 'validate', active: getNodeStatus('grok') === 'active' },
    { from: 'redis', to: 'postgres', label: 'persist', active: getNodeStatus('postgres') === 'active' },
    { from: 'binance', to: 'ws', label: 'updates', active: isConnected },
    { from: 'ws', to: 'dashboard', active: isConnected },
  ];

  const getNodePos = (id: string) => {
    const node = nodes.find(n => n.id === id);
    return node ? { x: node.x, y: node.y } : { x: 0, y: 0 };
  };

  return (
    <Card className="glass-card overflow-hidden">
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="h-4 w-4 rounded-sm bg-primary/10 flex items-center justify-center">
              <span className="text-[8px] font-mono text-primary font-bold">F</span>
            </div>
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Agent Flow</span>
          </div>
          <div className="flex items-center gap-3 text-[10px] font-mono text-muted-foreground">
            <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Active</span>
            <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-amber-400" /> Idle</span>
            <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-red-400" /> Down</span>
          </div>
        </div>

        {/* SVG Flow Diagram */}
        <div className="overflow-x-auto">
          <svg viewBox="0 0 930 170" className="w-full min-w-[700px]" style={{ height: 'auto', maxHeight: '200px' }}>
            <defs>
              <filter id="glow">
                <feGaussianBlur stdDeviation="2" result="coloredBlur" />
                <feMerge>
                  <feMergeNode in="coloredBlur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            {/* Edges */}
            {edges.map((edge, i) => {
              const from = getNodePos(edge.from);
              const to = getNodePos(edge.to);
              const mx = (from.x + to.x) / 2;
              const my = (from.y + to.y) / 2;
              return (
                <g key={i}>
                  <line
                    x1={from.x + 45}
                    y1={from.y}
                    x2={to.x - 45}
                    y2={to.y}
                    stroke={edge.active ? 'hsl(191 100% 50% / 0.25)' : 'hsl(218 35% 16% / 0.4)'}
                    strokeWidth={edge.active ? 1.5 : 0.8}
                    strokeDasharray={edge.active ? '4 4' : '2 4'}
                    className={edge.active ? 'animate-flow-dash' : ''}
                  />
                  {edge.label && (
                    <text
                      x={mx}
                      y={my - 6}
                      textAnchor="middle"
                      fill="hsl(215 16% 47% / 0.6)"
                      fontSize="7"
                      fontFamily="var(--font-mono)"
                    >
                      {edge.label}
                    </text>
                  )}
                </g>
              );
            })}

            {/* Nodes */}
            {nodes.map((node) => (
              <g key={node.id} filter={node.status === 'active' ? 'url(#glow)' : undefined}>
                {/* Node background */}
                <rect
                  x={node.x - 42}
                  y={node.y - 22}
                  width={84}
                  height={44}
                  rx={8}
                  fill={node.status === 'active' ? `${node.color}10` : 'hsl(220 55% 7% / 0.8)'}
                  stroke={node.status === 'active' ? `${node.color}40` : 'hsl(218 35% 16% / 0.4)'}
                  strokeWidth={node.status === 'active' ? 1 : 0.5}
                />

                {/* Status indicator */}
                <circle
                  cx={node.x + 32}
                  cy={node.y - 14}
                  r={3}
                  fill={node.status === 'active' ? '#10b981' : node.status === 'idle' ? '#f59e0b' : '#ef4444'}
                >
                  {node.status === 'active' && (
                    <animate attributeName="opacity" values="1;0.4;1" dur="2s" repeatCount="indefinite" />
                  )}
                </circle>

                {/* Label */}
                <text
                  x={node.x}
                  y={node.y - 4}
                  textAnchor="middle"
                  fill="hsl(214 20% 90%)"
                  fontSize="9"
                  fontWeight="600"
                  fontFamily="var(--font-mono)"
                >
                  {node.label}
                </text>

                {/* Sublabel */}
                <text
                  x={node.x}
                  y={node.y + 8}
                  textAnchor="middle"
                  fill="hsl(215 16% 47% / 0.7)"
                  fontSize="7"
                  fontFamily="var(--font-mono)"
                >
                  {node.sublabel}
                </text>

                {/* Metrics */}
                {node.metrics && (
                  <text
                    x={node.x}
                    y={node.y + 18}
                    textAnchor="middle"
                    fill={node.color}
                    fontSize="6.5"
                    fontFamily="var(--font-mono)"
                    opacity={0.7}
                  >
                    {node.metrics}
                  </text>
                )}
              </g>
            ))}
          </svg>
        </div>
      </CardContent>
    </Card>
  );
}
