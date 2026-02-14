"use client";

import { useState } from 'react';
import { Card, CardContent, Badge } from '@cryonix/ui';
import {
  Radio, Brain, Shield, ArrowUpRight, ArrowDownRight,
  Eye, ChevronDown, ChevronRight, RefreshCw,
  Zap, Database, AlertTriangle, CheckCircle, XCircle, Clock
} from 'lucide-react';
import { useProcessLog, type ProcessEvent } from '@/hooks/useProcessLog';

const EVENT_CONFIG: Record<ProcessEvent['type'], {
  icon: typeof Radio;
  color: string;
  bgColor: string;
  borderColor: string;
  label: string;
}> = {
  signal_detected: {
    icon: Radio,
    color: 'text-cyan-400',
    bgColor: 'bg-cyan-500/[0.06]',
    borderColor: 'border-l-cyan-500/50',
    label: 'SIGNAL',
  },
  ai_validation: {
    icon: Brain,
    color: 'text-violet-400',
    bgColor: 'bg-violet-500/[0.06]',
    borderColor: 'border-l-violet-500/50',
    label: 'AI',
  },
  risk_check: {
    icon: Shield,
    color: 'text-amber-400',
    bgColor: 'bg-amber-500/[0.06]',
    borderColor: 'border-l-amber-500/50',
    label: 'RISK',
  },
  trade_executed: {
    icon: Zap,
    color: 'text-emerald-400',
    bgColor: 'bg-emerald-500/[0.06]',
    borderColor: 'border-l-emerald-500/50',
    label: 'TRADE',
  },
  position_monitor: {
    icon: Eye,
    color: 'text-blue-400',
    bgColor: 'bg-blue-500/[0.06]',
    borderColor: 'border-l-blue-500/50',
    label: 'MONITOR',
  },
  queue_event: {
    icon: Database,
    color: 'text-orange-400',
    bgColor: 'bg-orange-500/[0.06]',
    borderColor: 'border-l-orange-500/50',
    label: 'QUEUE',
  },
  system: {
    icon: AlertTriangle,
    color: 'text-zinc-400',
    bgColor: 'bg-zinc-500/[0.06]',
    borderColor: 'border-l-zinc-500/50',
    label: 'SYSTEM',
  },
};

const STATUS_ICON: Record<ProcessEvent['status'], typeof CheckCircle> = {
  approved: CheckCircle,
  rejected: XCircle,
  executed: Zap,
  pending: Clock,
  info: Database,
  warning: AlertTriangle,
  error: XCircle,
};

const STATUS_COLOR: Record<ProcessEvent['status'], string> = {
  approved: 'text-emerald-400',
  rejected: 'text-red-400',
  executed: 'text-emerald-400',
  pending: 'text-amber-400',
  info: 'text-blue-400',
  warning: 'text-amber-400',
  error: 'text-red-400',
};

