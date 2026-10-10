import { lazyWithPreload } from '../../lib/lazy';

/** 10 §4: list popovers load on first open (and at idle); see `lib/lazy.ts`. */
export const LazyTagPicker = lazyWithPreload(() =>
  import('../tags/tag-picker').then((m) => m.TagPicker),
);
export const LazyMoveToPopover = lazyWithPreload(() =>
  import('./move-to-popover').then((m) => m.MoveToPopover),
);
export const LazyGroupDeletePopover = lazyWithPreload(() =>
  import('./group-delete-popover').then((m) => m.GroupDeletePopover),
);
/** P10: the date picker's reminder section for a task (loads with the picker). */
export const LazyTaskReminders = lazyWithPreload(() =>
  import('./task-reminders').then((m) => m.TaskReminders),
);
/** P10 (FR-REC-4): "Delete this task / this and following". */
export const LazyRecurringDeletePopover = lazyWithPreload(() =>
  import('./recurring-delete').then((m) => m.RecurringDeletePopover),
);
export const LazyRecurringDeleteSheet = lazyWithPreload(() =>
  import('./recurring-delete').then((m) => m.RecurringDeleteSheet),
);
