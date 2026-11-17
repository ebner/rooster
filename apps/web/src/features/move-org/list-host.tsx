import { type RefObject, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import type { ListController } from '../list/controller';
import type { PaneControls } from '../pane/pane-controls';
import { LazyMoveOrgPopover, LazyMoveOrgSheet } from './lazy';
import type { MoveOrgTarget } from './move-org-picker';
import { closeMoveOrg, movesWith, noteFollowed, useMoveOrgRequest } from './store';

/**
 * Runs a move asked for in a list (ADR 0072 §22): the controller queues it (with the toast,
 * the undo entry and the cursor move); an open pane showing a moved task follows it.
 */
export function moveListTasksToOrg(
  controller: ListController,
  pane: PaneControls | undefined,
  ids: readonly string[],
  target: MoveOrgTarget,
): boolean {
  const shown = pane?.taskId() ?? null;
  const follows = movesWith(controller.state(), shown, ids);
  const moved = controller.moveToOrg(
    { orgId: target.orgId, orgName: target.orgName, groupId: target.groupId },
    ids,
  );
  if (!moved) return false;
  if (controller.ui().selectionMode) controller.exitSelectionMode();
  if (follows && shown && pane) {
    noteFollowed(shown, target.orgId);
    // The pane follows the task, not the selection that moved on to the next row.
    controller.ui().set({ cursor: null, selected: {} });
    pane.followToOrg(target.orgSlug);
  }
  return true;
}

/**
 * The picker for the list showing `orgId`: anchored to the bulk bar's button or the cursor
 * row on desktop, a bottom sheet on phones.
 */
export function ListMoveOrgHost({
  orgId,
  controller,
  pane,
  mobile,
  rootRef,
}: {
  orgId: string;
  controller: ListController;
  pane: PaneControls | undefined;
  mobile: boolean;
  rootRef: RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation('mobile');
  const request = useMoveOrgRequest((s) => s.request);
  if (!request || request.orgId !== orgId) return null;
  const { ids } = request;
  const close = () => {
    closeMoveOrg();
    const store = controller.ui();
    store.set({ focusSeq: store.focusSeq + 1 });
  };
  const onMove = (target: MoveOrgTarget) => {
    closeMoveOrg();
    moveListTasksToOrg(controller, pane, ids, target);
  };

  if (mobile) {
    const subject =
      ids.length === 1
        ? (controller.task(ids[0] as string)?.title ?? '')
        : t('subject.tasks', { count: ids.length });
    return (
      <Suspense fallback={null}>
        <LazyMoveOrgSheet
          isOpen
          onOpenChange={(open) => !open && close()}
          ids={ids}
          sourceOrgId={orgId}
          subject={subject}
          onMove={onMove}
        />
      </Suspense>
    );
  }

  const cursor = controller.ui().cursor;
  const anchor =
    (request.anchor === 'bulk' ? document.querySelector('[data-bulk-move-org]') : null) ??
    (cursor
      ? (rootRef.current?.querySelector(`[data-row-id="${cursor}"] [data-focus-target]`) ??
        rootRef.current?.querySelector(`[data-row-id="${cursor}"]`))
      : null);
  if (!anchor) return null;
  return (
    <Suspense fallback={null}>
      <LazyMoveOrgPopover
        anchor={anchor}
        ids={ids}
        sourceOrgId={orgId}
        placement={request.anchor === 'bulk' ? 'top' : 'bottom start'}
        onMove={onMove}
        onClose={close}
      />
    </Suspense>
  );
}