function EventCard({ event }: { event: ProcessEvent }) {
  const [expanded, setExpanded] = useState(false);
  const config = EVENT_CONFIG[event.type];
  const Icon = config.icon;
  const StatusIcon = STATUS_ICON[event.status];
  const statusColor = STATUS_COLOR[event.status];

  const time = new Date(event.timestamp);
  const timeStr = time.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const isLive = event.id.startsWith('ws-');

  return (
    <div
      className={`group rounded-lg border-l-2 ${config.borderColor} ${config.bgColor} hover:bg-muted/10 transition-all cursor-pointer`}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="px-3 py-2.5 flex items-start gap-3">
        {/* Time + Icon */}
        <div className="flex flex-col items-center gap-1 flex-shrink-0 pt-0.5">
          <Icon className={`h-4 w-4 ${config.color}`} />
          <span className="text-[9px] font-mono text-muted-foreground/50">{timeStr}</span>
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {/* Type badge */}
            <Badge variant="outline" className={`text-[8px] h-4 px-1.5 ${config.color} border-current/20`}>
              {config.label}
            </Badge>

            {/* Symbol */}
            {event.symbol && (
              <span className="font-mono text-xs font-semibold text-foreground/90">
                {event.symbol.replace('/USDC', '').replace('/USDT', '')}
              </span>
            )}

            {/* Action badge */}
            {event.action && (
              <Badge
                variant="outline"
                className={`text-[8px] h-4 px-1.5 ${
                  event.action === 'BUY' ? 'text-emerald-400 border-emerald-400/30' : 'text-red-400 border-red-400/30'
                }`}
              >
                {event.action === 'BUY' ? <ArrowUpRight className="h-2 w-2 mr-0.5" /> : <ArrowDownRight className="h-2 w-2 mr-0.5" />}
                {event.action}
              </Badge>
            )}

            {/* Status */}
            <div className={`flex items-center gap-0.5 ${statusColor}`}>
              <StatusIcon className="h-3 w-3" />
              <span className="text-[9px] font-mono uppercase">{event.status}</span>
            </div>

            {/* Live indicator */}
            {isLive && (
              <span className="flex items-center gap-1 text-[8px] font-mono text-primary">
                <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse-dot" />
                LIVE
              </span>
            )}

            {/* Confidence */}
            {event.confidence !== undefined && event.confidence > 0 && (
              <span className="text-[9px] font-mono text-muted-foreground ml-auto">
                {(event.confidence * 100).toFixed(0)}%
              </span>
            )}

            {/* Expand indicator */}
            <div className="ml-auto opacity-0 group-hover:opacity-100 transition-opacity">
              {expanded ? <ChevronDown className="h-3 w-3 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 text-muted-foreground" />}
            </div>
          </div>

          {/* Title */}
          <p className="text-[11px] text-foreground/70 mt-1 leading-snug">{event.title}</p>

          {/* Description */}
          <p className="text-[10px] text-muted-foreground/70 mt-0.5 leading-snug">{event.description}</p>

          {/* Agent tag */}
          {event.agent && (
            <span className="text-[8px] font-mono text-muted-foreground/40 mt-1 inline-block">
              via {event.agent}
            </span>
          )}
        </div>
      </div>

      {/* Expanded Details */}
      {expanded && event.details && (
        <div className="px-3 pb-3 pt-1 border-t border-border/20 ml-7">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            {Object.entries(event.details).map(([key, value]) => {
              if (value === null || value === undefined || value === '') return null;
              const displayKey = key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();

              // Handle special nested objects
              if (typeof value === 'object' && !Array.isArray(value)) {
                return (
                  <div key={key} className="col-span-2">
                    <span className="text-[9px] text-muted-foreground/50 font-mono block mb-0.5">{displayKey}</span>
                    <pre className="text-[9px] font-mono text-muted-foreground/70 bg-background/40 rounded p-1.5 overflow-auto max-h-24">
                      {JSON.stringify(value, null, 2)}
                    </pre>
                  </div>
                );
              }

              if (Array.isArray(value)) {
                return (
                  <div key={key} className="col-span-2">
                    <span className="text-[9px] text-muted-foreground/50 font-mono block mb-0.5">{displayKey}</span>
                    <div className="flex flex-wrap gap-1">
                      {value.map((item, i) => (
                        <span key={i} className="text-[9px] font-mono bg-muted/20 px-1.5 py-0.5 rounded">
                          {typeof item === 'string' ? item : JSON.stringify(item)}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              }

              // Handle long text (reasoning)
              if (typeof value === 'string' && value.length > 80) {
                return (
                  <div key={key} className="col-span-2">
                    <span className="text-[9px] text-muted-foreground/50 font-mono">{displayKey}</span>
                    <p className="text-[10px] text-foreground/60 mt-0.5 leading-relaxed">{value}</p>
                  </div>
                );
              }

              return (
                <div key={key}>
                  <span className="text-[9px] text-muted-foreground/50 font-mono">{displayKey}</span>
                  <span className="text-[10px] font-mono text-foreground/70 ml-1.5">
                    {typeof value === 'number' ? (
                      key.includes('rice') || key.includes('pnl') || key.includes('value')
                        ? `$${value.toLocaleString()}`
                        : key.includes('onfidence') || key.includes('raction')
                          ? `${(value * 100).toFixed(1)}%`
                          : value.toString()
                    ) : (
                      String(value)
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

const FILTER_TYPES = [
  { key: 'all', label: 'All' },
  { key: 'signal_detected', label: 'Signals' },
  { key: 'ai_validation', label: 'AI' },
  { key: 'trade_executed', label: 'Trades' },
  { key: 'position_monitor', label: 'Monitor' },
  { key: 'queue_event', label: 'Queue' },
] as const;

export function ProcessViewer() {
  const { events, loading, refresh } = useProcessLog(8000);
  const [filter, setFilter] = useState<string>('all');

  const filtered = filter === 'all' ? events : events.filter(e => e.type === filter);

  // Stats
  const signalCount = events.filter(e => e.type === 'signal_detected').length;
  const validationCount = events.filter(e => e.type === 'ai_validation').length;
  const tradeCount = events.filter(e => e.type === 'trade_executed').length;
  const approvedCount = events.filter(e => e.status === 'approved').length;
  const rejectedCount = events.filter(e => e.status === 'rejected').length;

  return (
    <Card className="glass-card overflow-hidden">
      <CardContent className="p-0">
        {/* Header */}
        <div className="px-4 py-3 border-b border-border/30">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="h-5 w-5 rounded-md bg-violet-500/10 flex items-center justify-center border border-violet-500/20">
                <Brain className="h-3 w-3 text-violet-400" />
              </div>
              <span className="text-sm font-semibold">Process Log</span>
              <span className="text-[9px] font-mono text-muted-foreground/50 bg-muted/30 px-1.5 py-0.5 rounded">
                {events.length} events
              </span>
            </div>
            <button onClick={refresh} className="text-muted-foreground hover:text-foreground transition-colors">
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {/* Quick stats */}
          <div className="flex items-center gap-4 mb-3 text-[10px] font-mono">
            <span className="text-cyan-400">{signalCount} signals</span>
            <span className="text-violet-400">{validationCount} validations</span>
            <span className="text-emerald-400">{tradeCount} trades</span>
            <span className="text-muted-foreground">
              {approvedCount} approved / {rejectedCount} rejected
            </span>
          </div>

          {/* Filter pills */}
          <div className="flex items-center gap-1">
            {FILTER_TYPES.map(({ key, label }) => {
              const count = key === 'all' ? events.length : events.filter(e => e.type === key).length;
              return (
                <button
                  key={key}
                  onClick={() => setFilter(key)}
                  className={`px-2.5 py-1 rounded-md text-[10px] font-mono font-medium transition-all ${
                    filter === key
                      ? 'bg-primary/10 text-primary border border-primary/20'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/30'
                  }`}
                >
                  {label}
                  {count > 0 && <span className="ml-1 opacity-60">{count}</span>}
                </button>
              );
            })}
          </div>
        </div>

        {/* Event List */}
        <div className="max-h-[500px] overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="text-center py-12">
              <Database className="h-8 w-8 text-muted-foreground/20 mx-auto mb-2" />
              <p className="text-xs text-muted-foreground/50 font-mono">No events yet</p>
              <p className="text-[10px] text-muted-foreground/30 font-mono mt-1">
                Events will appear as the system processes signals
              </p>
            </div>
          ) : (
            <div className="p-2 space-y-1">
              {filtered.map((event) => (
                <EventCard key={event.id} event={event} />
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
