import type { Task } from '@rooster/core/schemas';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, UserX } from 'lucide-react';
import { Suspense, useMemo, useRef, useState } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { everyoneKey } from '../../data/everyone';
import { useListPipeline } from '../../data/list';
import { useMe } from '../../data/me';
import { useOrgMembers } from '../../data/orgs';
import { taskDetailKey } from '../../data/task-detail';
import { cn } from '../../lib/cn';
import { Avatar } from '../../ui/avatar';
import { iconStrokeWidth } from '../../ui/button';
import { useViewerDateContext } from '../dates';
import { ListController, type Translate } from '../list/controller';
import { AssigneeSheet } from './assignee-sheet';
import { LazyAssigneePicker } from './lazy';
import { sortMembers } from './members';

export interface AssigneeFieldProps {
  orgId: string;
  task: Pick<Task, 'id' | 'assigneeId' | 'orgId'>;
  /** `pane`: the desktop property grid (popover); `sheet`: the phone's 48 px row (bottom sheet). */
  variant: 'pane' | 'sheet';
  /**
   * Controlled open state, for the pane's focus target `assignee` (Tab+A / A from the list) and
   * its own Tab+A. Uncontrolled (a click opens it) when absent.
   */
  isOpen?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
}

/**
 * The detail pane's Assignee property (02 §9.2, FR-COL-1): the avatar and name, opening the
 * assignee picker; assigning goes through the mutation pipeline with undo. Shared orgs only:
 * the pane does not render it in a personal org (FR-COL-6).
 */
export function AssigneeField({
  orgId,
  task,
  variant,
  isOpen: controlledOpen,
  onOpenChange,
}: AssigneeFieldProps) {
  const { t } = useTranslation('people');
  const { t: tList } = useTranslation('list');
  const pipeline = useListPipeline();
  const queryClient = useQueryClient();
  const me = useMe().data?.user.id ?? '';
  const membersData = useOrgMembers(orgId).data;
  const members = useMemo(() => sortMembers(membersData ?? [], me), [membersData, me]);
  const dateCtx = useViewerDateContext();
  const dateRef = useRef(dateCtx);
  dateRef.current = dateCtx;
  const membersRef = useRef(members);
  membersRef.current = members;
  const trigger = useRef<HTMLButtonElement>(null);
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlledOpen ?? ownOpen;
  const setOpen = (next: boolean) => {
    setOwnOpen(next);
    onOpenChange?.(next);
  };

  const controller = useMemo(
    () =>
      new ListController({
        orgId,
        userId: me,
        pipeline,
        t: tList as unknown as Translate,
        rows: () => [],
        dateContext: () => dateRef.current,
        members: () => membersRef.current,
        // A task outside My tasks (opened from Everyone's tasks or a link): undo needs it.
        extraTasks: () => {
          const everyone = queryClient.getQueryData<readonly Task[]>(everyoneKey(orgId));
          const detail = queryClient.getQueryData<Task>(taskDetailKey(task.id));
          const found = everyone?.find((t) => t.id === task.id) ?? detail;
          return found ? { [found.id]: found } : undefined;
        },
      }),
    [orgId, me, pipeline, tList, queryClient, task.id],
  );

  const member = task.assigneeId ? members.find((m) => m.userId === task.assigneeId) : undefined;
  const name = task.assigneeId === null ? t('unassigned') : (member?.name ?? t('unknownMember'));
  const pick = (assigneeId: string | null) => controller.assign([task.id], assigneeId);

  const value = (
    <>
      {task.assigneeId === null ? (
        <UserX
          className="size-5 shrink-0 text-text-muted"
          strokeWidth={iconStrokeWidth}
          aria-hidden
        />
      ) : (
        <Avatar
          id={task.assigneeId}
          name={name}
          src={member?.image ?? undefined}
          size={variant === 'sheet' ? 24 : 20}
          decorative
        />
      )}
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-start',
          task.assigneeId === null && 'text-text-muted',
        )}
      >
        {name}
        {task.assigneeId !== null && task.assigneeId === me && (
          <span className="ms-1 text-text-muted">{t('picker.you')}</span>
        )}
      </span>
    </>
  );

  if (variant === 'sheet') {
    return (
      <>
        <AriaButton
          ref={trigger}
          data-testid="assignee-field"
          aria-label={t('field.label', { name })}
          onPress={() => setOpen(true)}
          className={cn(
            'flex h-property-row-mobile w-full items-center gap-3 rounded-sm px-1 text-md text-text',
            'outline-none pressed:bg-bg-muted focus-ring:outline-2 focus-ring:-outline-offset-2 focus-ring:outline-border-focus',
          )}
        >
          {value}
          <ChevronRight
            className="size-5 shrink-0 text-text-muted"
            strokeWidth={iconStrokeWidth}
            aria-hidden
          />
        </AriaButton>
        <AssigneeSheet
          isOpen={open}
          onOpenChange={setOpen}
          members={members}
          meId={me}
          current={task.assigneeId}
          onPick={pick}
        />
      </>
    );
  }

  return (
    <>
      <AriaButton
        ref={trigger}
        data-testid="assignee-field"
        aria-label={t('field.label', { name })}
        onPress={() => setOpen(true)}
        className={cn(
          'flex h-control min-w-0 max-w-full items-center gap-2 rounded-sm px-1.5 text-sm text-text',
          'outline-none transition-colors duration-(--dur-fast) hover:bg-bg-subtle pressed:bg-bg-muted',
          'focus-ring:outline-2 focus-ring:-outline-offset-2 focus-ring:outline-border-focus',
          open && 'bg-bg-muted',
        )}
      >
        {value}
      </AriaButton>
      {open && trigger.current && (
        <Suspense fallback={null}>
          <LazyAssigneePicker
            anchor={trigger.current}
            members={members}
            meId={me}
            current={task.assigneeId}
            label={t('picker.labelField')}
            onPick={pick}
            onClose={() => {
              setOpen(false);
              trigger.current?.focus();
            }}
          />
        </Suspense>
      )}
    </>
  );
}
