import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GoPlusScanner } from '../scanners/goplus';

// Mock Redis
function createMockRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) || null),
    setex: vi.fn(async (key: string, _ttl: number, val: string) => { store.set(key, val); }),
    _store: store,
  };
}

// Mock GoPlus API response
function mockGoPlusResponse(overrides: Record<string, string> = {}) {
  return {
    result: {
      '0x1234': {
        is_honeypot: '0',
        is_mintable: '0',
        sell_tax: '0.01',
        buy_tax: '0.01',
        holder_count: '5000',
        lp_holder_count: '50',
        is_open_source: '1',
        ...overrides,
      },
    },
  };
}

describe('GoPlusScanner', () => {
  let scanner: GoPlusScanner;
  let redis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    redis = createMockRedis();
    scanner = new GoPlusScanner(redis as any);
    vi.restoreAllMocks();
  });

  it('should return cached result when available', async () => {
    const cached: any = {
      contract: '0x1234',
      chain: 'eth',
      is_honeypot: false,
      is_mintable: false,
      sell_tax: 1,
      buy_tax: 1,
      holder_count: 5000,
      lp_holder_count: 50,
      is_open_source: true,
      risk_score: 0,
      checked_at: '2026-01-01T00:00:00.000Z',
    };
    redis._store.set('huntrix:goplus:eth:0x1234', JSON.stringify(cached));

    const result = await scanner.checkToken('0x1234', 'eth');
    expect(result).toEqual(cached);
    expect(redis.get).toHaveBeenCalledWith('huntrix:goplus:eth:0x1234');
  });

  it('should fetch from API when no cache', async () => {
    const mockResponse = mockGoPlusResponse();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const result = await scanner.checkToken('0x1234', 'eth');
    expect(result.contract).toBe('0x1234');
    expect(result.is_honeypot).toBe(false);
    expect(result.sell_tax).toBe(1);
    expect(result.chain).toBe('eth');
    expect(redis.setex).toHaveBeenCalled();
  });

  it('should detect honeypot tokens', async () => {
    const mockResponse = mockGoPlusResponse({ is_honeypot: '1' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const result = await scanner.checkToken('0x1234', 'eth');
    expect(result.is_honeypot).toBe(true);
    expect(result.risk_score).toBeGreaterThanOrEqual(40);
  });

  it('should detect mintable tokens', async () => {
    const mockResponse = mockGoPlusResponse({ is_mintable: '1' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const result = await scanner.checkToken('0x1234', 'eth');
    expect(result.is_mintable).toBe(true);
    expect(result.risk_score).toBeGreaterThanOrEqual(20);
  });

  it('should detect high sell tax', async () => {
    const mockResponse = mockGoPlusResponse({ sell_tax: '0.6' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const result = await scanner.checkToken('0x1234', 'eth');
    expect(result.sell_tax).toBe(60);
    expect(result.risk_score).toBeGreaterThanOrEqual(30);
  });

  it('should return null for unknown symbols', async () => {
    const result = await scanner.checkSymbol('UNKNOWNCOIN/USDC');
    expect(result).toBeNull();
  });

  it('should resolve known symbols to contracts', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: {
          '0x6982508145454ce325ddbe47a25d4ec3d2311933': {
            is_honeypot: '0',
            is_mintable: '0',
            sell_tax: '0',
            buy_tax: '0',
            holder_count: '100000',
            lp_holder_count: '500',
            is_open_source: '1',
          },
        },
      }),
    } as Response);

    const result = await scanner.checkSymbol('PEPE/USDC');
    expect(result).not.toBeNull();
    expect(result!.chain).toBe('eth');
  });
});
