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
  icon?: string;
}

interface FlowEdge {
  from: string;
  to: string;
  active: boolean;
  dashed?: boolean;
}

export function AgentFlow() {
  const { health } = useSystemHealth(15000);
  const { data: autoTrade } = useAutoTrade(10000);
  const { scout, pendingTrades } = useTankState();
  const { isConnected } = useWebSocket();
  const { portfolio } = usePortfolio(30000);

  const services = health?.services || [];
  const redisStatus = services.find(s => s.name === 'Redis')?.status || 'down';
  const pgStatus = services.find(s => s.name === 'Postgres')?.status || 'down';
  const engineStatus = services.find(s => s.name === 'Python Engine')?.status || 'down';
  const scoutState = scout.state?.status || 'offline';
  const toml = autoTrade?.toml;

  const getStatus = (id: string): 'active' | 'idle' | 'down' => {
    switch (id) {
      case 'binance_data': return 'active';
      case 'scout': return scoutState === 'active' || scoutState === 'scanning' ? 'active' : scoutState === 'offline' ? 'down' : 'idle';
      case 'gainer': return engineStatus === 'healthy' ? 'active' : 'down';
      case 'quant': return engineStatus === 'healthy' ? 'active' : 'down';
      case 'cmc': return engineStatus === 'healthy' ? 'active' : 'idle';
      case 'risk': return engineStatus === 'healthy' ? 'active' : 'down';
      case 'redis': return redisStatus === 'healthy' ? 'active' : 'down';
      case 'grok': return autoTrade?.config?.AI_VALIDATION ? 'active' : 'idle';
      case 'autotrader': return autoTrade?.status === 'active' ? 'active' : 'down';
      case 'binance_exec': return 'active';
      case 'postgres': return pgStatus === 'healthy' ? 'active' : 'down';
      case 'ws': return isConnected ? 'active' : 'down';
      case 'telegram': return 'active';
      case 'tg_scraper': return 'active';
      case 'dashboard': return 'active';
      default: return 'idle';
    }
  };

  const pending = autoTrade?.queues?.pending || 0;
  const approved = autoTrade?.queues?.approved || 0;
  const positions = autoTrade?.positions?.length || 0;
  const tradesExecuted = autoTrade?.dailyState?.tradesExecuted || 0;
  const totalValue = portfolio?.totalValue || 0;
  const maxPos = autoTrade?.config?.MAX_OPEN_POSITIONS || 5;
  const leverage = autoTrade?.config?.DEFAULT_LEVERAGE || 3;
  const mode = autoTrade?.config?.TRADING_MODE || 'spot';
  const aiModel = toml?.ai?.model || 'grok-4-1-fast-reasoning';
  const shortModel = aiModel.replace('grok-4-1-fast-reasoning', 'Grok 4.1').replace('grok-3-mini', 'Grok 3 Mini').replace('grok-3', 'Grok 3');

  // Three-row layout: Data Sources → Processing → Execution → Outputs
  const nodes: FlowNode[] = [
    // Row 1: Data Sources (y=40)
    { id: 'binance_data', label: 'Binance', sublabel: '45 USDC pairs', status: getStatus('binance_data'), metrics: '15m OHLCV', x: 70, y: 40, color: '#f59e0b', width: 95 },
    { id: 'tg_scraper', label: 'TG Scraper', sublabel: 'Signal channels', status: getStatus('tg_scraper'), metrics: 'Telethon', x: 70, y: 100, color: '#22c55e', width: 95 },
    { id: 'cmc', label: 'CMC Scout', sublabel: 'F&G + MCap', status: getStatus('cmc'), metrics: '10min poll', x: 70, y: 160, color: '#3b82f6', width: 95 },

    // Row 2: Analysis (y=40, y=100)
    { id: 'scout', label: 'MarketScout', sublabel: '10s/symbol', status: getStatus('scout'), metrics: 'CCXT scanner', x: 230, y: 40, color: '#00d4ff', width: 100 },
    { id: 'gainer', label: 'GainerScan', sublabel: 'Top movers', status: getStatus('gainer'), metrics: '+10% boost', x: 230, y: 100, color: '#06b6d4', width: 100 },

    // Row 3: Pattern Detection + Risk (y=70)
    { id: 'quant', label: 'QuantGuild', sublabel: 'RSI BB MACD EMA', status: getStatus('quant'), metrics: '8 detectors', x: 390, y: 40, color: '#a78bfa', width: 100 },
    { id: 'risk', label: 'RiskGate', sublabel: 'Kelly + Consensus', status: getStatus('risk'), metrics: `≤${((toml?.risk?.max_daily_loss_pct ?? 0.05) * 100).toFixed(0)}% loss`, x: 390, y: 100, color: '#f87171', width: 100 },

    // Row 4: Queue + AI (y=70)
    { id: 'redis', label: 'Redis Queue', sublabel: `${pending}p / ${approved}a`, status: getStatus('redis'), metrics: 'trades:pending', x: 540, y: 70, color: '#ef4444', width: 95 },

    // Row 5: Execution
    { id: 'autotrader', label: 'AutoTrader', sublabel: '30s poll', status: getStatus('autotrader'), metrics: `${tradesExecuted} today`, x: 685, y: 40, color: '#10b981', width: 95 },
    { id: 'grok', label: 'GROK AI', sublabel: shortModel, status: getStatus('grok'), metrics: toml?.ai?.reasoning_effort ? `${toml.ai.reasoning_effort} reasoning` : 'validation', x: 685, y: 100, color: '#8b5cf6', width: 95 },

    // Row 6: Output
    { id: 'binance_exec', label: 'Binance Exec', sublabel: `${mode} ${leverage}x`, status: getStatus('binance_exec'), metrics: `${positions}/${maxPos} pos`, x: 835, y: 40, color: '#f59e0b', width: 95 },

    // Bottom row: Infrastructure
    { id: 'postgres', label: 'Postgres', sublabel: '15 tables', status: getStatus('postgres'), metrics: 'History', x: 540, y: 155, color: '#3b82f6', width: 85 },
    { id: 'ws', label: 'WebSocket', sublabel: ':3004', status: getStatus('ws'), metrics: isConnected ? 'LIVE' : 'OFF', x: 685, y: 155, color: '#06b6d4', width: 85 },
    { id: 'telegram', label: 'Telegram', sublabel: '@cryptonixis', status: getStatus('telegram'), metrics: 'Bot + Alerts', x: 835, y: 100, color: '#22c55e', width: 95 },
    { id: 'dashboard', label: 'Dashboard', sublabel: `$${totalValue.toFixed(0)}`, status: getStatus('dashboard'), x: 835, y: 155, color: '#00d4ff', width: 95 },
  ];

  const edges: FlowEdge[] = [
    // Data Sources → Analysis
    { from: 'binance_data', to: 'scout', active: getStatus('scout') === 'active' },
    { from: 'binance_data', to: 'gainer', active: getStatus('gainer') === 'active' },
    { from: 'tg_scraper', to: 'redis', active: true, dashed: true },
    { from: 'cmc', to: 'risk', active: getStatus('cmc') === 'active', dashed: true },
    // Analysis → Patterns
    { from: 'scout', to: 'quant', active: getStatus('quant') === 'active' },
    { from: 'gainer', to: 'risk', active: getStatus('risk') === 'active' },
    // Patterns → Queue
    { from: 'quant', to: 'risk', active: getStatus('risk') === 'active' },
    { from: 'risk', to: 'redis', active: pending > 0 || getStatus('redis') === 'active' },
    // Queue → Execution
    { from: 'redis', to: 'autotrader', active: getStatus('autotrader') === 'active' },
    { from: 'redis', to: 'grok', active: getStatus('grok') === 'active' },
    { from: 'grok', to: 'autotrader', active: getStatus('grok') === 'active' },
    // Execution → Output
    { from: 'autotrader', to: 'binance_exec', active: tradesExecuted > 0 },
    { from: 'binance_exec', to: 'telegram', active: true },
    // Infrastructure
    { from: 'redis', to: 'postgres', active: getStatus('postgres') === 'active' },
    { from: 'binance_exec', to: 'ws', active: isConnected },
    { from: 'ws', to: 'dashboard', active: isConnected },
  ];

  const getNode = (id: string) => nodes.find(n => n.id === id)!;

  // Generate bezier curve path between two nodes
  const edgePath = (from: FlowNode, to: FlowNode) => {
    const fw = (from.width || 80) / 2;
    const tw = (to.width || 80) / 2;
    const x1 = from.x + fw;
    const y1 = from.y;
    const x2 = to.x - tw;
    const y2 = to.y;
    const dx = (x2 - x1) * 0.4;
    return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
  };

  return (
    <Card className="glass-card overflow-hidden">
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <div className="h-4 w-4 rounded-sm bg-primary/10 flex items-center justify-center border border-primary/20">
              <span className="text-[7px] font-mono text-primary font-bold">SYS</span>
            </div>
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">System Architecture</span>
            <span className="text-[9px] font-mono text-muted-foreground/40">11 services / 45 pairs / {mode} {leverage}x / {shortModel}</span>
          </div>
          <div className="flex items-center gap-3 text-[9px] font-mono text-muted-foreground/60">
            <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Active</span>
            <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-amber-400" /> Idle</span>
            <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-red-400" /> Down</span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <svg viewBox="0 0 930 185" className="w-full min-w-[750px]" style={{ height: 'auto', maxHeight: '210px' }}>
            <defs>
              <filter id="nodeGlow">
                <feGaussianBlur stdDeviation="2" result="coloredBlur" />
                <feMerge>
                  <feMergeNode in="coloredBlur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
              <filter id="softShadow">
                <feDropShadow dx="0" dy="1" stdDeviation="2" floodColor="rgba(0,0,0,0.3)" />
              </filter>
            </defs>

            {/* Edges - bezier curves */}
            {edges.map((edge, i) => {
              const from = getNode(edge.from);
              const to = getNode(edge.to);
              return (
                <path
                  key={i}
                  d={edgePath(from, to)}
                  fill="none"
                  stroke={edge.active ? 'hsl(191 100% 50% / 0.25)' : 'hsl(218 35% 16% / 0.3)'}
                  strokeWidth={edge.active ? 1.2 : 0.5}
                  strokeDasharray={edge.dashed ? '3 3' : edge.active ? '5 3' : '2 4'}
                  className={edge.active ? 'animate-flow-dash' : ''}
                />
              );
            })}

            {/* Nodes */}
            {nodes.map((node) => {
              const w = node.width || 80;
              const h = 40;
              const isActive = node.status === 'active';
              return (
                <g key={node.id} filter={isActive ? 'url(#nodeGlow)' : 'url(#softShadow)'}>
                  {/* Node background with gradient effect */}
                  <rect
                    x={node.x - w / 2}
                    y={node.y - h / 2}
                    width={w}
                    height={h}
                    rx={8}
                    fill={isActive ? `${node.color}0F` : 'hsl(220 55% 5% / 0.9)'}
                    stroke={isActive ? `${node.color}50` : 'hsl(218 35% 16% / 0.4)'}
                    strokeWidth={isActive ? 1 : 0.5}
                  />
                  {/* Top accent line */}
                  {isActive && (
                    <rect
                      x={node.x - w / 2 + 8}
                      y={node.y - h / 2}
                      width={w - 16}
                      height={1.5}
                      rx={1}
                      fill={`${node.color}60`}
                    />
                  )}
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
                  <text x={node.x} y={node.y - 4} textAnchor="middle" fill="hsl(214 20% 90%)" fontSize="8.5" fontWeight="600" fontFamily="var(--font-mono)">
                    {node.label}
                  </text>
                  {/* Sublabel */}
                  <text x={node.x} y={node.y + 7} textAnchor="middle" fill="hsl(215 16% 55%)" fontSize="6" fontFamily="var(--font-mono)">
                    {node.sublabel}
                  </text>
                  {/* Metrics */}
                  {node.metrics && (
                    <text x={node.x} y={node.y + 16} textAnchor="middle" fill={node.color} fontSize="5.5" fontFamily="var(--font-mono)" opacity={0.7}>
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
