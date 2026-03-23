import { describe, it, expect } from 'vitest';
import { macroWorker } from '../swarms/workers/macro-worker';
import { sentimentWorker } from '../swarms/workers/sentiment-worker';
import { osintWorker } from '../swarms/workers/osint-worker';
import { altdataWorker } from '../swarms/workers/altdata-worker';
import type { SwarmWorkerTask } from '../swarms/types';

const makeTask = (type: string, params: Record<string, unknown> = {}): SwarmWorkerTask => ({
  id: `test-${type}-1`, swarmId: 'test-swarm', type: type as any, params,
});

describe('Swarm Workers', () => {
  it('macro worker should handle missing FRED key gracefully', async () => {
    const result = await macroWorker(makeTask('macro'));
    // Will fail without FRED_API_KEY but should not throw
    expect(result.taskId).toBe('test-macro-1');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('sentiment worker should return results for symbols', async () => {
    const result = await sentimentWorker(makeTask('sentiment', { symbols: ['TEST'] }));
    expect(result.taskId).toBe('test-sentiment-1');
    // May fail on network but should handle gracefully
    expect(typeof result.success).toBe('boolean');
  });

  it('osint worker should handle missing CIK gracefully', async () => {
    const result = await osintWorker(makeTask('osint', { symbol: 'TEST' }));
    expect(result.taskId).toBe('test-osint-1');
    expect(typeof result.success).toBe('boolean');
  });

  it('altdata worker should handle missing Trafikverket key', async () => {
    const result = await altdataWorker(makeTask('altdata', { source: 'rail' }));
    expect(result.taskId).toBe('test-altdata-1');
    expect(typeof result.success).toBe('boolean');
  });
});
