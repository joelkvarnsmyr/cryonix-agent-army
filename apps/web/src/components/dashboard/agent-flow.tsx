"use client";

import { Card, CardContent } from '@cryonix/ui';
import { useSystemHealth } from '@/hooks/useSystemHealth';
import { useAutoTrade } from '@/hooks/useAutoTrade';
import { useTankState } from '@/hooks/useTankState';
import { useWebSocket } from '@/hooks/use-websocket';
import { usePortfolio } from '@/hooks/useMarketData';

interface FlowNode {
  id: string;
  label: string;
  sublabel: string;
  status: 'active' | 'idle' | 'down';
  metrics?: string;
  x: number;
  y: number;
  color: string;
  width?: number;
}

export function AgentFlow() {
  const { health } = useSystemHealth(15000);
  const { data: autoTrade } = useAutoTrade(10000);
  const { scout, pendingTrades } = useTankState();
  const { isConnected } = useWebSocket();
  const { portfolio } = usePortfolio(30000);

  // Derive statuses
  const services = health?.services || [];
  const redisStatus = services.find(s => s.name === 'Redis')?.status || 'down';
  const pgStatus = services.find(s => s.name === 'Postgres')?.status || 'down';
  const engineStatus = services.find(s => s.name === 'Python Engine')?.status || 'down';
  const scoutState = scout.state?.status || 'offline';

  const getStatus = (id: string): 'active' | 'idle' | 'down' => {
    switch (id) {
      case 'binance_data': return 'active';
      case 'scout': return scoutState === 'active' || scoutState === 'scanning' ? 'active' : scoutState === 'offline' ? 'down' : 'idle';
      case 'gainer': return engineStatus === 'healthy' ? 'active' : 'down';
      case 'quant': return engineStatus === 'healthy' ? 'active' : 'down';
      case 'risk': return engineStatus === 'healthy' ? 'active' : 'down';
      case 'redis': return redisStatus === 'healthy' ? 'active' : 'down';
      case 'grok': return autoTrade?.config?.AI_VALIDATION ? 'active' : 'idle';
      case 'autotrader': return autoTrade?.status === 'active' ? 'active' : 'down';
      case 'binance_exec': return 'active';
      case 'postgres': return pgStatus === 'healthy' ? 'active' : 'down';
      case 'ws': return isConnected ? 'active' : 'down';
      case 'telegram': return 'active';
      case 'dashboard': return 'active';
      default: return 'idle';
    }
  };

  const pending = autoTrade?.queues?.pending || 0;
  const approved = autoTrade?.queues?.approved || 0;
  const positions = autoTrade?.positions?.length || 0;
  const tradesExecuted = autoTrade?.dailyState?.tradesExecuted || 0;
  const totalValue = portfolio?.totalValue || 0;
  const maxPos = autoTrade?.config?.MAX_OPEN_POSITIONS || 10;
  const leverage = autoTrade?.config?.DEFAULT_LEVERAGE || 3;
  const mode = autoTrade?.config?.TRADING_MODE || 'margin';

  // Full system nodes - two-row layout
  const nodes: FlowNode[] = [
    // Top row: Signal pipeline
    { id: 'binance_data', label: 'Binance', sublabel: '45 pairs OHLCV', status: getStatus('binance_data'), metrics: '15m candles', x: 55, y: 50, color: '#f59e0b', width: 90 },
    { id: 'scout', label: 'MarketScout', sublabel: '10s/symbol', status: getStatus('scout'), metrics: 'CCXT scanner', x: 195, y: 35, color: '#00d4ff', width: 90 },
    { id: 'gainer', label: 'GainerScan', sublabel: '15min interval', status: getStatus('gainer'), metrics: 'Top movers', x: 195, y: 80, color: '#06b6d4', width: 90 },
    { id: 'quant', label: 'QuantGuild', sublabel: 'RSI BB MACD ATR', status: getStatus('quant'), metrics: '7 detectors', x: 340, y: 35, color: '#a78bfa', width: 95 },
    { id: 'risk', label: 'RiskGate', sublabel: `Kelly + CB`, status: getStatus('risk'), metrics: `≤${(autoTrade?.config?.MAX_DAILY_LOSS_PCT || 0.05) * 100}% loss`, x: 340, y: 80, color: '#f87171', width: 95 },
    { id: 'redis', label: 'Redis Queue', sublabel: `${pending}p / ${approved}a`, status: getStatus('redis'), metrics: 'trades:pending', x: 490, y: 50, color: '#ef4444', width: 90 },
    { id: 'autotrader', label: 'AutoTrader', sublabel: `30s poll`, status: getStatus('autotrader'), metrics: `${tradesExecuted} today`, x: 630, y: 35, color: '#10b981', width: 90 },
    { id: 'grok', label: 'GROK AI', sublabel: 'grok-3-mini', status: getStatus('grok'), metrics: '2nd opinion', x: 630, y: 80, color: '#8b5cf6', width: 90 },
    { id: 'binance_exec', label: 'Binance', sublabel: `${mode} ${leverage}x`, status: getStatus('binance_exec'), metrics: `${positions}/${maxPos} pos`, x: 775, y: 50, color: '#f59e0b', width: 90 },

    // Bottom row: Infrastructure + outputs
    { id: 'postgres', label: 'Postgres', sublabel: '15 tables', status: getStatus('postgres'), metrics: 'History', x: 490, y: 130, color: '#3b82f6', width: 80 },
    { id: 'ws', label: 'WebSocket', sublabel: ':3004', status: getStatus('ws'), metrics: isConnected ? 'LIVE' : 'OFF', x: 700, y: 130, color: '#06b6d4', width: 80 },
    { id: 'telegram', label: 'Telegram', sublabel: '@cryptonixis', status: getStatus('telegram'), metrics: 'Alerts', x: 810, y: 130, color: '#22c55e', width: 80 },
    { id: 'dashboard', label: 'Dashboard', sublabel: `$${totalValue.toFixed(0)}`, status: getStatus('dashboard'), x: 920, y: 50, color: '#00d4ff', width: 80 },
  ];

  // Edge connections
  const edges = [
    { from: 'binance_data', to: 'scout', active: getStatus('scout') === 'active' },
    { from: 'binance_data', to: 'gainer', active: getStatus('gainer') === 'active' },
    { from: 'scout', to: 'quant', active: getStatus('quant') === 'active' },
    { from: 'gainer', to: 'quant', active: getStatus('quant') === 'active' },
    { from: 'quant', to: 'risk', active: getStatus('risk') === 'active' },
    { from: 'risk', to: 'redis', active: pending > 0 || getStatus('redis') === 'active' },
    { from: 'redis', to: 'autotrader', active: getStatus('autotrader') === 'active' },
    { from: 'redis', to: 'grok', active: getStatus('grok') === 'active' },
    { from: 'grok', to: 'autotrader', active: getStatus('grok') === 'active' },
    { from: 'autotrader', to: 'binance_exec', active: tradesExecuted > 0 },
    { from: 'redis', to: 'postgres', active: getStatus('postgres') === 'active' },
    { from: 'binance_exec', to: 'ws', active: isConnected },
    { from: 'binance_exec', to: 'telegram', active: true },
    { from: 'ws', to: 'dashboard', active: isConnected },
  ];

  const getNode = (id: string) => nodes.find(n => n.id === id)!;

  return (
    <Card className="glass-card overflow-hidden">
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <div className="h-4 w-4 rounded-sm bg-primary/10 flex items-center justify-center border border-primary/20">
              <span className="text-[7px] font-mono text-primary font-bold">SYS</span>
            </div>
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">System Architecture</span>
            <span className="text-[9px] font-mono text-muted-foreground/40">8 services / 45 pairs / {mode} {leverage}x</span>
          </div>
          <div className="flex items-center gap-3 text-[9px] font-mono text-muted-foreground/60">
            <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Active</span>
            <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-amber-400" /> Idle</span>
            <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-red-400" /> Down</span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <svg viewBox="0 0 980 165" className="w-full min-w-[750px]" style={{ height: 'auto', maxHeight: '190px' }}>
            <defs>
              <filter id="nodeGlow">
                <feGaussianBlur stdDeviation="1.5" result="coloredBlur" />
                <feMerge>
                  <feMergeNode in="coloredBlur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            {/* Edges */}
            {edges.map((edge, i) => {
              const from = getNode(edge.from);
              const to = getNode(edge.to);
              const fw = (from.width || 80) / 2;
              const tw = (to.width || 80) / 2;
              return (
                <line
                  key={i}
                  x1={from.x + fw}
                  y1={from.y}
                  x2={to.x - tw}
                  y2={to.y}
                  stroke={edge.active ? 'hsl(191 100% 50% / 0.2)' : 'hsl(218 35% 16% / 0.3)'}
                  strokeWidth={edge.active ? 1.2 : 0.6}
                  strokeDasharray={edge.active ? '4 4' : '2 4'}
                  className={edge.active ? 'animate-flow-dash' : ''}
                />
              );
            })}

            {/* Nodes */}
            {nodes.map((node) => {
              const w = node.width || 80;
              const h = 38;
              return (
                <g key={node.id} filter={node.status === 'active' ? 'url(#nodeGlow)' : undefined}>
                  <rect
                    x={node.x - w / 2}
                    y={node.y - h / 2}
                    width={w}
                    height={h}
                    rx={7}
                    fill={node.status === 'active' ? `${node.color}0D` : 'hsl(220 55% 7% / 0.8)'}
                    stroke={node.status === 'active' ? `${node.color}40` : 'hsl(218 35% 16% / 0.3)'}
                    strokeWidth={node.status === 'active' ? 0.8 : 0.4}
                  />
                  {/* Status dot */}
                  <circle
                    cx={node.x + w / 2 - 8}
                    cy={node.y - h / 2 + 8}
                    r={2.5}
                    fill={node.status === 'active' ? '#10b981' : node.status === 'idle' ? '#f59e0b' : '#ef4444'}
                  >
                    {node.status === 'active' && (
                      <animate attributeName="opacity" values="1;0.4;1" dur="2s" repeatCount="indefinite" />
                    )}
                  </circle>
                  {/* Label */}
                  <text x={node.x} y={node.y - 3} textAnchor="middle" fill="hsl(214 20% 90%)" fontSize="8.5" fontWeight="600" fontFamily="var(--font-mono)">
                    {node.label}
                  </text>
                  {/* Sublabel */}
                  <text x={node.x} y={node.y + 8} textAnchor="middle" fill="hsl(215 16% 47% / 0.6)" fontSize="6.5" fontFamily="var(--font-mono)">
                    {node.sublabel}
                  </text>
                  {/* Metrics */}
                  {node.metrics && (
                    <text x={node.x} y={node.y + 16} textAnchor="middle" fill={node.color} fontSize="5.5" fontFamily="var(--font-mono)" opacity={0.6}>
                      {node.metrics}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
      </CardContent>
    </Card>
  );
}
