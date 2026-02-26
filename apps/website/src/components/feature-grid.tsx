import { useTranslations } from 'next-intl';
import { ScanLine, Brain, ShieldCheck } from 'lucide-react';

const ICONS = [ScanLine, Brain, ShieldCheck] as const;
const KEYS = ['pattern', 'validation', 'risk'] as const;

export function FeatureGrid() {
  const t = useTranslations('features');

  return (
    <section className="py-16 md:py-24">
      <div className="container">
        <h2 className="text-2xl md:text-3xl font-bold text-center mb-12">
          {t('title')}
        </h2>
        <div className="grid md:grid-cols-3 gap-6">
          {KEYS.map((key, i) => {
            const Icon = ICONS[i];
            return (
              <div
                key={key}
                className="glass-card rounded-xl p-6 space-y-4 hover:border-primary/20 transition-colors"
              >
                <div className="inline-flex items-center justify-center w-10 h-10 rounded-lg bg-primary/10 text-primary">
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="text-lg font-semibold">{t(`${key}.title`)}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {t(`${key}.description`)}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
