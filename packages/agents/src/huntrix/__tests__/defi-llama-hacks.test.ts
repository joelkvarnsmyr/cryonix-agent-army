import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DefiLlamaHacksScanner } from '../scanners/defi-llama-hacks';

function createMockRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) || null),
    setex: vi.fn(async (key: string, _ttl: number, val: string) => { store.set(key, val); }),
    _store: store,
  };
}

describe('DefiLlamaHacksScanner', () => {
  let scanner: DefiLlamaHacksScanner;
  let redis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    redis = createMockRedis();
    scanner = new DefiLlamaHacksScanner(redis as any);
    vi.restoreAllMocks();
  });

  it('should return cached results when available', async () => {
    const cached = [{ id: 'hack-test', name: 'Test', chains: [], amount: 1000000, technique: 'exploit', date: new Date().toISOString(), symbols: ['ETH'] }];
    redis._store.set('huntrix:defi_llama:hacks', JSON.stringify(cached));

    const result = await scanner.scan();
    expect(result).toEqual(cached);
    expect(redis.get).toHaveBeenCalledWith('huntrix:defi_llama:hacks');
  });

  it('should fetch and filter recent hacks from API', async () => {
    const now = new Date().toISOString();
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days ago

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { name: 'RecentHack', chains: ['Ethereum'], amount: 5000000, technique: 'flash loan', date: now },
        { name: 'OldHack', chains: ['BSC'], amount: 1000000, technique: 'reentrancy', date: oldDate },
      ],
    } as Response);

    const result = await scanner.scan();
    expect(result.length).toBe(1);
    expect(result[0].name).toBe('RecentHack');
    expect(redis.setex).toHaveBeenCalled();
  });

  it('should extract symbols from chain names', () => {
    const symbols = scanner.extractSymbols({
      name: 'SomeProtocol',
      chains: ['Ethereum', 'BSC'],
    });
    expect(symbols).toContain('ETH');
    expect(symbols).toContain('BNB');
  });

  it('should extract uppercase token symbols from hack name', () => {
    const symbols = scanner.extractSymbols({
      name: 'AAVE Exploit via Flash Loan',
      chains: [],
    });
    expect(symbols).toContain('AAVE');
  });
});
