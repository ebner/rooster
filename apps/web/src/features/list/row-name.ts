import { diffDays } from '@rooster/core/dates';
import type { Task } from '@rooster/core/schemas';
import { useTranslation } from 'react-i18next';
import { useDateLabel } from '../dates';
import type { ViewerDateContext } from '../dates/types';

export interface RowName {
  /** The row's accessible name: "Book dentist, due tomorrow, not completed, 2 of 5 subtasks". */
  name: string;
  /** The part after the title, for the focused title's description. */
  description: string;
}

/**
 * 10 §5: what a screen reader says for a task row. The due part uses the relative label the
 * row shows; "Today", "Tomorrow" and "Yesterday" read mid-sentence, so they lose their capital.
 */
export function useTaskRowName(task: Task, title: string, ctx: ViewerDateContext): RowName {
  const { t } = useTranslation('list');
  const done = task.completedAt !== null;
  const info = useDateLabel(
    {
      dueDate: task.dueDate,
      dueTime: task.dueTime,
      dueTz: task.dueTz,
      startDate: task.startDate,
    },
    ctx,
    { completed: done },
  );
  const parts: string[] = [];
  if (info) {
    // A range ("Oct 9 – 11") keeps its month name's capital.
    const range = task.startDate !== null;
    const near =
      !range && task.dueDate !== null && Math.abs(diffDays(task.dueDate, ctx.today)) <= 1;
    const date = near
      ? info.label.charAt(0).toLocaleLowerCase(ctx.locale) + info.label.slice(1)
      : info.label;
    parts.push(t(info.state === 'overdue' ? 'a11y.overdue' : 'a11y.due', { date }));
  }
  parts.push(t(done ? 'a11y.done' : 'a11y.open'));
  const { subtasks, subtasksDone } = task.counts;
  if (subtasks > 0) parts.push(t('a11y.subtasks', { done: subtasksDone, total: subtasks }));
  const description = parts.join(', ');
  return { name: `${title}, ${description}`, description };
}
