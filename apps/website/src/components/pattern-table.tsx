import { useTranslations } from 'next-intl';
import type { PatternStat } from '@/lib/api';

const PATTERN_LABELS: Record<string, string> = {
  dip_buy: 'Dip Buy',
  deep_value_crash: 'Deep Value Crash',
  bollinger_squeeze: 'Bollinger Squeeze',
  rsi_oversold: 'RSI Oversold',
  volume_spike_up: 'Volume Spike',
  macd_bullish_cross: 'MACD Bullish Cross',
  ema_bullish_cross: 'EMA Bullish Cross',
  momentum_gainer: 'Momentum Gainer',
};

export function PatternTable({ patterns }: { patterns: PatternStat[] }) {
  const t = useTranslations('performance');

  if (patterns.length === 0) return null;

  return (
    <div className="glass-card rounded-xl overflow-hidden">
      <div className="p-4 border-b border-border/40">
        <h3 className="font-semibold">{t('pattern_breakdown')}</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/40 text-muted-foreground">
              <th className="text-left p-3 font-medium">{t('pattern_name')}</th>
              <th className="text-right p-3 font-medium">{t('trades')}</th>
              <th className="text-right p-3 font-medium">{t('win_rate')}</th>
            </tr>
          </thead>
          <tbody>
            {patterns.map((p) => (
              <tr key={p.name} className="border-b border-border/20 hover:bg-muted/20">
                <td className="p-3 font-medium">
                  {PATTERN_LABELS[p.name] || p.name}
                </td>
                <td className="p-3 text-right font-mono text-muted-foreground">
                  {p.trades}
                </td>
                <td className={`p-3 text-right font-mono font-medium ${
                  p.winRate >= 60 ? 'text-success' : p.winRate >= 40 ? 'text-warning' : 'text-destructive'
                }`}>
                  {p.winRate}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
