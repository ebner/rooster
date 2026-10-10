import { DEFAULT_PREFS } from '@rooster/core/limits';
import { useMemo } from 'react';
import { useMe } from '../../data/me';
import { useTaskDetail } from '../../data/task-detail';
import type { ViewerDateContext } from '../dates';
import type { ReminderSlotProps } from '../dates/date-popover';
import { ReminderSection } from '../dates/reminder-section';
import type { ListController } from './controller';

export interface TaskRemindersProps {
  taskId: string;
  controller: ListController;
  ctx: ViewerDateContext;
  slot: ReminderSlotProps;
}

/**
 * The date picker's reminder section for one task (02 §7 item 5): the viewer's reminders from
 * the task detail (`['task', id]`, with queued reminder ops replayed), added and removed
 * through the controller and so the outbox (ADR 0049 §2.7).
 */
export function TaskReminders({ taskId, controller, ctx, slot }: TaskRemindersProps) {
  const detail = useTaskDetail(taskId, controller.orgId, controller.deps.userId);
  const allDayReminderTime =
    useMe().data?.prefs?.allDayReminderTime ?? DEFAULT_PREFS.allDayReminderTime;
  const owner = useMemo(
    () => ({ timezone: ctx.timezone, allDayReminderTime }),
    [ctx.timezone, allDayReminderTime],
  );
  // A task the server does not know yet (created offline) has no reminders to load.
  const items = detail.data?.reminders ?? (detail.error ? [] : undefined);
  return (
    <ReminderSection
      items={items}
      due={slot.due}
      owner={owner}
      ctx={ctx}
      autoFocus={slot.autoFocus}
      onAdd={(spec) => {
        // A relative reminder resolves against the date being picked: save it first.
        slot.applyDraft();
        controller.addReminder(taskId, spec);
      }}
      onRemove={(reminder) => controller.removeReminder(taskId, reminder)}
    />
  );
}
