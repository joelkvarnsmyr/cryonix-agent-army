'use client';

import { useTranslations } from 'next-intl';
import {
  ShieldCheck,
  CircuitBoard,
  Target,
  Timer,
  Scale,
} from 'lucide-react';

const RISK_ICONS = [ShieldCheck, CircuitBoard, Target, Timer, Scale] as const;

export function RiskArchitecture() {
  const t = useTranslations('risk_section');

  return (
    <section className="py-20 md:py-28 relative">
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-warning/[0.01] to-transparent" />

      <div className="container relative">
        <div className="grid lg:grid-cols-[1fr_1.2fr] gap-12 lg:gap-16 items-start">
          {/* Left: header */}
          <div className="lg:sticky lg:top-24">
            <div className="text-xs font-mono text-warning/70 uppercase tracking-widest mb-3">
              {t('label')}
            </div>
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight mb-4">
              {t('title')}
            </h2>
            <p className="text-muted-foreground leading-relaxed mb-8">
              {t('subtitle')}
            </p>

            {/* Key numbers */}
            <div className="grid grid-cols-2 gap-3">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="glass-card rounded-lg p-3 space-y-1">
                  <div className="text-xl font-bold font-mono text-glow-cyan">
                    {t(`numbers.${i}.value`)}
                  </div>
                  <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">
                    {t(`numbers.${i}.label`)}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Right: risk layers */}
          <div className="space-y-3">
            {RISK_ICONS.map((Icon, i) => (
              <div
                key={i}
                className="glass-card rounded-xl p-5 hover:border-warning/15 transition-colors group"
              >
                <div className="flex items-start gap-4">
                  <div className="w-9 h-9 rounded-lg bg-warning/10 text-warning flex items-center justify-center flex-shrink-0 group-hover:bg-warning/15 transition-colors">
                    <Icon className="h-4 w-4" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-sm mb-1">{t(`layers.${i}.title`)}</h3>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      {t(`layers.${i}.description`)}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
