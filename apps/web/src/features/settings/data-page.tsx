import type { ExportFormat, Task } from '@rooster/core/schemas';
import { Download, RotateCcw, Trash2 } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Org } from '../../data/types';
import { cn } from '../../lib/cn';
import { type DisplayPrefs, formatTimeAgo } from '../../lib/format';
import { Button, buttonVariants, iconStrokeWidth } from '../../ui/button';
import { Select } from '../../ui/select';
import { Skeleton } from '../../ui/skeleton';
import { SettingsSection } from './settings-section';

export interface TrashListState {
  /** Newest deleted first; undefined while the first page loads. */
  items: readonly Task[] | undefined;
  error: Error | null;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
}

export interface DataPageProps {
  orgs: readonly Org[];
  orgId: string;
  onOrgChange: (orgId: string) => void;
  /** Export and Trash talk to the server (online only). */
  online: boolean;
  exportHref: (format: ExportFormat) => string;
  trash: TrashListState;
  /** The display name of whoever deleted a task; null when unknown. */
  nameOf: (userId: string) => string | null;
  viewerId: string;
  onRestore: (task: Task) => void;
  onDeletePermanently: (task: Task) => void;
  /** A task with a request in flight (its buttons show a spinner). */
  pendingId?: string | null | undefined;
  prefs: Pick<DisplayPrefs, 'locale'>;
  now: number;
}

const formats: readonly ExportFormat[] = ['json', 'markdown'];

/** FR-SET-5: Settings → Data, per org: export (JSON, Markdown) and the Trash (FR-TASK-8). */
export function DataPage({
  orgs,
  orgId,
  onOrgChange,
  online,
  exportHref,
  trash,
  nameOf,
  viewerId,
  onRestore,
  onDeletePermanently,
  pendingId,
  prefs,
  now,
}: DataPageProps) {
  const { t } = useTranslation('settings');
  return (
    <div className="flex flex-col gap-12">
      {orgs.length > 1 && (
        <Select
          label={t('data.org')}
          options={orgs.map((o) => ({ id: o.id, label: o.name }))}
          value={orgId}
          onChange={onOrgChange}
          className="tablet:max-w-80"
        />
      )}
      <SettingsSection id="export" title={t('data.exportTitle')} description={t('data.exportBody')}>
        <div className="flex flex-wrap items-center gap-2">
          {formats.map((format) =>
            online ? (
              <a
                key={format}
                href={exportHref(format)}
                download
                className={buttonVariants({ variant: 'secondary' })}
                data-testid={`export-${format}`}
              >
                <Download className="size-4" strokeWidth={iconStrokeWidth} aria-hidden />
                {t(`data.format.${format}`)}
              </a>
            ) : (
              <Button key={format} icon={Download} isDisabled>
                {t(`data.format.${format}`)}
              </Button>
            ),
          )}
        </div>
        {!online && <p className="text-sm text-text-muted">{t('data.offline')}</p>}
      </SettingsSection>
      <SettingsSection id="trash" title={t('data.trashTitle')} description={t('data.trashBody')}>
        <TrashList
          trash={trash}
          online={online}
          nameOf={nameOf}
          viewerId={viewerId}
          onRestore={onRestore}
          onDeletePermanently={onDeletePermanently}
          pendingId={pendingId}
          prefs={prefs}
          now={now}
        />
      </SettingsSection>
    </div>
  );
}

type TrashListProps = Pick<
  DataPageProps,
  | 'trash'
  | 'online'
  | 'nameOf'
  | 'viewerId'
  | 'onRestore'
  | 'onDeletePermanently'
  | 'pendingId'
  | 'prefs'
  | 'now'
>;

/**
 * The Trash rows. ↑/↓ move between rows (keeping the column), Tab reaches the buttons; nothing
 * happens implicitly on Enter, so a stray key never restores or destroys (ADR 0012).
 */
