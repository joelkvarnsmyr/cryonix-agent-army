import type { AktienixTomlConfig } from './config';

export interface MarketHoursResult {
    isOpen: boolean;
    canOpenNew: boolean;
    skipSignalScan: boolean;
    minutesUntilClose: number;
    shouldClosePositions: boolean;
}

type MarketHoursConfig = AktienixTomlConfig['market_hours'];

export class MarketHours {
    /**
     * Primary method: uses Alpaca clock API for accurate open/close times.
     * Falls back to ET math if alpaca is null (tests / mock broker).
     */
    static async check(
        alpaca: any | null,
        config: MarketHoursConfig,
    ): Promise<MarketHoursResult> {
        if (!config.regular_hours_only) {
            return { isOpen: true, canOpenNew: true, skipSignalScan: false, minutesUntilClose: 9999, shouldClosePositions: false };
        }

        if (alpaca) {
            try {
                const clock = await alpaca.getClock();
                const isOpen: boolean = clock.is_open;

                const nowMs = Date.now();
                const closeMs = new Date(clock.next_close).getTime();
                const minutesUntilClose = isOpen ? Math.max(0, (closeMs - nowMs) / 60_000) : 0;

                // Minutes since market opened (only meaningful when open)
                const lastOpenMs = isOpen ? (closeMs - 390 * 60_000) : 0; // 390 min = 6.5h trading day
                const minutesSinceOpen = isOpen ? Math.max(0, (nowMs - lastOpenMs) / 60_000) : 0;

                const skipSignalScan = isOpen && minutesSinceOpen < config.skip_first_minutes;
                const canOpenNew = isOpen && minutesUntilClose > config.no_new_orders_before_close_min;
                const shouldClosePositions = config.close_before_eod === true
                    && isOpen
                    && minutesUntilClose <= config.no_new_orders_before_close_min;

                return { isOpen, canOpenNew, skipSignalScan, minutesUntilClose, shouldClosePositions };
            } catch {
                // Fall through to ET math on API error
            }
        }

        return MarketHours.checkFromDate(new Date(), config);
    }

    /**
     * ET-based fallback. Usable in tests with a specific date injected.
     * NYSE regular hours: Mon–Fri 09:30–16:00 ET (UTC-5 EST / UTC-4 EDT).
     * DST: US spring forward = 2nd Sunday of March at 02:00 EST; fall back = 1st Sunday of November at 02:00 EDT.
     */
    static checkFromDate(now: Date, config: MarketHoursConfig): MarketHoursResult {
        if (!config.regular_hours_only) {
            return { isOpen: true, canOpenNew: true, skipSignalScan: false, minutesUntilClose: 9999, shouldClosePositions: false };
        }

        const ET_OFFSET_HOURS = MarketHours._getEasternOffsetHours(now.getTime());
        const etMs = now.getTime() + ET_OFFSET_HOURS * 3_600_000;
        const et = new Date(etMs);

        const dayOfWeek = et.getUTCDay(); // 0=Sun, 6=Sat
        const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;

        const minutesSinceMidnight = et.getUTCHours() * 60 + et.getUTCMinutes();
        const marketOpen = 9 * 60 + 30;   // 09:30 ET
        const marketClose = 16 * 60;       // 16:00 ET

        const isOpen = isWeekday && minutesSinceMidnight >= marketOpen && minutesSinceMidnight < marketClose;
        const minutesUntilClose = isOpen ? marketClose - minutesSinceMidnight : 0;
        const minutesSinceOpen = isOpen ? minutesSinceMidnight - marketOpen : 0;

        const skipSignalScan = isOpen && minutesSinceOpen < config.skip_first_minutes;
        const canOpenNew = isOpen && minutesUntilClose > config.no_new_orders_before_close_min;
        const shouldClosePositions = config.close_before_eod === true
            && isOpen
            && minutesUntilClose <= config.no_new_orders_before_close_min;

        return { isOpen, canOpenNew, skipSignalScan, minutesUntilClose, shouldClosePositions };
    }

    /** Returns -4 (EDT) or -5 (EST) based on US DST rules for the given UTC timestamp. */
    private static _getEasternOffsetHours(utcMs: number): -4 | -5 {
        const year = new Date(utcMs).getUTCFullYear();
        // Spring forward: 2nd Sunday of March at 02:00 EST = 07:00 UTC
        const springForwardUTC = MarketHours._nthSundayUTC(year, 3, 2) + 7 * 3_600_000;
        // Fall back: 1st Sunday of November at 02:00 EDT = 06:00 UTC
        const fallBackUTC = MarketHours._nthSundayUTC(year, 11, 1) + 6 * 3_600_000;
        return utcMs >= springForwardUTC && utcMs < fallBackUTC ? -4 : -5;
    }

    /** Returns UTC timestamp (ms) of the Nth Sunday (1-based) of the given month/year. */
    private static _nthSundayUTC(year: number, month: number, n: number): number {
        const firstOfMonth = Date.UTC(year, month - 1, 1);
        const firstDow = new Date(firstOfMonth).getUTCDay(); // 0=Sun
        const daysToFirstSunday = firstDow === 0 ? 0 : 7 - firstDow;
        const nthSundayDay = 1 + daysToFirstSunday + (n - 1) * 7;
        return Date.UTC(year, month - 1, nthSundayDay);
    }
}
