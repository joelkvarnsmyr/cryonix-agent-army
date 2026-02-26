import type { MetadataRoute } from 'next';
import { locales } from '@/../i18n/routing';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://cryonix.ai';

const pages = [
  '', 
  '/signals', 
  '/performance', 
  '/guides', 
  '/guides/best-crypto-trading-signals', 
  '/guides/mcp-server-setup',
  '/guides/fail-closed-trading',
  '/guides/crypto-signal-scams',
  '/guides/bollinger-squeeze-ai',
  '/guides/ai-orchestration-architecture',
  '/guides/the-drawdown-truth',
  '/guides/open-claw-setup'
];

export default function sitemap(): MetadataRoute.Sitemap {
  const entries: MetadataRoute.Sitemap = [];

  for (const page of pages) {
    for (const locale of locales) {
      const url = locale === 'en'
        ? `${BASE_URL}${page || '/'}`
        : `${BASE_URL}/${locale}${page}`;

      entries.push({
        url,
        lastModified: new Date(),
        changeFrequency: page === '' ? 'daily' : 'hourly',
        priority: page === '' ? 1 : 0.8,
        alternates: {
          languages: Object.fromEntries(
            locales.map((l) => [
              l,
              l === 'en'
                ? `${BASE_URL}${page || '/'}`
                : `${BASE_URL}/${l}${page}`,
            ])
          ),
        },
      });
    }
  }

  return entries;
}
