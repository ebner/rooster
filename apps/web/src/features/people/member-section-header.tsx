import { UserX } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { useListUi } from '../../state/list-store';
import { Avatar } from '../../ui/avatar';
import { iconStrokeWidth } from '../../ui/button';
import { GridCell, GridRow } from '../list/grid';
import { useListContext } from '../list/list-context';
import type { SectionRow } from '../list/model/rows';

/**
 * A member section of Everyone's tasks (02 §11): a group header's look (03 §3.2) with the
 * assignee's avatar, name and open count. A reassign drag over the section highlights it.
 */
export const MemberSectionHeader = memo(function MemberSectionHeader({ row }: { row: SectionRow }) {
  const { t } = useTranslation('people');
  const { t: tList } = useTranslation('list');
  const { controller } = useListContext();
  const dropInside = useListUi((s) => s.drop?.rowId === row.id && s.drop.edge === 'inside');
  const assigneeId = row.assigneeId ?? null;
  const person = row.person ?? null;
  const me = assigneeId !== null && assigneeId === controller.deps.userId;
  const name = assigneeId === null ? t('unassigned') : (person?.name ?? t('unknownMember'));
  return (
    <GridRow
      aria-level={1}
      data-row-id={row.id}
      data-testid="member-section"
      data-assignee={assigneeId ?? 'none'}
      className={cn(
        'sticky top-(--list-sticky-top) z-(--z-sticky) shrink-0 bg-bg-app',
        !row.first && 'mt-6',
      )}
    >
      <GridCell
        className={cn(
          'flex h-group items-center gap-1 rounded-sm ps-1 pe-1 max-tablet:h-group-mobile',
          'transition-colors duration-(--dur-fast)',
          dropInside &&
            'bg-bg-accent-subtle outline-1 -outline-offset-1 outline-drop-target-outline',
        )}
      >
        <span aria-hidden className="flex size-6 shrink-0 items-center justify-center">
          {assigneeId === null ? (
            <UserX className="size-4 text-text-muted" strokeWidth={iconStrokeWidth} />
          ) : (
            <Avatar
              id={assigneeId}
              name={name}
              src={person?.image ?? undefined}
              size={20}
              decorative
            />
          )}
        </span>
        <div className="flex min-w-0 flex-1 items-baseline gap-2 ps-1">
          <h2 className="min-w-0 truncate text-group">
            {name}
            {me && <span className="ms-1 font-normal text-text-muted">{t('picker.you')}</span>}
          </h2>
          <span aria-hidden className="shrink-0 text-sm text-text-muted tabular-nums">
            {row.count}
          </span>
          <span className="sr-only">{tList('group.count', { count: row.count })}</span>
        </div>
      </GridCell>
    </GridRow>
  );
});
