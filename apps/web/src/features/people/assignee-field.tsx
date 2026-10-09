import type { Task } from '@rooster/core/schemas';

export interface AssigneeFieldProps {
  orgId: string;
  task: Pick<Task, 'id' | 'assigneeId' | 'orgId'>;
  /** `pane`: the desktop property grid (popover); `sheet`: the phone's 48 px row (bottom sheet). */
  variant: 'pane' | 'sheet';
}

/**
 * The detail pane's Assignee property (02 §9.2, FR-COL-1): the avatar and name, opening the
 * assignee picker; assigning goes through the mutation pipeline. Shared orgs only: the pane
 * does not render it in a personal org (FR-COL-6).
 */
export function AssigneeField(_props: AssigneeFieldProps) {
  return null;
}
