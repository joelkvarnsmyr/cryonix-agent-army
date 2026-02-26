'use client';

import { useTranslations } from 'next-intl';
import { Tooltip } from './tooltip';
import type { ClosedSignal, BuySignal } from '@/lib/api';

const PATTERN_LABELS: Record<string, string> = {
  dip_buy: 'Dip Buy',
  deep_value_crash: 'Deep Value',
  bollinger_squeeze: 'Bollinger',
  rsi_oversold: 'RSI Oversold',
  volume_spike_up: 'Volume Spike',
  macd_bullish_cross: 'MACD Cross',
  ema_bullish_cross: 'EMA Cross',
  momentum_gainer: 'Momentum',
};

function PatternBadge({ pattern }: { pattern: string | null }) {
  const t = useTranslations('tooltips');
  if (!pattern) return null;
  const label = PATTERN_LABELS[pattern] || pattern;
  return (
    <Tooltip content={t('pattern')}>
      <span className="inline-flex px-2 py-0.5 rounded text-xs font-medium bg-primary/10 text-primary border border-primary/20 cursor-help">
        {label}
      </span>
    </Tooltip>
  );
}

function fmtPrice(p: number) {
  if (p < 0.01) return p.toFixed(8);
  if (p < 1) return p.toFixed(6);
  if (p < 100) return p.toFixed(4);
  return p.toFixed(2);
}

export function ClosedSignalCard({ signal }: { signal: ClosedSignal }) {
  const t = useTranslations('tooltips');
  const isWin = signal.pnlPercent > 0;
  const isLoss = signal.pnlPercent < 0;
  const holdStr = signal.holdingPeriodH < 1
    ? `${Math.round(signal.holdingPeriodH * 60)}min`
    : `${signal.holdingPeriodH.toFixed(1)}h`;

  return (
    <div className="glass-card rounded-xl p-4 space-y-3 hover:border-primary/30 transition-colors">
      <div className="flex items-center justify-between">
        <span className="font-mono font-bold text-sm">{signal.symbol}</span>
        <Tooltip content={t('pnl')}>
          <span
            className={`font-mono font-bold text-sm cursor-help ${
              isWin ? 'text-success text-glow-green' : isLoss ? 'text-destructive text-glow-red' : 'text-muted-foreground'
            }`}
          >
            {signal.pnlPercent > 0 ? '+' : ''}{signal.pnlPercent.toFixed(2)}%
          </span>
        </Tooltip>
      </div>
      <div className="text-xs text-muted-foreground space-y-1">
        <div className="flex justify-between items-center">
          <Tooltip content={`${t('entry')} → ${t('exit')}`}>
            <span className="cursor-help">${fmtPrice(signal.entryPrice)} → ${fmtPrice(signal.exitPrice)}</span>
          </Tooltip>
          <Tooltip content={t('hold')}>
            <span className="cursor-help">{holdStr}</span>
          </Tooltip>
        </div>
        <div className="flex items-center gap-2">
          <PatternBadge pattern={signal.pattern} />
          {signal.closeReason && (
            <span className="text-muted-foreground/60">{signal.closeReason}</span>
          )}
        </div>
      </div>
    </div>
  );
}

export function BuySignalCard({ signal }: { signal: BuySignal }) {
  const t = useTranslations('tooltips');
  return (
    <div className="glass-card rounded-xl p-4 space-y-3 border-l-2 border-l-primary/40 hover:border-l-primary transition-all">
      <div className="flex items-center justify-between">
        <span className="font-mono font-bold text-sm">{signal.symbol}</span>
        <span className="text-xs font-medium text-primary">BUY</span>
      </div>
      <div className="text-xs text-muted-foreground space-y-1">
        <div className="flex justify-between items-center">
          <Tooltip content={t('entry')}>
            <span className="cursor-help">Entry: ${fmtPrice(signal.entryPrice)}</span>
          </Tooltip>
          <Tooltip content={t('confidence')}>
            <span className="cursor-help">Conf: {Math.round(signal.confidence * 100)}%</span>
          </Tooltip>
        </div>
        <PatternBadge pattern={signal.pattern} />
      </div>
    </div>
  );
}
