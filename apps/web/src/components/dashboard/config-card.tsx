"use client";

import { Card, CardContent, Badge } from '@cryonix/ui';
import { Settings2, Shield, Brain } from 'lucide-react';
import { useAutoTrade } from '@/hooks/useAutoTrade';

export function ConfigCard() {
  const { data } = useAutoTrade(30000);
  const config = data?.config;

  if (!config) {
    return (
      <Card className="glass-card">
        <CardContent className="p-5">
          <div className="flex items-center gap-2 mb-3">
            <Settings2 className="h-4 w-4 text-primary/70" />
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Config</span>
          </div>
          <div className="h-20 flex items-center justify-center">
            <span className="text-[10px] text-muted-foreground font-mono">Loading...</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  const toml = data?.toml;

  const shortModel = (m: string) => m.replace('grok-4-1-fast-reasoning', 'Grok 4.1 Fast').replace('grok-3-mini', 'Grok 3 Mini').replace('grok-3', 'Grok 3');
  const rows = toml ? [
    { label: 'Mode', value: `${toml.trading.mode.toUpperCase()} ${toml.trading.default_leverage}x` },
    { label: 'Capital', value: `$${data?.config.TOTAL_CAPITAL}` },
    { label: 'Positions', value: `${toml.limits.max_open_positions} max / ${toml.limits.max_trades_per_day}/day` },
    { label: 'Risk', value: `Max -${(toml.risk.max_daily_loss_pct * 100).toFixed(1)}%/day` },
    { label: 'Sizing', value: `${(toml.capital.max_position_size_pct * 100).toFixed(0)}% (min $${toml.capital.min_order_value})` },
    { label: 'AI', value: shortModel(toml.ai.model) },
    { label: 'Exits', value: `Trail ${toml.exits.trailing_stop_pct}% / Stag ${toml.exits.stagnation_timeout_hours}h` },
  ] : [
    { label: 'Capital', value: `$${config.TOTAL_CAPITAL}` },
    { label: 'Mode', value: `${config.TRADING_MODE} ${config.DEFAULT_LEVERAGE}x` },
    { label: 'Max Pos', value: `${config.MAX_OPEN_POSITIONS}` },
    { label: 'Max/Day', value: `${config.MAX_TRADES_PER_DAY}` },
    { label: 'Pos Size', value: `${(config.MAX_POSITION_SIZE_PCT * 100).toFixed(0)}%` },
    { label: 'Trail SL', value: `${config.TRAILING_STOP_PCT}%` },
  ];

  return (
    <Card className="glass-card">
      <CardContent className="p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Settings2 className="h-4 w-4 text-primary/70" />
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Config</span>
          </div>
          <div className="flex items-center gap-1.5">
            {config.AI_VALIDATION && (
              <Badge variant="outline" className="h-4 text-[8px] px-1.5 border-violet-500/30 text-violet-400 gap-0.5">
                <Brain className="h-2 w-2" />AI
              </Badge>
            )}
            <Badge variant="outline" className="h-4 text-[8px] px-1.5 border-primary/30 text-primary">
              {data?.isTestnet ? 'TESTNET' : 'MAINNET'}
            </Badge>
          </div>
        </div>

        <div className="space-y-1.5">
          {rows.map(({ label, value }) => (
            <div key={label} className="flex items-center justify-between text-[11px]">
              <span className="text-muted-foreground font-mono">{label}</span>
              <span className="font-mono font-medium">{value}</span>
            </div>
          ))}
        </div>

        {/* Daily Limits Progress */}
        {data?.dailyState && (
          <div className="mt-3 pt-3 border-t border-border/20">
            <div className="flex items-center justify-between text-[10px] mb-1">
              <span className="text-muted-foreground font-mono">Daily Usage</span>
              <span className="font-mono">{data.dailyState.tradesExecuted}/{config.MAX_TRADES_PER_DAY}</span>
            </div>
            <div className="h-1.5 rounded-full bg-muted/30 overflow-hidden">
              <div
                className="h-full rounded-full bg-primary/60 transition-all duration-500"
                style={{ width: `${(data.dailyState.tradesExecuted / config.MAX_TRADES_PER_DAY) * 100}%` }}
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
