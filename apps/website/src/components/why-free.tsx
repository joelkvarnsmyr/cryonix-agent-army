'use client';

import { useTranslations } from 'next-intl';
import { Users, Brain, Eye, HandshakeIcon } from 'lucide-react';

const REASON_ICONS = [Users, Brain, Eye, HandshakeIcon] as const;

export function WhyFree() {
  const t = useTranslations('why_free');

  return (
    <section className="py-20 md:py-28 relative">
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-success/[0.015] to-transparent" />

      <div className="container relative">
        <div className="max-w-2xl mx-auto text-center mb-12 md:mb-16">
          <div className="text-xs font-mono text-success/70 uppercase tracking-widest mb-3">
            {t('label')}
          </div>
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight mb-4">
            {t('title')}
          </h2>
          <p className="text-muted-foreground leading-relaxed">
            {t('subtitle')}
          </p>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 max-w-4xl mx-auto">
          {REASON_ICONS.map((Icon, i) => (
            <div
              key={i}
              className="glass-card rounded-xl p-5 space-y-3 hover:border-success/20 transition-colors group"
            >
              <div className="w-9 h-9 rounded-lg bg-success/10 text-success flex items-center justify-center group-hover:bg-success/15 transition-colors">
                <Icon className="h-4 w-4" />
              </div>
              <h3 className="font-semibold text-sm">{t(`reasons.${i}.title`)}</h3>
              <p className="text-xs text-muted-foreground leading-relaxed">
                {t(`reasons.${i}.description`)}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
