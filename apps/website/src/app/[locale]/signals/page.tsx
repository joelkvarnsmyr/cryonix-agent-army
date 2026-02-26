import { getTranslations } from 'next-intl/server';
import { Metadata } from 'next';
import { ClosedSignalCard, BuySignalCard } from '@/components/signal-card';
import { TelegramBanner } from '@/components/telegram-banner';
import { fetchSignals } from '@/lib/api';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'signals' });

  return {
    title: t('title'),
    description: t('subtitle'),
  };
}

export const revalidate = 60;

export default async function SignalsPage() {
  const t = await getTranslations('signals');

  let closed: any[] = [];
  let buys: any[] = [];

  try {
    const data = await fetchSignals();
    closed = data.closed;
    buys = data.buys;
  } catch {
    // API not available
  }

  const isEmpty = closed.length === 0 && buys.length === 0;

  const perfT = await getTranslations('performance');

  return (
    <div className="py-12 md:py-16">
      <div className="container space-y-12">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-glow-cyan">{t('title')}</h1>
            <p className="text-muted-foreground mt-2">{t('subtitle')}</p>
          </div>

          <div className="glass-card px-6 py-4 rounded-2xl border-primary/20 bg-primary/5 max-w-sm">
            <h3 className="text-sm font-bold text-primary mb-1 flex items-center gap-2">
              <div className="h-2 w-2 rounded-full bg-primary animate-pulse" />
              {perfT('level_banner.title')}
            </h3>
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              {perfT('level_banner.desc')}
            </p>
          </div>
        </div>

        {isEmpty ? (
          <div className="glass-card rounded-xl p-12 text-center">
            <p className="text-muted-foreground">{t('empty')}</p>
          </div>
        ) : (
          <>
            {/* Recent BUY entries */}
            {buys.length > 0 && (
              <section>
                <h2 className="text-xl font-semibold mb-4">{t('recent_buys')}</h2>
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {buys.map((s, i) => (
                    <BuySignalCard key={i} signal={s} />
                  ))}
                </div>
              </section>
            )}

            {/* Closed trades */}
            {closed.length > 0 && (
              <section>
                <h2 className="text-xl font-semibold mb-4">{t('closed')}</h2>
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {closed.map((s, i) => (
                    <ClosedSignalCard key={i} signal={s} />
                  ))}
                </div>
              </section>
            )}
          </>
        )}

        <TelegramBanner />
      </div>
    </div>
  );
}
