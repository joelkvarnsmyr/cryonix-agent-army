import type Redis from 'ioredis';
import type { DefiLlamaHack } from '../types';

const HACKS_URL = 'https://api.llama.fi/hacks';
const CACHE_KEY = 'huntrix:defi_llama:hacks';
const CACHE_TTL = 1800; // 30 minutes

// Map protocol/chain names to trading symbols
const PROTOCOL_SYMBOLS: Record<string, string[]> = {
  'ethereum': ['ETH'],
  'binance': ['BNB'],
  'bsc': ['BNB'],
  'solana': ['SOL'],
  'polygon': ['MATIC', 'POL'],
  'avalanche': ['AVAX'],
  'arbitrum': ['ARB'],
  'optimism': ['OP'],
  'fantom': ['FTM'],
  'aave': ['AAVE'],
  'compound': ['COMP'],
  'curve': ['CRV'],
  'uniswap': ['UNI'],
  'sushiswap': ['SUSHI'],
  'pancakeswap': ['CAKE'],
  'chainlink': ['LINK'],
  'lido': ['LDO'],
  'maker': ['MKR'],
};

export class DefiLlamaHacksScanner {
  private redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  /**
   * Fetch recent hacks from DeFi Llama.
   * Returns hacks from the last 7 days.
   */
  async scan(): Promise<DefiLlamaHack[]> {
    // Check cache first
    const cached = await this.redis.get(CACHE_KEY);
    if (cached) return JSON.parse(cached);

    const response = await fetch(HACKS_URL);
    if (!response.ok) {
      throw new Error(`DeFi Llama API error: ${response.status} ${response.statusText}`);
    }

    const rawHacks: any[] = await response.json() as any[];

    // Filter to last 7 days
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    const hacks: DefiLlamaHack[] = rawHacks
      .filter((h: any) => {
        const hackDate = new Date(h.date).getTime();
        return hackDate >= sevenDaysAgo;
      })
      .map((h: any) => ({
        id: `hack-${h.name}-${h.date}`.toLowerCase().replace(/\s+/g, '-'),
        name: h.name || 'Unknown',
        chains: Array.isArray(h.chains) ? h.chains : (h.chain ? [h.chain] : []),
        amount: h.amount || 0,
        technique: h.technique || 'unknown',
        date: h.date || new Date().toISOString(),
        symbols: this.extractSymbols(h),
      }));

    // Cache results
    await this.redis.setex(CACHE_KEY, CACHE_TTL, JSON.stringify(hacks));

    return hacks;
  }

  /**
   * Extract affected trading symbols from hack data.
   * Maps chain names and protocol names to symbols.
   */
  extractSymbols(hack: any): string[] {
    const symbols = new Set<string>();

    // Map chains to symbols
    const chains: string[] = Array.isArray(hack.chains) ? hack.chains : (hack.chain ? [hack.chain] : []);
    for (const chain of chains) {
      const mapped = PROTOCOL_SYMBOLS[chain.toLowerCase()];
      if (mapped) mapped.forEach(s => symbols.add(s));
    }

    // Map protocol name to symbols
    const name = (hack.name || '').toLowerCase();
    for (const [protocol, syms] of Object.entries(PROTOCOL_SYMBOLS)) {
      if (name.includes(protocol)) {
        syms.forEach(s => symbols.add(s));
      }
    }

    // Check for token symbols in the hack name (uppercase 3-5 letter words)
    const nameWords = (hack.name || '').split(/[\s-_]+/);
    for (const word of nameWords) {
      if (/^[A-Z]{3,5}$/.test(word)) {
        symbols.add(word);
      }
    }

    return [...symbols];
  }
}
