import { todayIn } from '@rooster/core/dates';
import { useEffect, useMemo, useState } from 'react';
import { useDisplayPrefs, useMe } from '../../data/me';
import type { ViewerDateContext } from './types';

const minuteMs = 60_000;

/**
 * A clock that ticks on every minute boundary, and again when the tab becomes visible
 * (timers stall while a laptop sleeps). Minute precision is what timed-overdue needs,
 * and `today` rolls over at the viewer's midnight within that minute.
 */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(
        () => {
          setNow(Date.now());
          schedule();
        },
        minuteMs - (Date.now() % minuteMs),
      );
    };
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      clearTimeout(timer);
      setNow(Date.now());
      schedule();
    };
    schedule();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  return now;
}

/**
 * The signed-in viewer's date settings (`GET /me`; the UI language wins over the
 * stored one) plus a live clock: `today` is `todayIn(timezone, now)` and changes at
 * the viewer's local midnight.
 */
export function useViewerDateContext(): ViewerDateContext {
  const prefs = useDisplayPrefs();
  const weekStart = useMe().data?.user.weekStart ?? 1;
  const nowMs = useMinuteClock();
  const today = todayIn(prefs.timezone, nowMs);
  return useMemo(
    () => ({
      today,
      nowMs,
      locale: prefs.locale,
      weekStart,
      dateFormat: prefs.dateFormat,
      timeFormat: prefs.timeFormat,
      timezone: prefs.timezone,
    }),
    [today, nowMs, prefs, weekStart],
  );
}
