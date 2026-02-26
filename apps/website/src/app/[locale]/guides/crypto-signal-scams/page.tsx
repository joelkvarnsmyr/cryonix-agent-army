import { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AlertTriangle, Ghost, Search, ChevronRight, XCircle, CheckCircle2 } from 'lucide-react';
import Link from 'next/link';
import { RecommendedReading } from '@/components/recommended-reading';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'guides.scam_spotting' });

  return {
    title: t('title'),
    description: t('subtitle'),
  };
}

export default async function ScamSpottingGuide() {
  const t = await getTranslations('guides.scam_spotting');
  const navT = await getTranslations('nav');

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": t('title'),
    "description": t('subtitle'),
    "image": "https://cryonix.ai/images/guides/crypto-signal-scams.jpg",
    "author": {
      "@type": "Organization",
      "name": "Cryonix"
    },
    "publisher": {
      "@type": "Organization",
      "name": "Cryonix"
    },
    "datePublished": "2026-02-26T00:00:00.000Z"
  };

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      {
        "@type": "ListItem",
        "position": 1,
        "name": navT('home'),
        "item": "https://cryonix.ai/"
      },
      {
        "@type": "ListItem",
        "position": 2,
        "name": navT('guides'),
        "item": "https://cryonix.ai/guides"
      },
      {
        "@type": "ListItem",
        "position": 3,
        "name": "Scam Spotting",
        "item": "https://cryonix.ai/guides/crypto-signal-scams"
      }
    ]
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />
      <article className="py-12 md:py-20 max-w-4xl mx-auto px-4">
        <nav className="flex items-center gap-2 text-sm text-muted-foreground mb-8">
          <Link href="/" className="hover:text-primary transition-colors">{navT('home')}</Link>
          <ChevronRight className="h-4 w-4" />
          <Link href="/guides" className="hover:text-primary transition-colors">{navT('guides')}</Link>
          <ChevronRight className="h-4 w-4" />
          <span className="text-foreground font-medium">Scam Spotting</span>
        </nav>

        <header className="space-y-8 mb-12">
          <div className="aspect-video w-full rounded-3xl overflow-hidden border border-border/40 relative">
            <img 
              src="/images/guides/crypto-signal-scams.jpg" 
              alt={t('title')}
              className="object-cover w-full h-full"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-background via-transparent to-transparent" />
          </div>

          <div className="space-y-6">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-red-500/10 border border-red-500/20 text-red-500 text-xs font-bold uppercase tracking-wider">
              <AlertTriangle className="h-3 w-3" /> Warning Guide
            </div>
            <h1 className="text-4xl md:text-5xl font-bold tracking-tight leading-tight">
              {t('title')}
            </h1>
            <p className="text-xl text-muted-foreground font-light leading-relaxed">
              {t('subtitle')}
            </p>
          </div>
        </header>

        <div className="prose prose-invert max-w-none">
          <p className="text-lg leading-relaxed mb-8">{t('intro')}</p>

          <h2 className="text-2xl font-bold mt-12 mb-6 flex items-center gap-2">
            <Ghost className="text-purple-400 h-6 w-6" />
            The "Ghost" Edit Trick
          </h2>
          <p>One of the most common ways Telegram signal groups fake their success is by editing messages after a price move has already happened. They post 10 signals, delete the 8 that failed, and 'edit' the 2 that succeeded.</p>

          <h2 className="text-3xl font-bold mt-20 mb-8">Scam Checklist</h2>
          <div className="grid gap-4">
            {[
              { q: "Do they provide a Stop Loss?", a: "Scams often omit Stop Losses so they never have to report a 'loss'." },
              { q: "Is there a public dashboard?", a: "If the only proof is a manual list of 'Wins', it's likely fake." },
              { q: "Do they promise fixed returns?", a: "Anyone promising '2% daily profit' is running a scam." }
            ].map((item, i) => (
              <div key={i} className="glass-card p-6 rounded-xl border-border/40">
                <h3 className="font-bold mb-2 text-foreground">{item.q}</h3>
                <p className="text-sm text-muted-foreground">{item.a}</p>
              </div>
            ))}
          </div>

          <div className="glass-card rounded-2xl p-8 my-16 border-green-500/20 bg-green-500/5">
            <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
              <CheckCircle2 className="text-green-500 h-6 w-6" />
              The Cryonix Difference
            </h2>
            <p className="mb-6">We built Cryonix to solve the trust problem. Every trade is logged automatically. We don't edit, we don't delete, and we show the losses clearly.</p>
            <Link href="/performance" className="text-primary font-bold flex items-center gap-2 hover:gap-3 transition-all">
              View our real-time performance <ChevronRight className="h-4 w-4" />
            </Link>
          </div>
        </div>

        <RecommendedReading currentSlug="crypto-signal-scams" />
      </article>
    </>
  );
}
