import type { Tag, Task } from '@rooster/core/schemas';
import { AlignLeft, Bell, ListTree, Paperclip, Repeat } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { useTagsStore } from '../../state/tags-store';
import { iconStrokeWidth } from '../../ui/button';
import { Chip } from '../../ui/chip';
import type { ViewerDateContext } from '../dates';
import { formatInstant } from '../dates/date-text';
import { useRuleText } from '../dates/recurrence-text';

/** 03 §3.1: at most three chips (one on phones), then "+N". */
export const maxRowChips = 3;

export function taskTags(task: Task, byId: Readonly<Record<string, Tag>>): Tag[] {
  return task.tagIds.flatMap((id) => (byId[id] ? [byId[id] as Tag] : []));
}

/**
 * Tag chips for a row: never interactive themselves (a click opens the tag picker). In a
 * narrow row the chips that don't fit wrap onto a second line that the one-chip height
 * clips, so they drop out whole instead of running under the icons beside them. The
 * zero-width item first keeps even the first chip from shrinking to a sliver alone on its
 * line; a chip longer than its cap truncates.
 */
export const RowTagChips = memo(function RowTagChips({ task }: { task: Task }) {
  const { t } = useTranslation('list');
  const byId = useTagsStore((s) => s.byId);
  const tags = taskTags(task, byId);
  if (tags.length === 0) return null;
  const shown = tags.slice(0, maxRowChips);
  return (
    <span
      data-tag-chips
      className="flex h-chip min-w-0 shrink flex-wrap content-start items-center gap-1 overflow-hidden"
    >
      <span aria-hidden className="-me-1 h-chip w-0" />
      <span className="sr-only">
        {t('tags.rowLabel', { names: tags.map((tag) => tag.name).join(', ') })}
      </span>
      <span aria-hidden className="contents">
        {shown.map((tag, i) => (
          <Chip
            key={tag.id}
            color={tag.color}
            className={cn('max-w-date-cell', i > 0 && 'max-tablet:hidden')}
          >
            <span className="min-w-0 truncate">{tag.name}</span>
          </Chip>
        ))}
        {tags.length > 1 && (
          <span
            aria-hidden
            className="text-xs font-medium text-text-muted tabular-nums tablet:hidden"
          >
            +{tags.length - 1}
          </span>
        )}
        {tags.length > maxRowChips && (
          <span
            aria-hidden
            className="text-xs font-medium text-text-muted tabular-nums max-tablet:hidden"
          >
            +{tags.length - maxRowChips}
          </span>
        )}
      </span>
    </span>
  );
});

/** `align-left` (03 §3.1): the task has a non-blank description. */
export function DescriptionIndicator({ task, className }: { task: Task; className?: string }) {
  const { t } = useTranslation('list');
  if (!task.hasDescription) return null;
  return (
    <span
      data-testid="description-indicator"
      className={cn('inline-flex shrink-0 items-center text-text-muted', className)}
      title={t('row.hasDescription')}
    >
      <AlignLeft className="size-3" strokeWidth={iconStrokeWidth} aria-hidden />
      <span className="sr-only">{t('row.hasDescription')}</span>
    </span>
  );
}

const metaIcon = 'inline-flex shrink-0 items-center text-text-muted';

/**
 * `bell` (03 §3.1, FR-REM-4): the viewer has a pending reminder on the task; the tooltip and
 * screen-reader text name the next one ("Reminder: Fri 13:00"). Reminders are personal, so
 * `nextReminderAt` is the viewer's own (ADR 0049 §2.4).
 */
export function ReminderIndicator({
  task,
  ctx,
  className,
}: {
  task: Task;
  ctx: ViewerDateContext;
  className?: string;
}) {
  const { t } = useTranslation('list');
  if (task.nextReminderAt === null || task.nextReminderAt === undefined) return null;
  const label = t('row.reminder', { when: formatInstant(task.nextReminderAt, ctx) });
  return (
    <span data-testid="reminder-indicator" className={cn(metaIcon, className)} title={label}>
      <Bell className="size-3" strokeWidth={iconStrokeWidth} aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** `paperclip 3` (03 §3.1, P10): the task's live attachments. */
export function AttachmentCount({ task, className }: { task: Task; className?: string }) {
  const { t } = useTranslation('list');
  const count = task.counts.attachments;
  if (count === 0) return null;
  const label = t('row.attachments', { count });
  return (
    <span
      data-testid="attachment-count"
      className={cn(metaIcon, 'gap-0.5 text-xs tabular-nums', className)}
      title={label}
    >
      <Paperclip className="size-3" strokeWidth={iconStrokeWidth} aria-hidden />
      <span aria-hidden>{count}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * `repeat` (03 §3.1, FR-REC): the task repeats; the tooltip summarises the rule. Render it only
 * for tasks with a rule (it formats the rule on every render).
 */
export function RepeatIndicator({
  rule,
  basis,
  ctx,
  className,
}: {
  rule: string;
  basis: Task['recurrenceBasis'];
  ctx: ViewerDateContext;
  className?: string;
}) {
  const { t } = useTranslation('list');
  const ruleText = useRuleText(ctx);
  const label = t('row.repeats', { rule: ruleText(rule, basis) });
  return (
    <span data-testid="repeat-indicator" className={cn(metaIcon, className)} title={label}>
      <Repeat className="size-3" strokeWidth={iconStrokeWidth} aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** `list-tree 2/5` (03 §3.1). */
export function SubtaskCounter({ task, className }: { task: Task; className?: string }) {
  const { t } = useTranslation('list');
  const { subtasks, subtasksDone } = task.counts;
  if (subtasks === 0) return null;
  return (
    <span
      data-testid="subtask-counter"
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 text-xs text-text-muted tabular-nums',
        className,
      )}
      title={t('subtasks.progress', { done: subtasksDone, total: subtasks })}
    >
      <ListTree className="size-3" strokeWidth={iconStrokeWidth} aria-hidden />
      <span aria-hidden>
        {subtasksDone}/{subtasks}
      </span>
      <span className="sr-only">
        {t('subtasks.progress', { done: subtasksDone, total: subtasks })}
      </span>
    </span>
  );
}

/**
 * Today's group chip (02 §10): the row's group name, muted, so tasks from every group read in
 * context. Not interactive (M moves the task).
 */
export function GroupChip({ name, className }: { name: string; className?: string }) {
  const { t } = useTranslation('views');
  return (
    <span
      data-testid="group-chip"
      className={cn(
        'inline-flex h-chip max-w-date-cell shrink-0 items-center rounded-xs border border-border px-1.5 text-xs text-text-muted',
        className,
      )}
    >
      <span className="sr-only">{t('row.group', { name })}</span>
      <span aria-hidden className="truncate">
        {name}
      </span>
    </span>
  );
}
