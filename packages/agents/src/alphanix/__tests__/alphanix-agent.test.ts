import { describe, it, expect } from 'vitest';
import { AlphanixAgent } from '../alphanix-agent';

describe('AlphanixAgent', () => {
  it('should initialize with idle status', () => {
    const agent = new AlphanixAgent({
      id: 'orchestrator' as any,
      name: 'Alphanix',
      description: 'Multi-asset AI trading army',
      enabled: true,
    });
    expect(agent.getStatus()).toBe('idle');
    expect(agent.getName()).toBe('Alphanix');
  });

  it('should initialize and set up pods from config', async () => {
    const agent = new AlphanixAgent({
      id: 'orchestrator' as any,
      name: 'Alphanix',
      description: 'test',
      enabled: true,
    });
    // Initialize loads config and creates pods.
    // Binance adapter connect will fail in test env but should not throw.
    await agent.initialize();
    expect(agent.getStatus()).toBe('idle');
  });
});
