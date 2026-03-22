import type { ExchangeConfig } from './types';

export class ExchangeManager {
  private exchanges: Map<string, any> = new Map();
  private configs: Map<string, ExchangeConfig> = new Map();
  private mode: 'paper' | 'live';

  constructor(exchangeConfigs: ExchangeConfig[], mode: 'paper' | 'live') {
    this.mode = mode;
    for (const cfg of exchangeConfigs) {
      if (!cfg.enabled) continue;
      this.configs.set(cfg.id, cfg);
    }
  }

  async initialize(): Promise<void> {
    const ccxt = await import('ccxt');
    for (const [id, cfg] of this.configs) {
      const ExchangeClass = (ccxt as any)[id];
      if (!ExchangeClass) {
        console.warn(`[ExchangeManager] Unknown exchange: ${id} — skipping`);
        continue;
      }
      const opts: any = { enableRateLimit: true };
      if (this.mode === 'live') {
        const apiKey = process.env[cfg.api_key_env];
        const secret = process.env[cfg.secret_env];
        if (apiKey) opts.apiKey = apiKey;
        if (secret) opts.secret = secret;
        if (cfg.password_env) {
          const pw = process.env[cfg.password_env];
          if (pw) opts.password = pw;
        }
      }
      const exchange = new ExchangeClass(opts);
      this.exchanges.set(id, exchange);
      console.log(`[ExchangeManager] Initialized ${id} (${cfg.role}, priority ${cfg.priority})`);
    }
  }

  async loadMarkets(): Promise<void> {
    const promises = [...this.exchanges.entries()].map(async ([id, ex]) => {
      try {
        await ex.loadMarkets();
        console.log(`[ExchangeManager] ${id}: ${Object.keys(ex.markets).length} markets loaded`);
      } catch (err: any) {
        console.warn(`[ExchangeManager] ${id}: loadMarkets failed — ${err.message}`);
      }
    });
    await Promise.all(promises);
  }

  getScanExchangeIds(): string[] {
    return [...this.configs.entries()]
      .filter(([id, cfg]) => (cfg.role === 'scan' || cfg.role === 'scan+trade') && this.exchanges.has(id))
      .sort((a, b) => a[1].priority - b[1].priority)
      .map(([id]) => id);
  }

  getTradeExchangeIds(): string[] {
    return [...this.configs.entries()]
      .filter(([id, cfg]) => (cfg.role === 'trade' || cfg.role === 'scan+trade') && this.exchanges.has(id))
      .sort((a, b) => a[1].priority - b[1].priority)
      .map(([id]) => id);
  }

  getExchange(id: string): any | undefined {
    return this.exchanges.get(id);
  }

  getAllExchanges(): Map<string, any> {
    return this.exchanges;
  }

  getConfig(id: string): ExchangeConfig | undefined {
    return this.configs.get(id);
  }

  async getBestExchange(symbol: string): Promise<{ id: string; exchange: any; spread: number } | null> {
    const candidates: Array<{ id: string; exchange: any; spread: number; priority: number }> = [];
    for (const id of this.getTradeExchangeIds()) {
      const ex = this.exchanges.get(id)!;
      if (!ex.markets?.[symbol]) continue;
      try {
        const ticker = await ex.fetchTicker(symbol);
        const bid = ticker.bid ?? 0;
        const ask = ticker.ask ?? 0;
        const spread = bid > 0 ? ((ask - bid) / bid) * 100 : 999;
        const priority = this.configs.get(id)!.priority;
        candidates.push({ id, exchange: ex, spread, priority });
      } catch {
        // skip
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
      const spreadDiff = a.spread - b.spread;
      if (Math.abs(spreadDiff) > 0.05) return spreadDiff;
      return a.priority - b.priority;
    });
    return candidates[0];
  }

  async scanSymbol(symbol: string): Promise<Array<{ exchange: string; ticker: any }>> {
    const results: Array<{ exchange: string; ticker: any }> = [];
    const promises = this.getScanExchangeIds().map(async (id) => {
      const ex = this.exchanges.get(id)!;
      if (!ex.markets?.[symbol]) return;
      try {
        const ticker = await ex.fetchTicker(symbol);
        results.push({ exchange: id, ticker });
      } catch { /* skip */ }
    });
    await Promise.all(promises);
    return results;
  }
}
