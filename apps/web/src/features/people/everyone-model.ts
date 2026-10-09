import type { DueContext } from '@rooster/core/dates';
import { type EveryoneDueFilter, selectEveryone } from '@rooster/core/everyone';
import type { Task } from '@rooster/core/schemas';
import type { ViewSection } from '@rooster/core/views';
import type { Person } from './members';

/**
 * Everyone's tasks (02 §11, FR-VIEW-2) on screen: core's `selectEveryone` sections (me, the
 * others alphabetically, then Unassigned; rows by due date, then created) as list sections.
 */

const sectionPrefix = 'member:';

/** The section of an assignee (`null`: Unassigned). Also the drop target of a reassign drag. */
export function memberSectionId(userId: string | null): string {
  return `${sectionPrefix}${userId ?? 'none'}`;
}

/** The assignee a section stands for: a user ID, null (Unassigned), or undefined (not one). */
export function sectionAssignee(sectionId: string | undefined): string | null | undefined {
  if (!sectionId?.startsWith(sectionPrefix)) return undefined;
  const id = sectionId.slice(sectionPrefix.length);
  return id === 'none' ? null : id;
}

export type DueFilter = EveryoneDueFilter;

/** The header's filters (02 §11). The tag filter is the list's own (`tagFilter`, FR-TAG-4). */
export interface EveryoneFilters {
  due: DueFilter;
  /** Assignees to show: user IDs, null for Unassigned; empty: everyone. */
  members: readonly (string | null)[];
}

export const noEveryoneFilters: EveryoneFilters = { due: 'any', members: [] };

export interface EveryoneSection extends ViewSection {
  /** The section's assignee; null for Unassigned. */
  assigneeId: string | null;
  /** The member (null for Unassigned, or someone no longer in the org). */
  member: Person | null;
}

export interface EveryoneViewContext {
  viewerId: string;
  members: readonly Person[];
  locale: string;
  filters: EveryoneFilters;
  tagIds: readonly string[];
  due: DueContext;
  /** Show completed tasks (the header toggle). */
  showCompleted: boolean;
  /** Completed tasks still in their completion hold (02 §3.6) keep their row. */
  keep?: Readonly<Record<string, unknown>>;
}

/** The sections on screen, in order, each with its rows. */
export function everyoneSections(
  tasks: readonly Task[],
  ctx: EveryoneViewContext,
): EveryoneSection[] {
  const keep = ctx.keep ?? {};
  const shown = ctx.showCompleted
    ? tasks
    : tasks.filter((t) => t.completedAt === null || t.id in keep);
  const byId = new Map(ctx.members.map((m) => [m.userId, m]));
  return selectEveryone(shown, {
    viewerId: ctx.viewerId,
    members: ctx.members,
    locale: ctx.locale,
    due: ctx.due,
    filters: {
      due: ctx.filters.due,
      tagIds: ctx.tagIds,
      assigneeIds: ctx.filters.members,
      showCompleted: true,
    },
  }).map((section) => ({
    id: memberSectionId(section.assigneeId),
    kind: 'flat',
    date: null,
    taskIds: section.taskIds,
    assigneeId: section.assigneeId,
    member: section.assigneeId === null ? null : (byId.get(section.assigneeId) ?? null),
  }));
}
