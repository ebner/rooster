import { CloudOff, RefreshCw, TriangleAlert } from 'lucide-react';
import { Button as AriaButton } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/cn';
import { iconStrokeWidth } from './button';

export type SyncState = 'offline' | 'pending' | 'syncing' | 'error';

export interface SyncPillProps {
  state: SyncState;
  /** Outbox size, shown in the pending state ("Offline · 3 pending"). */
  pendingCount?: number;
  onRetry?: () => void;
  className?: string | undefined;
}

const toneClasses: Record<SyncState, string> = {
  offline: 'bg-bg-muted text-text-secondary',
  pending: 'bg-bg-warning-subtle text-text-warning',
  syncing: 'bg-bg-muted text-text-secondary',
  // 02 §14 (amber "Sync problem · Retry") outranks 03 §3.15 (rose) per AGENTS.md precedence.
  error: 'bg-bg-warning-subtle text-text-warning',
};

const icons = { offline: CloudOff, pending: CloudOff, syncing: RefreshCw, error: TriangleAlert };

/** 03 §3.15 / 02 §14: header sync status; state changes are announced politely. */
export function SyncPill({ state, pendingCount = 0, onRetry, className }: SyncPillProps) {
  const { t } = useTranslation();
  const Icon = icons[state];
  const label =
    state === 'offline'
      ? t('sync.offline')
      : state === 'pending'
        ? t('sync.pending', { count: pendingCount })
        : state === 'syncing'
          ? t('sync.syncing')
          : t('sync.problem');
  return (
    <div
      role="status"
      aria-label={t('sync.status')}
      className={cn(
        'inline-flex h-pill shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium tabular-nums',
        toneClasses[state],
        state === 'error' && onRetry && 'pe-1',
        className,
      )}
    >
      <Icon
        className={cn('size-3 shrink-0', state === 'syncing' && 'motion-safe:animate-spin')}
        strokeWidth={iconStrokeWidth}
        aria-hidden
      />
      <span>{label}</span>
      {state === 'error' && onRetry && (
        <>
          <span aria-hidden>·</span>
          <AriaButton
            onPress={onRetry}
            className="-my-0.5 inline-flex h-5 cursor-default items-center rounded-full px-1.5 font-semibold underline-offset-2 hover:underline pressed:bg-bg-app/60"
          >
            {t('action.retry')}
          </AriaButton>
        </>
      )}
    </div>
  );
}
