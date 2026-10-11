import { RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { iconStrokeWidth } from '../../ui/button';
import { announce } from './announcer';

/** Pulled this far (after resistance), a release refreshes. */
export const pullThresholdPx = 64;
const maxPullPx = 96;
/** The spinner turns at least this long: a refetch that returns in a few ms still reads as one. */
export const minRefreshMs = 500;
const resistance = 0.5;

function scrollParent(el: Element | null): HTMLElement | null {
  for (let node = el?.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
  }
  return null;
}

export interface PullToRefreshProps {
  enabled: boolean;
  /** Refetch and flush; the spinner turns until it settles. */
  onRefresh: () => Promise<unknown>;
  /** A drag (long-press) owns the touch. */
  isBlocked?: () => boolean;
}

/**
 * Pull to refresh (02 §13.2): pulling the list down from the very top shows a spinner that
 * follows the finger; past 64 px a release refetches the list and flushes the outbox, with the
 * spinner turning for at least `minRefreshMs`. Uses
 * passive touch listeners on the list's scroll container, so native scrolling is untouched.
 */
export function PullToRefresh({ enabled, onRefresh, isBlocked }: PullToRefreshProps) {
  const { t } = useTranslation('mobile');
  const anchor = useRef<HTMLDivElement>(null);
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const live = useRef({ enabled, onRefresh, isBlocked, refreshing });
  live.current = { enabled, onRefresh, isBlocked, refreshing };

  useEffect(() => {
    const scroller = scrollParent(anchor.current);
    if (!scroller) return;
    let startY: number | null = null;
    let current = 0;

    const onStart = (event: TouchEvent) => {
      const { enabled: on, isBlocked: blocked, refreshing: busy } = live.current;
      if (!on || busy || blocked?.() || event.touches.length !== 1) return;
      if (scroller.scrollTop > 0) return;
      startY = event.touches[0]?.clientY ?? null;
      current = 0;
    };
    const onMove = (event: TouchEvent) => {
      if (startY === null) return;
      if (live.current.isBlocked?.()) {
        startY = null;
        setPull(0);
        return;
      }
      const dy = (event.touches[0]?.clientY ?? startY) - startY;
      if (dy <= 0 || scroller.scrollTop > 0) {
        if (current !== 0) setPull(0);
        current = 0;
        return;
      }
      current = Math.min(maxPullPx, dy * resistance);
      setPull(current);
    };
    const onEnd = () => {
      if (startY === null) return;
      startY = null;
      const reached = current >= pullThresholdPx;
      current = 0;
      setPull(0);
      if (!reached) return;
      setRefreshing(true);
      announce(t('refresh.refreshing'));
      void Promise.all([
        live.current.onRefresh().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, minRefreshMs)),
      ]).finally(() => {
        setRefreshing(false);
        announce(t('refresh.done'));
      });
    };

    scroller.addEventListener('touchstart', onStart, { passive: true });
    scroller.addEventListener('touchmove', onMove, { passive: true });
    scroller.addEventListener('touchend', onEnd);
    scroller.addEventListener('touchcancel', onEnd);
    return () => {
      scroller.removeEventListener('touchstart', onStart);
      scroller.removeEventListener('touchmove', onMove);
      scroller.removeEventListener('touchend', onEnd);
      scroller.removeEventListener('touchcancel', onEnd);
    };
  }, [t]);

  const visible = refreshing || pull > 0;
  const height = refreshing ? pullThresholdPx * 0.75 : pull;
  return (
    <div
      ref={anchor}
      aria-hidden
      data-testid="pull-to-refresh"
      data-state={
        refreshing
          ? 'refreshing'
          : pull >= pullThresholdPx
            ? 'armed'
            : pull > 0
              ? 'pulling'
              : 'idle'
      }
      style={{ height }}
      className={cn(
        'flex shrink-0 items-end justify-center overflow-hidden',
        pull === 0 && 'transition-[height] duration-(--dur-base) ease-standard',
      )}
    >
      {visible && (
        <span className="mb-2 flex size-8 items-center justify-center rounded-full bg-bg-elevated text-text-secondary shadow-md">
          <RefreshCw
            className={cn('size-4', refreshing && 'motion-safe:animate-spin')}
            strokeWidth={iconStrokeWidth}
            style={
              refreshing ? undefined : { transform: `rotate(${(pull / pullThresholdPx) * 270}deg)` }
            }
          />
        </span>
      )}
    </div>
  );
}
