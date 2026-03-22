// packages/agents/src/huntrix/__tests__/brain-actions.test.ts
import { describe, it, expect } from 'vitest';
import { validateAction, PARAM_BOUNDS } from '../brain-actions';
import type { BrainAction } from '../types';

describe('brain-actions', () => {
  describe('validateAction', () => {
    it('accepts valid adjust_param within bounds', () => {
      const action: BrainAction = {
        type: 'adjust_param',
        param: 'exits.stop_loss_pct',
        old_value: 3.0,
        new_value: 4.0,
        reasoning: 'too many tight SL exits',
      };
      expect(validateAction(action)).toEqual({ valid: true });
    });

    it('rejects adjust_param outside bounds', () => {
      const action: BrainAction = {
        type: 'adjust_param',
        param: 'exits.stop_loss_pct',
        old_value: 3.0,
        new_value: 15.0, // max is 8.0
        reasoning: 'test',
      };
      const result = validateAction(action);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('outside bounds');
    });

    it('rejects frozen parameter (general.*)', () => {
      const action: BrainAction = {
        type: 'adjust_param',
        param: 'general.capital',
        new_value: 500,
        reasoning: 'more capital',
      };
      const result = validateAction(action);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('frozen');
    });

    it('rejects frozen parameter (timing.*)', () => {
      const action: BrainAction = {
        type: 'adjust_param',
        param: 'timing.scan_interval_ms',
        new_value: 60000,
        reasoning: 'faster scans',
      };
      const result = validateAction(action);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('frozen');
    });

    it('accepts valid force_exit with symbol', () => {
      const action: BrainAction = {
        type: 'force_exit',
        symbol: 'PEPE/USDC',
        reasoning: 'position losing heavily',
      };
      expect(validateAction(action)).toEqual({ valid: true });
    });

    it('rejects force_exit without symbol', () => {
      const action: BrainAction = {
        type: 'force_exit',
        reasoning: 'close something',
      };
      const result = validateAction(action);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('symbol');
    });
  });
});
