import { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ChevronRight, Terminal, Cpu, Settings, Code, Bot, Zap, Info, TrendingUp } from 'lucide-react';
import Link from 'next/link';
import { RecommendedReading } from '@/components/recommended-reading';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'guides.mcp_server' });

  return {
    title: t('title'),
    description: t('subtitle'),
  };
}

export default async function McpServerGuide() {
  const t = await getTranslations('guides.mcp_server');
  const navT = await getTranslations('nav');

  return (
    <article className="py-12 md:py-20 max-w-4xl mx-auto px-4">
      {/* Breadcrumbs */}
      <nav className="flex items-center gap-2 text-sm text-muted-foreground mb-8">
        <Link href="/" className="hover:text-primary transition-colors">{navT('home')}</Link>
        <ChevronRight className="h-4 w-4" />
        <Link href="/guides/best-crypto-trading-signals" className="hover:text-primary transition-colors">{navT('guides')}</Link>
        <ChevronRight className="h-4 w-4" />
        <span className="text-foreground font-medium text-glow-cyan">MCP Server</span>
      </nav>

      {/* Header */}
      <header className="space-y-8 mb-12 border-b border-border/40 pb-12">
        <div className="aspect-video w-full rounded-3xl overflow-hidden border border-border/40 relative">
          <img 
            src="/images/guides/mcp-server-setup.jpg" 
            alt={t('title')}
            className="object-cover w-full h-full"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-background via-transparent to-transparent" />
        </div>

        <div className="space-y-6">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 text-primary text-xs font-bold uppercase tracking-wider">
            <Cpu className="h-3 w-3" /> Agent Integration
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
        <div className="flex gap-4 p-6 rounded-2xl bg-blue-500/5 border border-blue-500/20 mb-12">
          <Info className="h-6 w-6 text-blue-400 shrink-0" />
          <p className="text-sm text-blue-100/80 m-0">
            <strong>What is MCP?</strong> The Model Context Protocol (MCP) is an open standard that enables AI models to safely access local and remote data sources. By using our MCP server, your AI agent becomes a "Trading Specialist".
          </p>
        </div>

        <p className="text-lg leading-relaxed mb-8">{t('intro')}</p>

        <h2 className="text-2xl font-bold mt-12 mb-6 flex items-center gap-2">
          <Terminal className="text-primary h-6 w-6" />
          {t('setup_claude')}
        </h2>
        <p>To use Cryonix signals in <strong>Claude Desktop</strong>, add the following to your <code>claude_desktop_config.json</code>:</p>
        
        <pre className="bg-black/50 p-6 rounded-xl border border-border/40 overflow-x-auto">
          <code className="text-cyan-400">
{`{
  "mcpServers": {
    "cryonix": {
      "command": "npx",
      "args": ["-y", "@cryonix/mcp-server"],
      "env": {
        "CRYONIX_API_KEY": "YOUR_FREE_KEY"
      }
    }
  }
}`}
          </code>
        </pre>

        <h2 className="text-2xl font-bold mt-16 mb-6 flex items-center gap-2">
          <Bot className="text-primary h-6 w-6" />
          {t('setup_openhands')}
        </h2>
        <p>In <strong>OpenHands</strong> (or similar agent frameworks), you can mount the MCP server via Docker or by adding the environment configuration in your workspace settings.</p>
        <div className="glass-card p-6 rounded-xl border-primary/20">
          <ol className="space-y-4 m-0">
            <li className="flex gap-3">
              <span className="h-6 w-6 rounded-full bg-primary/20 text-primary flex items-center justify-center text-xs font-bold shrink-0">1</span>
              <span>Open your <code>.env</code> file or project settings.</span>
            </li>
            <li className="flex gap-3">
              <span className="h-6 w-6 rounded-full bg-primary/20 text-primary flex items-center justify-center text-xs font-bold shrink-0">2</span>
              <span>Add <code>MCP_SERVERS=cryonix=https://mcp.cryonix.ai</code> (using our hosted bridge).</span>
            </li>
            <li className="flex gap-3">
              <span className="h-6 w-6 rounded-full bg-primary/20 text-primary flex items-center justify-center text-xs font-bold shrink-0">3</span>
              <span>Your agent will now see tools like <code>get_latest_signals()</code> and <code>get_market_sentiment()</code>.</span>
            </li>
          </ol>
        </div>

        <h2 className="text-2xl font-bold mt-16 mb-6 flex items-center gap-2">
          <Code className="text-primary h-6 w-6" />
          {t('features')}
        </h2>
        <div className="grid md:grid-cols-2 gap-4">
          <div className="p-4 rounded-xl border border-border/40 bg-white/5">
            <h3 className="font-bold text-sm mb-2 flex items-center gap-2">
              <Zap className="h-4 w-4 text-yellow-500" /> get_signals
            </h3>
            <p className="text-xs text-muted-foreground">Fetch the latest BUY/CLOSE signals with AI confidence levels and entry/exit targets.</p>
          </div>
          <div className="p-4 rounded-xl border border-border/40 bg-white/5">
            <h3 className="font-bold text-sm mb-2 flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-green-500" /> get_performance
            </h3>
            <p className="text-xs text-muted-foreground">Retrieve real-time win rate, average profit, and strategy breakdown for the last 30 days.</p>
          </div>
        </div>

        <div className="bg-primary/10 border border-primary/20 rounded-2xl p-8 my-16 flex flex-col items-center text-center">
          <Settings className="h-12 w-12 text-primary mb-4 animate-spin-slow" />
          <h2 className="text-2xl font-bold mb-4">Want to automate your trades?</h2>
          <p className="mb-8 text-muted-foreground max-w-md">Our MCP server allows your agents to not only read data but also receive formatted instructions for trading bots.</p>
          <div className="flex flex-wrap gap-4 justify-center">
            <Link 
              href="https://github.com/cryonix-ai/mcp-server" 
              className="bg-foreground text-background px-6 py-2 rounded-lg font-bold hover:opacity-90 transition-all"
            >
              View on GitHub
            </Link>
            <Link 
              href="https://t.me/cryonixsignals" 
              className="border border-border px-6 py-2 rounded-lg font-bold hover:bg-white/5 transition-all"
            >
              API Support
            </Link>
          </div>
        </div>
      </section>

      <RecommendedReading currentSlug="mcp-server-setup" />
    </article>
  );
}
