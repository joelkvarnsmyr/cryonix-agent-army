import { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ShieldAlert, ShieldCheck, Zap, Lock, ChevronRight, Info } from 'lucide-react';
import Link from 'next/link';
import { RecommendedReading } from '@/components/recommended-reading';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'guides.fail_closed' });

  return {
    title: t('title'),
    description: t('subtitle'),
  };
}

export default async function FailClosedGuide() {
  const t = await getTranslations('guides.fail_closed');
  const navT = await getTranslations('nav');

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": t('title'),
    "description": t('subtitle'),
    "image": "https://cryonix.ai/images/guides/fail-closed-trading.jpg",
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
        "name": "Fail-Closed Approach",
        "item": "https://cryonix.ai/guides/fail-closed-trading"
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
          <span className="text-foreground font-medium">Fail-Closed Approach</span>
        </nav>

        <header className="space-y-8 mb-12">
          <div className="aspect-video w-full rounded-3xl overflow-hidden border border-border/40 relative">
            <img 
              src="/images/guides/fail-closed-trading.jpg" 
              alt={t('title')}
              className="object-cover w-full h-full"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-background via-transparent to-transparent" />
          </div>

          <div className="space-y-6">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-green-500/10 border border-green-500/20 text-green-500 text-xs font-bold uppercase tracking-wider">
              <ShieldCheck className="h-3 w-3" /> Safety First
            </div>
            <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-glow-cyan leading-tight">
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
            <ShieldAlert className="text-red-500 h-6 w-6" />
            The Problem: Fail-Open Systems
          </h2>
          <p>Most trading bots are 'Fail-Open'. They execute trades even if AI validation is uncertain. Cryonix uses a 'Fail-Closed' architecture: if our AI validation isn't 100% confident, the trade never happens.</p>
          
          <h2 className="text-2xl font-bold mt-16 mb-6">3 Layers of Safety</h2>
          <div className="space-y-8">
            <div className="flex gap-4">
              <div className="h-10 w-10 rounded-full bg-primary/20 flex items-center justify-center text-primary shrink-0">1</div>
              <div>
                <h3 className="font-bold text-lg mb-1">Technical Consensus</h3>
                <p className="text-muted-foreground">At least 3 technical indicators must align.</p>
              </div>
            </div>
            <div className="flex gap-4">
              <div className="h-10 w-10 rounded-full bg-primary/20 flex items-center justify-center text-primary shrink-0">2</div>
              <div>
                <h3 className="font-bold text-lg mb-1">AI Discretion</h3>
                <p className="text-muted-foreground">The AI brain must approve the logic with &gt;70% confidence.</p>
              </div>
            </div>
          </div>
        </div>

        <RecommendedReading currentSlug="fail-closed-trading" />

        <footer className="mt-20 pt-8 border-t border-border/40 text-sm text-muted-foreground flex items-center gap-2">
          <Info className="h-4 w-4" />
          <span>Published Feb 26, 2026. Trading involves risk.</span>
        </footer>
      </article>
    </>
  );
}
