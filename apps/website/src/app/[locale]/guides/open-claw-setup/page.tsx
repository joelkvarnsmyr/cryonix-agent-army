import { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ChevronRight, Terminal, Cpu, Bot, Key, CheckCircle2, Info } from 'lucide-react';
import Link from 'next/link';
import { RecommendedReading } from '@/components/recommended-reading';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'guides.open_claw' });

  return {
    title: t('title'),
    description: t('subtitle'),
  };
}

export default async function OpenClawGuide() {
  const t = await getTranslations('guides.open_claw');
  const navT = await getTranslations('nav');

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "HowTo",
    "name": t('title'),
    "description": t('subtitle'),
    "image": "https://cryonix.ai/images/guides/open-claw-setup.jpg",
    "step": [
      {
        "@type": "HowToStep",
        "name": "Get Your Pairing Code",
        "text": "Sign in to your account and generate a unique pairing code."
      },
      {
        "@type": "HowToStep",
        "name": "Configure Open Claw",
        "text": "Add MCP_SERVERS and CRYONIX_API_KEY to your agent settings."
      }
    ]
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
        "name": "Open Claw Setup",
        "item": "https://cryonix.ai/guides/open-claw-setup"
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
          <span className="text-foreground font-medium text-glow-cyan text-xs uppercase tracking-widest">Bot Integration</span>
        </nav>

        <header className="space-y-8 mb-12 border-b border-border/40 pb-12">
          <div className="aspect-video w-full rounded-3xl overflow-hidden border border-border/40 relative">
            <img 
              src="/images/guides/open-claw-setup.jpg" 
              alt={t('title')}
              className="object-cover w-full h-full"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-background via-transparent to-transparent" />
          </div>

          <div className="space-y-6">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 text-primary text-xs font-bold uppercase tracking-wider">
              <Bot className="h-3 w-3" /> Autonomous Agents
            </div>
            <h1 className="text-4xl md:text-5xl font-bold tracking-tight leading-tight">
              {t('title')}
            </h1>
            <p className="text-xl text-muted-foreground font-light">
              {t('subtitle')}
            </p>
          </div>
        </header>

        <section className="prose prose-invert max-w-none">
          <p className="text-lg leading-relaxed mb-8">{t('intro')}</p>

          <h2 className="text-2xl font-bold mt-12 mb-6 flex items-center gap-2">
            <Key className="text-primary h-6 w-6" />
            Step 1: Get Your Pairing Code
          </h2>
          <p>First, you need a secure connection. We call this a <strong>Pairing Code</strong>.</p>
          <ol className="space-y-4">
            <li>Go to your <Link href="/developers" className="text-primary underline">Account Dashboard</Link>.</li>
            <li>Sign in using your Email or GitHub.</li>
            <li>Click <strong>"Create Pairing Code"</strong>.</li>
          </ol>

          <div className="bg-primary/10 border border-primary/20 rounded-2xl p-8 my-16 text-center">
            <h2 className="text-2xl font-bold mb-4 flex items-center justify-center gap-2">
              <Cpu className="h-6 w-6 text-primary" />
              Grow Your Capital
            </h2>
            <p className="mb-8 text-muted-foreground">Signals optimized for portfolios starting at 400 SEK.</p>
            <Link 
              href="/developers" 
              className="inline-block bg-primary hover:bg-primary/90 text-primary-foreground px-8 py-4 rounded-full font-bold transition-all"
            >
              Start Automation Now
            </Link>
          </div>
        </section>

        <RecommendedReading currentSlug="open-claw-setup" />
      </article>
    </>
  );
}