export function TrashList({
  trash,
  online,
  nameOf,
  viewerId,
  onRestore,
  onDeletePermanently,
  pendingId,
  prefs,
  now,
}: TrashListProps) {
  const { t } = useTranslation('settings');
  const [confirming, setConfirming] = useState<string | null>(null);

  if (trash.items === undefined) {
    if (trash.error || !online) {
      return (
        <p className="text-sm text-text-secondary" role="alert">
          {online ? t('data.trashFailed') : t('data.offline')}
        </p>
      );
    }
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <Skeleton className="h-row w-full" />
        <Skeleton className="h-row w-full" />
      </div>
    );
  }
  if (trash.items.length === 0) {
    return (
      <p className="py-4 text-sm text-text-muted" data-testid="trash-empty">
        {t('data.trashEmpty')}
      </p>
    );
  }

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const from = event.target instanceof HTMLElement ? event.target : null;
    const row = from?.closest('[data-trash-row]');
    if (!row || !from) return;
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-trash-row]')];
    const next = rows[rows.indexOf(row as HTMLElement) + (event.key === 'ArrowDown' ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    const column = from.dataset.col ?? 'restore';
    (
      next.querySelector<HTMLElement>(`[data-col="${column}"]`) ??
      next.querySelector<HTMLElement>('button, a')
    )?.focus();
  };

  return (
    <div className="flex flex-col gap-3">
      <ul
        aria-label={t('data.trashTitle')}
        className="flex flex-col"
        onKeyDown={onKeyDown}
        data-testid="trash-list"
      >
        {trash.items.map((task) => {
          const by = task.deletedBy
            ? task.deletedBy === viewerId
              ? t('data.you')
              : (nameOf(task.deletedBy) ?? t('data.someone'))
            : t('data.someone');
          const when = task.deletedAt
            ? formatTimeAgo(task.deletedAt, now, prefs.locale, t('security.justNow'))
            : '';
          return (
            <TrashRow
              key={task.id}
              task={task}
              meta={t('data.deletedBy', { name: by, when })}
              confirming={confirming === task.id}
              onConfirm={(value) => setConfirming(value ? task.id : null)}
              pending={pendingId === task.id}
              online={online}
              onRestore={() => onRestore(task)}
              onDelete={() => {
                setConfirming(null);
                onDeletePermanently(task);
              }}
            />
          );
        })}
      </ul>
      {trash.hasMore && (
        <Button
          variant="ghost"
          className="self-start"
          isLoading={trash.isLoadingMore}
          onPress={trash.onLoadMore}
        >
          {t('data.loadMore')}
        </Button>
      )}
    </div>
  );
}

interface TrashRowProps {
  task: Task;
  meta: string;
  confirming: boolean;
  onConfirm: (confirming: boolean) => void;
  pending: boolean;
  online: boolean;
  onRestore: () => void;
  onDelete: () => void;
}

/** One deleted task; "Delete permanently" asks inline (02 §1: no modal). */
export function TrashRow({
  task,
  meta,
  confirming,
  onConfirm,
  pending,
  online,
  onRestore,
  onDelete,
}: TrashRowProps) {
  const { t } = useTranslation('settings');
  const cancel = useRef<HTMLButtonElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const previous = useRef(confirming);
  useEffect(() => {
    if (previous.current === confirming) return;
    previous.current = confirming;
    // Into the question: focus Cancel (the safe choice). Back out: return to the trigger.
    if (confirming) cancel.current?.focus();
    else deleteButton.current?.focus();
  }, [confirming]);

  return (
    <li
      data-trash-row
      data-testid="trash-row"
      className={cn(
        'flex flex-col gap-2 border-b border-border py-3 last:border-b-0 tablet:flex-row tablet:items-center tablet:gap-4',
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{task.title || t('data.untitled')}</span>
        <span className="truncate text-sm text-text-muted">{meta}</span>
      </div>
      {confirming ? (
        // biome-ignore lint/a11y/useSemanticElements: a fieldset would imply a form; this is a toolbar-like question.
        <div
          className="flex flex-wrap items-center gap-2"
          role="group"
          aria-label={t('data.confirmLabel', { title: task.title })}
        >
          <span className="text-sm text-text-danger">{t('data.confirm')}</span>
          <Button
            variant="danger"
            size="sm"
            data-col="delete"
            isLoading={pending}
            isDisabled={!online}
            onPress={onDelete}
          >
            {t('data.deleteForGood')}
          </Button>
          <Button ref={cancel} variant="ghost" size="sm" onPress={() => onConfirm(false)}>
            {t('data.cancel')}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            icon={RotateCcw}
            data-col="restore"
            isLoading={pending}
            isDisabled={!online}
            onPress={onRestore}
            aria-label={t('data.restoreNamed', { title: task.title })}
          >
            {t('data.restore')}
          </Button>
          <Button
            ref={deleteButton}
            variant="ghost"
            size="sm"
            icon={Trash2}
            data-col="delete"
            isDisabled={!online || pending}
            onPress={() => onConfirm(true)}
            aria-label={t('data.deleteNamed', { title: task.title })}
          >
            {t('data.delete')}
          </Button>
        </div>
      )}
    </li>
  );
}
