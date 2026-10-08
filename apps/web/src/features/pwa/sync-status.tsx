import { LogIn } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { syncEngine } from '../../data/sync/engine';
import { cn } from '../../lib/cn';
import { safeRedirectPath } from '../../lib/safe-redirect';
import { type SyncPillState, syncPillState, useSyncStore } from '../../state/sync-store';
import { iconStrokeWidth } from '../../ui/button';
import { SyncPill } from '../../ui/sync-pill';
import { UpdateChip } from './update-chip';
import { updateController, useUpdateStore } from './update-controller';

/**
 * "Syncing…" only shows when sending takes a moment: a confirmation per keystroke must not
 * make the header flicker. Right after coming back online it shows at once (02 §14).
 */
export const syncingDelayMs = 600;

/** The pill state to render, with "Syncing…" held back for `syncingDelayMs`. */
function useShownState(): SyncPillState | null {
  const state = useSyncStore(syncPillState);
  const online = useSyncStore((s) => s.online);
  const [wasOffline, setWasOffline] = useState(!online);
  const [delayed, setDelayed] = useState(false);

  useEffect(() => {
    if (!online) setWasOffline(true);
  }, [online]);
  useEffect(() => {
    if (state === null) setWasOffline(false);
    if (state !== 'syncing') {
      setDelayed(false);
      return;
    }
    const timer = setTimeout(() => setDelayed(true), syncingDelayMs);
    return () => clearTimeout(timer);
  }, [state]);

  if (state === 'syncing' && !wasOffline && !delayed) return null;
  return state;
}

/** Sign in again without losing the queued ops (04 §6.2: 401 pauses the outbox). */
export function SessionExpired({ className }: { className?: string | undefined }) {
  const { t } = useTranslation('pwa');
  const pending = useSyncStore((s) => s.pending);
  const here = safeRedirectPath(`${location.pathname}${location.search}`);
  const href = here ? `/login?redirect=${encodeURIComponent(here)}` : '/login';
  return (
    <div
      role="alert"
      title={pending > 0 ? t('session.kept', { count: pending }) : undefined}
      className={cn(
        'inline-flex h-pill shrink-0 items-center gap-1.5 rounded-full bg-bg-warning-subtle ps-2 pe-1 text-xs font-medium text-text-warning',
        className,
      )}
    >
      <span>{t('session.expired')}</span>
      <span aria-hidden>·</span>
      <a
        href={href}
        className="inline-flex h-5 items-center gap-1 rounded-full px-1.5 font-semibold underline-offset-2 hover:underline"
      >
        <LogIn className="size-3" strokeWidth={iconStrokeWidth} aria-hidden />
        {t('session.signIn')}
      </a>
    </div>
  );
}

/**
 * The header sync status (03 §3.15, 02 §14): "Offline", "Offline · 3 pending", "Syncing…",
 * amber "Sync problem · Retry", or "Session expired · Sign in". Nothing when all is saved.
 * An "Update" chip joins it while a new version waits. Reads the sync and update stores only,
 * so any header (desktop, mobile) can place it.
 */
export function SyncStatus({ className }: { className?: string | undefined }) {
  const sessionExpired = useSyncStore((s) => s.sessionExpired);
  const pending = useSyncStore((s) => s.pending);
  const update = useUpdateStore((s) => s.available);
  const deferred = useUpdateStore((s) => s.deferred);
  const state = useShownState();
  const status = sessionExpired ? (
    <SessionExpired />
  ) : state ? (
    <SyncPill state={state} pendingCount={pending} onRetry={() => syncEngine()?.syncNow()} />
  ) : null;
  if (!update && !status) return null;
  return (
    <div className={cn('flex shrink-0 items-center gap-1.5', className)}>
      {update && <UpdateChip deferred={deferred} onPress={() => updateController()?.request()} />}
      {status}
    </div>
  );
}
