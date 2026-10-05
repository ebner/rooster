import type { ListOp } from '@rooster/core/reducers';
import { CircleAlert } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useListPipeline } from '../../data/list';
import { cn } from '../../lib/cn';
import { syncProblemAfter, useSyncStore } from '../../state/sync-store';
import { iconStrokeWidth } from '../../ui/button';

/** 02 §9.3: "Saving…" only when it takes longer than this. */
export const savingDelayMs = 300;

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'offline' | 'failed';

/** Whether a queued op touches the task (or one of its direct subtasks). */
export function touchesTask(op: ListOp, taskId: string, subtaskIds: ReadonlySet<string>): boolean {
  if (op.kind === 'task.bulk')
    return op.payload.ids.some((id) => id === taskId || subtaskIds.has(id));
  if (op.kind === 'task.create') return op.payload.parentId === taskId;
  return op.entityId === taskId || subtaskIds.has(op.entityId);
}

/** The status label in the pane toolbar (02 §9.3). */
export function SaveState({ orgId, taskId }: { orgId: string; taskId: string }) {
  const pipeline = useListPipeline();
  useSyncExternalStore(pipeline.subscribe, pipeline.getVersion);
  const failures = useSyncStore((s) => s.failures);
  const [online, setOnline] = useState(() => globalThis.navigator?.onLine ?? true);
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [dropped, setDropped] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const subtaskIds = new Set(
    Object.values(pipeline.view(orgId)?.tasks ?? {})
      .filter((task) => task.parentId === taskId)
      .map((task) => task.id),
  );
  const pending = pipeline.pendingOps(orgId).some((op) => touchesTask(op, taskId, subtaskIds));

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  useEffect(
    () =>
      pipeline.onDropped(({ op }) => {
        if (touchesTask(op, taskId, subtaskIds)) setDropped(true);
      }),
    [pipeline, taskId],
  );

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (pending) {
      setDropped(false);
      timer.current = setTimeout(() => setStatus('saving'), savingDelayMs);
    } else {
      setStatus((s) => (s === 'idle' && !timer.current ? 'idle' : 'saved'));
    }
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [pending]);

  const shown: SaveStatus =
    dropped || (pending && failures >= syncProblemAfter)
      ? 'failed'
      : pending && !online
        ? 'offline'
        : status;
  return (
    <SaveStateView
      status={shown}
      onRetry={() => {
        setDropped(false);
        pipeline.retryNow();
      }}
    />
  );
}

/** The label itself, for every status (kitchen sink and the live pane). */
export function SaveStateView({ status, onRetry }: { status: SaveStatus; onRetry?: () => void }) {
  const { t } = useTranslation('pane');
  const shown = status;
  if (shown === 'idle') return <span data-testid="save-state" data-status="idle" />;
  return (
    <span
      role="status"
      data-testid="save-state"
      data-status={shown}
      className={cn(
        'inline-flex items-center gap-1 px-1 text-xs whitespace-nowrap',
        shown === 'failed' ? 'text-text-danger' : 'text-text-muted',
      )}
    >
      {shown === 'offline' && (
        <span aria-hidden className="size-1.5 rounded-full bg-text-warning" />
      )}
      {shown === 'failed' && (
        <CircleAlert className="size-3" strokeWidth={iconStrokeWidth} aria-hidden />
      )}
      {shown === 'saving' && t('save.saving')}
      {shown === 'saved' && t('save.saved')}
      {shown === 'offline' && t('save.offline')}
      {shown === 'failed' && (
        <>
          {t('save.failed')} ·
          <button
            type="button"
            className="font-medium underline-offset-2 hover:underline"
            onClick={onRetry}
          >
            {t('save.retry')}
          </button>
        </>
      )}
    </span>
  );
}
