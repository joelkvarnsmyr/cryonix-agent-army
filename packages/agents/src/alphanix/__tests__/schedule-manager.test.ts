import { describe, it, expect, vi, afterEach } from 'vitest';
import { ScheduleManager } from '../orchestrator/schedule-manager';

describe('ScheduleManager', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('should have default schedule with 9 events', () => {
    const sm = new ScheduleManager();
    expect(sm.getSchedule().length).toBe(9);
  });

  it('should detect crypto as always open', () => {
    const sm = new ScheduleManager();
    expect(sm.isMarketOpen('crypto')).toBe(true);
  });

  it('should register and fire callbacks', async () => {
    const sm = new ScheduleManager();
    const fn = vi.fn().mockResolvedValue(undefined);
    sm.on('morning_huddle', fn);

    // Monday 2026-03-23 06:00 UTC
    const fakeDate = new Date(Date.UTC(2026, 2, 23, 6, 0, 0));
    vi.useFakeTimers();
    vi.setSystemTime(fakeDate);

    const fired = await sm.fireDueEvents();

    // 2026-03-23 is a Monday (day 1)
    expect(fired).toContain('morning_huddle');
    expect(fn).toHaveBeenCalled();
  });

  it('should not fire same event twice in same minute', async () => {
    const sm = new ScheduleManager();
    const fn = vi.fn().mockResolvedValue(undefined);
    sm.on('morning_huddle', fn);

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 2, 23, 6, 0, 0)));  // Monday

    await sm.fireDueEvents();
    await sm.fireDueEvents();

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should not fire weekday events on weekend', () => {
    const sm = new ScheduleManager();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 2, 22, 6, 0, 0)));  // Sunday
    const due = sm.checkDueEvents();
    expect(due).not.toContain('morning_huddle');
  });

  it('should fire esg_audit on Saturday', () => {
    const sm = new ScheduleManager();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 2, 21, 6, 0, 0)));  // Saturday
    const due = sm.checkDueEvents();
    expect(due).toContain('esg_audit');
  });
});
