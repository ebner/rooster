import { normalGroups, tasksInGroup } from '@rooster/core/reducers';
import { type RefObject, useState } from 'react';
import { Popover as AriaPopover, Dialog, Radio, RadioGroup } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { Button } from '../../ui/button';
import { overlayOffsetPx, popoverMotion, popoverSurface } from '../../ui/popover';
import { Select } from '../../ui/select';
import { useListContext } from './list-context';

type Choice = 'move' | 'delete';

const radioClass = cn(
  'group flex cursor-default items-center gap-2 rounded-sm py-1 text-sm text-text outline-none',
);
const radioDot = cn(
  'inline-flex size-4 shrink-0 items-center justify-center rounded-full border-(length:--border-check) border-border-strong',
  'group-data-selected:border-border-focus group-data-focus-visible:outline-2 group-data-focus-visible:outline-offset-2 group-data-focus-visible:outline-border-focus',
  "after:size-2 after:rounded-full after:content-[''] group-data-selected:after:bg-bg-accent",
);

/**
 * 02 §4: deleting a non-empty group asks where its tasks go: "Move 7 tasks to [group]"
 * (default: the group above, or below for the first) or "Delete the tasks too". Esc cancels.
 */
export function GroupDeletePopover({
  groupId,
  triggerRef,
}: {
  groupId: string;
  triggerRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation('list');
  const { controller } = useListContext();
  const state = controller.state();
  const [choice, setChoice] = useState<Choice>('move');
  const [target, setTarget] = useState(() => controller.defaultMoveTarget(groupId) ?? '');
  if (!state) return null;
  const group = state.groups[groupId];
  const count = tasksInGroup(state, groupId).filter((t) => t.completedAt === null).length;
  const options = Object.values(state.groups)
    .filter((g) => g.id !== groupId)
    .sort((a, b) =>
      a.kind === 'inbox' ? -1 : b.kind === 'inbox' ? 1 : a.position < b.position ? -1 : 1,
    )
    .map((g) => ({ id: g.id, label: g.name }));
  const close = () => controller.ui().set({ popover: null });
  const confirm = () =>
    controller.deleteGroup(
      groupId,
      choice === 'delete' ? { deleteTasks: true } : { moveTasksTo: target },
    );
  const canMove = normalGroups(state).length > 1 && target !== '';

  return (
    <AriaPopover
      triggerRef={triggerRef}
      isOpen
      onOpenChange={(open) => {
        if (!open) close();
      }}
      placement="bottom end"
      offset={overlayOffsetPx}
      className={cn(popoverSurface, popoverMotion, 'w-date-popover bg-bg-elevated p-3')}
    >
      <Dialog
        aria-label={t('groupDelete.title', { name: group?.name ?? '' })}
        className="outline-none"
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            confirm();
          }}
        >
          <p className="text-sm font-semibold text-text">
            {t('groupDelete.title', { name: group?.name ?? '' })}
          </p>
          <RadioGroup
            value={choice}
            onChange={(value) => setChoice(value as Choice)}
            aria-label={t('groupDelete.choice')}
            className="flex flex-col gap-2"
          >
            <Radio value="move" className={radioClass} isDisabled={!canMove}>
              <span className={radioDot} aria-hidden />
              {t('groupDelete.move', { count })}
            </Radio>
            {choice === 'move' && canMove && (
              <Select
                label={t('groupDelete.target')}
                hideLabel
                options={options}
                value={target}
                onChange={setTarget}
                className="ms-6"
              />
            )}
            <Radio value="delete" className={radioClass}>
              <span className={radioDot} aria-hidden />
              {t('groupDelete.deleteTasks')}
            </Radio>
          </RadioGroup>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onPress={close}>
              {t('groupDelete.cancel')}
            </Button>
            <Button
              size="sm"
              variant="danger"
              type="submit"
              isDisabled={choice === 'move' && !canMove}
            >
              {t('groupDelete.confirm')}
            </Button>
          </div>
        </form>
      </Dialog>
    </AriaPopover>
  );
}
