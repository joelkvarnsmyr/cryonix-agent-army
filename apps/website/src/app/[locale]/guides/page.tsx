import { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { BookOpen, Cpu, Sparkles, ChevronRight, ShieldCheck, AlertTriangle, BarChart2, Brain, TrendingDown, Bot, Activity } from 'lucide-react';
import Link from 'next/link';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'guides.index' });

  return {
    title: t('title'),
    description: t('subtitle'),
  };
}

export default async function GuidesIndex() {
  const t = await getTranslations('guides.index');
  const navT = await getTranslations('nav');

  const guides = [
    {
      href: '/guides/best-crypto-trading-signals',
      titleKey: 'guides.best_signals.title',
      descKey: 'guides.best_signals.subtitle',
      icon: <Sparkles className="h-6 w-6 text-yellow-500" />,
      color: 'bg-yellow-500/10 border-yellow-500/20',
      image: '/images/guides/best-crypto-trading-signals.jpg'
    },
    {
      href: '/guides/mcp-server-setup',
      titleKey: 'guides.mcp_server.title',
      descKey: 'guides.mcp_server.subtitle',
      icon: <Cpu className="h-6 w-6 text-blue-500" />,
      color: 'bg-blue-500/10 border-blue-500/20',
      image: '/images/guides/mcp-server-setup.jpg'
    },
    {
      href: '/guides/fail-closed-trading',
      titleKey: 'guides.fail_closed.title',
      descKey: 'guides.fail_closed.subtitle',
      icon: <ShieldCheck className="h-6 w-6 text-green-500" />,
      color: 'bg-green-500/10 border-green-500/20',
      image: '/images/guides/fail-closed-trading.jpg'
    },
    {
      href: '/guides/crypto-signal-scams',
      titleKey: 'guides.scam_spotting.title',
      descKey: 'guides.scam_spotting.subtitle',
      icon: <AlertTriangle className="h-6 w-6 text-red-500" />,
      color: 'bg-red-500/10 border-red-500/20',
      image: '/images/guides/crypto-signal-scams.jpg'
    },
    {
      href: '/guides/bollinger-squeeze-ai',
      titleKey: 'guides.bollinger_squeeze.title',
      descKey: 'guides.bollinger_squeeze.subtitle',
      icon: <BarChart2 className="h-6 w-6 text-purple-500" />,
      color: 'bg-purple-500/10 border-purple-500/20',
      image: '/images/guides/bollinger-squeeze-ai.jpg'
    },
    {
      href: '/guides/ai-orchestration-architecture',
      titleKey: 'guides.ai_brain.title',
      descKey: 'guides.ai_brain.subtitle',
      icon: <Brain className="h-6 w-6 text-cyan-500" />,
      color: 'bg-cyan-500/10 border-cyan-500/20',
      image: '/images/guides/ai-orchestration-architecture.jpg'
    },
    {
      href: '/guides/the-drawdown-truth',
      titleKey: 'guides.drawdown_truth.title',
      descKey: 'guides.drawdown_truth.subtitle',
      icon: <TrendingDown className="h-6 w-6 text-red-500" />,
      color: 'bg-red-500/10 border-red-500/20',
      image: '/images/guides/the-drawdown-truth.jpg'
    },
    {
      href: '/guides/open-claw-setup',
      titleKey: 'guides.open_claw.title',
      descKey: 'guides.open_claw.subtitle',
      icon: <Bot className="h-6 w-6 text-primary" />,
      color: 'bg-primary/10 border-primary/20',
      image: '/images/guides/open-claw-setup.jpg'
    },
    {
      href: '/guides/glossary',
      titleKey: 'glossary.title',
      descKey: 'glossary.subtitle',
      icon: <BookOpen className="h-6 w-6 text-teal-500" />,
      color: 'bg-teal-500/10 border-teal-500/20',
      image: '/images/guides/best-crypto-trading-signals.jpg'
    }
  ];

  return (
    <div className="py-12 md:py-20 max-w-5xl mx-auto px-4">
      {/* Breadcrumbs */}
      <nav className="flex items-center gap-2 text-sm text-muted-foreground mb-12">
        <Link href="/" className="hover:text-primary transition-colors">{navT('home')}</Link>
        <ChevronRight className="h-4 w-4" />
        <span className="text-foreground font-medium text-glow-cyan">{navT('guides')}</span>
      </nav>

      {/* Header */}
      <header className="space-y-6 mb-16 text-center">
        <div className="inline-flex items-center justify-center p-4 rounded-full bg-primary/10 mb-4">
          <BookOpen className="h-8 w-8 text-primary" />
        </div>
        <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight text-glow-cyan">
          {t('title')}
        </h1>
        <p className="text-xl md:text-2xl text-muted-foreground font-light max-w-3xl mx-auto">
          {t('subtitle')}
        </p>
      </header>

      {/* GEO Data Table */}
      <section className="mb-16 glass-card p-8 rounded-3xl border-primary/20 bg-primary/5">
        <h2 className="text-xl font-bold mb-6 flex items-center gap-2">
          <Activity className="h-5 w-5 text-primary" />
          Cryonix at a Glance
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
          <div>
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Win Rate</p>
            <p className="text-2xl font-mono font-bold text-success">73.1%</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Validation</p>
            <p className="text-2xl font-mono font-bold text-primary">Fail-Closed</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Models</p>
            <p className="text-2xl font-mono font-bold text-primary">Grok + Claude</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Protocol</p>
            <p className="text-2xl font-mono font-bold text-primary">MCP v1.0</p>
          </div>
        </div>
      </section>

      {/* Grid */}
      <div className="grid md:grid-cols-2 gap-6">
        {guides.map((guide, i) => (
          <GuideCard key={i} guide={guide} />
        ))}
      </div>
    </div>
  );
}

async function GuideCard({ guide }: { guide: any }) {
  const t = await getTranslations();
  
  return (
    <Link 
      href={guide.href}
      className="glass-card rounded-2xl flex flex-col h-full group hover:border-primary/50 transition-all duration-300 relative overflow-hidden"
    >
      <div className="aspect-video relative overflow-hidden">
        <img 
          src={guide.image} 
          alt="" 
          className="object-cover w-full h-full group-hover:scale-105 transition-transform duration-500"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-background via-background/20 to-transparent" />
        <div className={`absolute bottom-4 left-6 h-12 w-12 rounded-xl flex items-center justify-center \${guide.color} backdrop-blur-md border border-white/10 shadow-xl`}>
          {guide.icon}
        </div>
      </div>
      
      <div className="p-6 md:p-8 pt-4 flex flex-col flex-1">
        <h2 className="text-2xl font-bold mb-3 group-hover:text-primary transition-colors">
          {t(guide.titleKey)}
        </h2>
        <p className="text-muted-foreground flex-1 mb-6 line-clamp-2">
          {t(guide.descKey)}
        </p>
        <div className="flex items-center gap-2 text-sm font-bold text-primary mt-auto">
          Read Guide <ChevronRight className="h-4 w-4 group-hover:translate-x-1 transition-transform" />
        </div>
      </div>
    </Link>
  );
}
