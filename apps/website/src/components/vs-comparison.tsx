'use client';

import { useTranslations } from 'next-intl';
import { Check, X, Minus } from 'lucide-react';

function ComparisonRow({
  feature,
  cryonix,
  vip,
}: {
  feature: string;
  cryonix: 'yes' | 'no' | 'partial';
  vip: 'yes' | 'no' | 'partial';
}) {
  const icon = (v: string) => {
    if (v === 'yes') return <Check className="h-4 w-4 text-success" />;
    if (v === 'no') return <X className="h-4 w-4 text-destructive/60" />;
    return <Minus className="h-4 w-4 text-warning/60" />;
  };

  return (
    <div className="grid grid-cols-[1fr_80px_80px] md:grid-cols-[1fr_120px_120px] items-center py-3 border-b border-border/15 last:border-0">
      <span className="text-sm text-muted-foreground">{feature}</span>
      <span className="flex justify-center">{icon(cryonix)}</span>
      <span className="flex justify-center">{icon(vip)}</span>
    </div>
  );
}

export function VsComparison() {
  const t = useTranslations('comparison');

  const rows = [
    { key: 'free', cryonix: 'yes' as const, vip: 'no' as const },
    { key: 'ai_validated', cryonix: 'yes' as const, vip: 'no' as const },
    { key: 'transparent_pnl', cryonix: 'yes' as const, vip: 'no' as const },
    { key: 'backtested', cryonix: 'yes' as const, vip: 'no' as const },
    { key: 'risk_management', cryonix: 'yes' as const, vip: 'partial' as const },
    { key: 'auto_sl_tp', cryonix: 'yes' as const, vip: 'partial' as const },
    { key: 'self_improving', cryonix: 'yes' as const, vip: 'no' as const },
    { key: 'fail_closed', cryonix: 'yes' as const, vip: 'no' as const },
    { key: 'multi_source', cryonix: 'yes' as const, vip: 'no' as const },
    { key: 'open_history', cryonix: 'yes' as const, vip: 'no' as const },
  ];

  return (
    <section className="py-20 md:py-28">
      <div className="container">
        <div className="max-w-2xl mx-auto text-center mb-12 md:mb-16">
          <div className="text-xs font-mono text-primary/60 uppercase tracking-widest mb-3">
            {t('label')}
          </div>
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight mb-4">
            {t('title')}
          </h2>
          <p className="text-muted-foreground leading-relaxed">
            {t('subtitle')}
          </p>
        </div>

        <div className="max-w-2xl mx-auto">
          <div className="glass-card rounded-2xl overflow-hidden">
            {/* Header */}
            <div className="grid grid-cols-[1fr_80px_80px] md:grid-cols-[1fr_120px_120px] items-center p-4 border-b border-border/30 bg-primary/[0.02]">
              <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
                {t('feature')}
              </span>
              <span className="text-center">
                <span className="text-xs font-bold text-primary">Cryonix</span>
              </span>
              <span className="text-center">
                <span className="text-xs font-bold text-muted-foreground">{t('vip_groups')}</span>
              </span>
            </div>

            {/* Rows */}
            <div className="px-4">
              {rows.map((row) => (
                <ComparisonRow
                  key={row.key}
                  feature={t(`rows.${row.key}`)}
                  cryonix={row.cryonix}
                  vip={row.vip}
                />
              ))}
            </div>

            {/* Price row */}
            <div className="grid grid-cols-[1fr_80px_80px] md:grid-cols-[1fr_120px_120px] items-center p-4 border-t border-border/30 bg-muted/10">
              <span className="text-sm font-medium">{t('price')}</span>
              <span className="text-center">
                <span className="text-lg font-bold text-success font-mono">$0</span>
              </span>
              <span className="text-center">
                <span className="text-sm font-mono text-muted-foreground">$50-300<span className="text-xs">/mo</span></span>
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
