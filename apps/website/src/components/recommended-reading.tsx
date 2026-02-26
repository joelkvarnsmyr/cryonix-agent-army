'use client';

import Link from 'next/link';
import { ChevronRight, ArrowRight } from 'lucide-react';

interface RecommendedReadingProps {
  currentSlug: string;
}

const ALL_GUIDES = [
  { slug: 'best-crypto-trading-signals', title: 'Best Signals 2026' },
  { slug: 'mcp-server-setup', title: 'MCP Server Setup' },
  { slug: 'fail-closed-trading', title: 'Fail-Closed Strategy' },
  { slug: 'crypto-signal-scams', title: 'Scam Spotting' },
  { slug: 'bollinger-squeeze-ai', title: 'Bollinger AI' },
  { slug: 'ai-orchestration-architecture', title: 'AI Brain Architecture' },
  { slug: 'the-drawdown-truth', title: 'The Drawdown Truth' },
  { slug: 'open-claw-setup', title: 'Open Claw Guide' },
];

export function RecommendedReading({ currentSlug }: RecommendedReadingProps) {
  const filtered = ALL_GUIDES.filter(g => g.slug !== currentSlug).slice(0, 3);

  return (
    <section className="mt-20 pt-12 border-t border-border/40">
      <h3 className="text-xl font-bold mb-8 flex items-center gap-2">
        <ArrowRight className="h-5 w-5 text-primary" />
        Recommended Reading
      </h3>
      <div className="grid sm:grid-cols-3 gap-4">
        {filtered.map((guide) => (
          <Link
            key={guide.slug}
            href={`/guides/${guide.slug}`}
            className="glass-card p-6 rounded-xl border-border/40 hover:border-primary/30 transition-all group"
          >
            <h4 className="font-bold text-sm mb-2 group-hover:text-primary transition-colors">
              {guide.title}
            </h4>
            <div className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground group-hover:text-foreground transition-colors">
              Read now <ChevronRight className="h-3 w-3" />
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
