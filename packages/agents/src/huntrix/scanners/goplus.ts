import type Redis from 'ioredis';
import type { GoPlusTokenSecurity } from '../types';

// Map trading symbols to contract addresses (BSC/ETH top tokens)
const SYMBOL_CONTRACTS: Record<string, { address: string; chain: 'eth' | 'bsc' }> = {
  'SHIB': { address: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE', chain: 'eth' },
  'PEPE': { address: '0x6982508145454ce325ddbe47a25d4ec3d2311933', chain: 'eth' },
  'FLOKI': { address: '0xcf0c122c6b73ff809c693db761e7baebe62b6a2e', chain: 'eth' },
  'DOGE': { address: '0xba2ae424d960c26247dd6c32edc70b295c744c43', chain: 'bsc' },
  'BONK': { address: '0xa697e272a73744b343528c3bc4702f2565b2f422', chain: 'bsc' },
  'WIF': { address: '0xB0fFa8000886e57F86dd5264b9582b2Ad87b2b91', chain: 'bsc' },
  'MEME': { address: '0xb131f4A55907B10d1F0A50d8ab8FA09EC342cd74', chain: 'eth' },
  'TURBO': { address: '0xA35923162C49cF95e6BF26623385eb431ad920D3', chain: 'eth' },
};

const GOPLUS_BASE = 'https://api.gopluslabs.io/api/v1';
const CHAIN_IDS: Record<string, string> = { eth: '1', bsc: '56' };
const CACHE_TTL = 3600; // 1 hour

export class GoPlusScanner {
  private redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  /**
   * Check a trading symbol (e.g., "PEPE") for token safety.
   * Returns null if symbol has no known contract mapping.
   */
  async checkSymbol(symbol: string): Promise<GoPlusTokenSecurity | null> {
    const baseSymbol = symbol.split('/')[0].toUpperCase();
    const mapping = SYMBOL_CONTRACTS[baseSymbol];
    if (!mapping) return null;

    return this.checkToken(mapping.address, mapping.chain);
  }

  /**
   * Check a specific contract address for safety issues.
   * Results are cached in Redis for CACHE_TTL seconds.
   */
  async checkToken(address: string, chain: 'eth' | 'bsc'): Promise<GoPlusTokenSecurity> {
    const cacheKey = `huntrix:goplus:${chain}:${address.toLowerCase()}`;

    // Check cache first
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const chainId = CHAIN_IDS[chain];
    const url = `${GOPLUS_BASE}/token_security/${chainId}?contract_addresses=${address}`;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`GoPlus API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const result = data?.result?.[address.toLowerCase()];
    if (!result) {
      throw new Error(`No GoPlus data for ${address} on ${chain}`);
    }

    const security: GoPlusTokenSecurity = {
      contract: address.toLowerCase(),
      chain,
      is_honeypot: result.is_honeypot === '1',
      is_mintable: result.is_mintable === '1',
      sell_tax: parseFloat(result.sell_tax || '0') * 100,
      buy_tax: parseFloat(result.buy_tax || '0') * 100,
      holder_count: parseInt(result.holder_count || '0', 10),
      lp_holder_count: parseInt(result.lp_holder_count || '0', 10),
      is_open_source: result.is_open_source === '1',
      risk_score: this.calculateRiskScore(result),
      checked_at: new Date().toISOString(),
    };

    // Cache the result
    await this.redis.setex(cacheKey, CACHE_TTL, JSON.stringify(security));

    return security;
  }

  /**
   * Calculate a composite risk score from GoPlus flags.
   */
  private calculateRiskScore(result: any): number {
    let score = 0;
    if (result.is_honeypot === '1') score += 40;
    if (result.is_mintable === '1') score += 20;
    if (result.is_open_source !== '1') score += 10;
    const sellTax = parseFloat(result.sell_tax || '0') * 100;
    if (sellTax > 10) score += 15;
    if (sellTax > 50) score += 15;
    const holderCount = parseInt(result.holder_count || '0', 10);
    if (holderCount < 100) score += 10;
    if (holderCount < 10) score += 10;
    return Math.min(100, score);
  }

  /** Check if a symbol has a known contract mapping */
  hasMapping(symbol: string): boolean {
    const baseSymbol = symbol.split('/')[0].toUpperCase();
    return baseSymbol in SYMBOL_CONTRACTS;
  }
}
