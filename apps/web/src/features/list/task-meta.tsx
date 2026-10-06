import type { Tag, Task } from '@rooster/core/schemas';
import { ListTree } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { useTagsStore } from '../../state/tags-store';
import { iconStrokeWidth } from '../../ui/button';
import { Chip } from '../../ui/chip';

/** 03 §3.1: at most three chips (one on phones), then "+N". */
export const maxRowChips = 3;

export function taskTags(task: Task, byId: Readonly<Record<string, Tag>>): Tag[] {
  return task.tagIds.flatMap((id) => (byId[id] ? [byId[id] as Tag] : []));
}

/** Tag chips for a row: never interactive themselves (a click opens the tag picker). */
export const RowTagChips = memo(function RowTagChips({ task }: { task: Task }) {
  const { t } = useTranslation('list');
  const byId = useTagsStore((s) => s.byId);
  const tags = taskTags(task, byId);
  if (tags.length === 0) return null;
  const shown = tags.slice(0, maxRowChips);
  return (
    <span data-tag-chips className="flex min-w-0 shrink items-center gap-1">
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
            {tag.name}
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
