import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { Avatar } from '../../ui/avatar';
import { useMemberMap } from './members';

/**
 * The row's assignee avatar (03 §3.1, §3.13: 20 px), only where it says something: in
 * Everyone's tasks and on subtasks assigned to someone else (FR-TASK-10). A member who left
 * the org (or is not loaded yet) shows the initials of "?".
 */
export const RowAssignee = memo(function RowAssignee({
  orgId,
  assigneeId,
  className,
}: {
  orgId: string;
  assigneeId: string;
  className?: string | undefined;
}) {
  const { t } = useTranslation('people');
  const member = useMemberMap(orgId).get(assigneeId);
  const name = member?.name ?? t('unknownMember');
  return (
    <span
      data-testid="row-assignee"
      data-user-id={assigneeId}
      className={cn('inline-flex shrink-0 items-center', className)}
      title={t('row.assignee', { name })}
    >
      <Avatar id={assigneeId} name={name} src={member?.image ?? undefined} size={20} decorative />
      <span className="sr-only">{t('row.assignee', { name })}</span>
    </span>
  );
});
