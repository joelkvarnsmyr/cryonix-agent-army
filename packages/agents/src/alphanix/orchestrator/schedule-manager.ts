export type ScheduleEvent =
  | 'morning_huddle'
  | 'macro_scan'
  | 'post_mortem'
  | 'esg_audit'
  | 'eu_market_open'
  | 'eu_market_close'
  | 'us_market_open'
  | 'us_market_close'
  | 'overnight_risk_adjust';

export interface ScheduledTask {
  event: ScheduleEvent;
  cronUtc: string;       // "HH:MM" in UTC
  daysOfWeek: number[];  // 0=Sun, 1=Mon, ..., 6=Sat
  lastRun?: number;      // epoch ms
}

export class ScheduleManager {
  private tasks: ScheduledTask[] = [];
  private callbacks = new Map<ScheduleEvent, () => Promise<void>>();

  constructor() {
    // Default schedule (UTC times)
    this.tasks = [
      { event: 'morning_huddle', cronUtc: '06:00', daysOfWeek: [1,2,3,4,5] },
      { event: 'macro_scan', cronUtc: '06:00', daysOfWeek: [1,2,3,4,5] },
      { event: 'eu_market_open', cronUtc: '07:00', daysOfWeek: [1,2,3,4,5] },  // 08:00 CET → 07:00 UTC
      { event: 'us_market_open', cronUtc: '14:30', daysOfWeek: [1,2,3,4,5] },
      { event: 'eu_market_close', cronUtc: '15:30', daysOfWeek: [1,2,3,4,5] }, // 16:30 CET → 15:30 UTC
      { event: 'us_market_close', cronUtc: '21:00', daysOfWeek: [1,2,3,4,5] },
      { event: 'post_mortem', cronUtc: '17:00', daysOfWeek: [1,2,3,4,5] },
      { event: 'overnight_risk_adjust', cronUtc: '22:00', daysOfWeek: [1,2,3,4,5] },
      { event: 'esg_audit', cronUtc: '06:00', daysOfWeek: [6] },  // Saturday
    ];
  }

  on(event: ScheduleEvent, callback: () => Promise<void>): void {
    this.callbacks.set(event, callback);
  }

  /** Check which events should fire now. Call this every minute from the orchestrator loop. */
  checkDueEvents(): ScheduleEvent[] {
    const now = new Date();
    const utcHours = String(now.getUTCHours()).padStart(2, '0');
    const utcMinutes = String(now.getUTCMinutes()).padStart(2, '0');
    const currentTime = `${utcHours}:${utcMinutes}`;
    const currentDay = now.getUTCDay();
    const currentEpoch = now.getTime();
    const due: ScheduleEvent[] = [];

    for (const task of this.tasks) {
      if (task.cronUtc !== currentTime) continue;
      if (!task.daysOfWeek.includes(currentDay)) continue;
      // Don't fire twice in the same minute
      if (task.lastRun && currentEpoch - task.lastRun < 60000) continue;
      task.lastRun = currentEpoch;
      due.push(task.event);
    }
    return due;
  }

  async fireDueEvents(): Promise<string[]> {
    const due = this.checkDueEvents();
    const fired: string[] = [];
    for (const event of due) {
      const callback = this.callbacks.get(event);
      if (callback) {
        try {
          await callback();
          fired.push(event);
        } catch (err: any) {
          console.error(`[ScheduleManager] ${event} failed:`, err.message);
        }
      }
    }
    return fired;
  }

  getSchedule(): ScheduledTask[] { return [...this.tasks]; }

  isMarketOpen(market: 'eu' | 'us' | 'crypto'): boolean {
    if (market === 'crypto') return true;
    const now = new Date();
    const day = now.getUTCDay();
    if (day === 0 || day === 6) return false;

    const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60;
    if (market === 'eu') return utcHour >= 7.0 && utcHour < 15.5;   // 08:00-16:30 CET
    if (market === 'us') return utcHour >= 14.5 && utcHour < 21.0;  // 09:30-16:00 ET
    return false;
  }
}
