import { BULK_MAX, type BulkOp, type TaskPatch } from '../schemas/list.ts';
import { type ApplyContext, applyOp, touchesDue } from './apply.ts';
import { type ListOpSpec, listOps } from './ops.ts';
import { type ListState, normalGroups, orderedGroups, tasksInGroup } from './state.ts';

/**
 * The ops that undo `op` when applied right after it (02 §3.7: undo is inverse mutations sent
 * through the normal pipeline). `before` is the state the op was applied to. An op that changed
 * nothing has no inverse (an empty array).
 */
export function inverseOf(op: ListOpSpec, before: ListState, ctx: ApplyContext): ListOpSpec[] {
  const id = op.entityId;
  switch (op.kind) {
    case 'task.create':
      return before.tasks[id] || before.deletedTasks[id] ? [] : [listOps.deleteTask(id)];
    case 'task.patch':
      return inversePatch(before, id, op.payload);
    case 'task.complete': {
      const task = before.tasks[id];
      if (!task || (task.completedAt !== null) === op.payload.completed) return [];
      return [listOps.completeTask(id, !op.payload.completed)];
    }
    case 'task.delete':
      return before.tasks[id] ? [listOps.restoreTask(id)] : [];
    case 'task.restore':
      return before.deletedTasks[id] ? [listOps.deleteTask(id)] : [];
    case 'task.move':
      return restorePlacements(before, applyOp(before, op, ctx), [id], ctx);
    case 'task.bulk':
      return inverseBulk(before, op.entityId, op.payload, ctx);
    case 'group.create': {
      if (before.groups[id] || before.deletedGroups[id]) return [];
      const after = applyOp(before, op, ctx);
      const splitFrom = op.payload.splitAfterTaskId
        ? before.tasks[op.payload.splitAfterTaskId]?.placement?.groupId
        : undefined;
      const moved = splitFrom !== undefined && tasksInGroup(after, id).length > 0;
      return [listOps.deleteGroup(id, moved ? { moveTasksTo: splitFrom } : {})];
    }
    case 'group.patch': {
      const group = before.groups[id];
      if (!group) return [];
      const name =
        group.kind === 'normal' && op.payload.name !== undefined && op.payload.name !== group.name;
      const collapsed =
        op.payload.collapsed !== undefined && op.payload.collapsed !== group.collapsed;
      if (!name && !collapsed) return [];
      return [
        listOps.patchGroup(id, {
          ...(name ? { name: group.name } : {}),
          ...(collapsed ? { collapsed: group.collapsed } : {}),
        }),
      ];
    }
    case 'group.move': {
      const group = before.groups[id];
      if (!group || group.kind === 'inbox') return [];
      const order = normalGroups(before);
      const predecessor = order[order.findIndex((g) => g.id === id) - 1]?.id ?? null;
      const rest = normalGroups(applyOp(before, op, ctx)).filter((g) => g.id !== id);
      const at = predecessor === null ? 0 : rest.findIndex((g) => g.id === predecessor) + 1;
      return [
        listOps.moveGroup(id, {
          afterId: rest[at - 1]?.id ?? null,
          beforeId: rest[at]?.id ?? null,
        }),
      ];
    }
    case 'group.delete': {
      const group = before.groups[id];
      if (!group || group.kind === 'inbox') return [];
      const restore = listOps.restoreGroup(id);
      if (op.payload.deleteTasks) return [restore];
      // The restored group is empty; moving the tasks back in their order restores it exactly.
      const ids = tasksInGroup(before, id).map((t) => t.id);
      return [restore, ...bulkMoves(before.orgId, ids, id)];
    }
    case 'group.restore': {
      if (!before.deletedGroups[id]) return [];
      const alongside = Object.values(before.deletedTasks).some((e) => e.withGroupId === id);
      return [listOps.deleteGroup(id, alongside ? { deleteTasks: true } : {})];
    }
  }
}

/** The inverse of a sequence: each op's inverse against its own before-state, in reverse. */
export function inverseOfSequence(
  ops: readonly ListOpSpec[],
  before: ListState,
  ctx: ApplyContext,
): ListOpSpec[] {
  const inverses: ListOpSpec[][] = [];
  let state = before;
  for (const op of ops) {
    inverses.push(inverseOf(op, state, ctx));
    state = applyOp(state, op, ctx);
  }
  return inverses.reverse().flat();
}

function inversePatch(before: ListState, id: string, p: TaskPatch): ListOpSpec[] {
  const task = before.tasks[id];
  if (!task) return [];
  const undo: TaskPatch = {
    ...(p.title === undefined || p.title === task.title ? {} : { title: task.title }),
    ...(p.description === undefined || p.description === task.description
      ? {}
      : { description: task.description ?? '' }),
    ...(touchesDue(p) && !sameDue(task, p)
      ? {
          dueDate: task.dueDate,
          dueTime: task.dueTime,
          dueTz: task.dueTz,
          startDate: task.startDate,
        }
      : {}),
  };
  return Object.keys(undo).length === 0 ? [] : [listOps.patchTask(id, undo)];
}

type Due = {
  dueDate?: string | null | undefined;
  dueTime?: string | null | undefined;
  dueTz?: string | null | undefined;
  startDate?: string | null | undefined;
};

function sameDue(a: Due, b: Due): boolean {
  return (
    (a.dueDate ?? null) === (b.dueDate ?? null) &&
    (a.dueTime ?? null) === (b.dueTime ?? null) &&
    (a.dueTz ?? null) === (b.dueTz ?? null) &&
    (a.startDate ?? null) === (b.startDate ?? null)
  );
}

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += BULK_MAX) out.push(items.slice(i, i + BULK_MAX));
  return out;
}

function bulkOf(
  orgId: string,
  op: 'complete' | 'uncomplete' | 'delete' | 'restore',
  ids: string[],
) {
  return chunks(ids).map((part) => listOps.bulk(orgId, { op, ids: part }));
}

/** Bulk moves appending `ids` (in order) to the end of `groupId`, chunked by BULK_MAX. */
function bulkMoves(orgId: string, ids: readonly string[], groupId: string): ListOpSpec[] {
  let afterId: string | null = null;
  return chunks(ids).map((part) => {
    const op = listOps.bulk(orgId, {
      op: 'move',
      ids: part,
      args: { groupId, afterId, beforeId: null },
    });
    afterId = part.at(-1) ?? null;
    return op;
  });
}

function inverseBulk(
  before: ListState,
  orgId: string,
  op: BulkOp,
  ctx: ApplyContext,
): ListOpSpec[] {
  switch (op.op) {
    case 'complete':
    case 'uncomplete': {
      const done = op.op === 'complete';
      const ids = op.ids.filter((i) => {
        const task = before.tasks[i];
        return task !== undefined && (task.completedAt !== null) !== done;
      });
      return bulkOf(orgId, done ? 'uncomplete' : 'complete', ids);
    }
    case 'delete':
      return bulkOf(
        orgId,
        'restore',
        op.ids.filter((i) => before.tasks[i]),
      );
    case 'restore':
      return bulkOf(
        orgId,
        'delete',
        op.ids.filter((i) => before.deletedTasks[i]),
      );
    case 'move':
      return restorePlacements(before, applyOp(before, listOps.bulk(orgId, op), ctx), op.ids, ctx);
    case 'setDue': {
      // One bulk op per distinct previous due unit.
      const byUnit = new Map<string, { due: Due; ids: string[] }>();
      for (const i of op.ids) {
        const task = before.tasks[i];
        if (!task || sameDue(task, op.args)) continue;
        const due = {
          dueDate: task.dueDate,
          dueTime: task.dueTime,
          dueTz: task.dueTz,
          startDate: task.startDate,
        };
        const key = JSON.stringify(due);
        const entry = byUnit.get(key) ?? { due, ids: [] };
        entry.ids.push(i);
        byUnit.set(key, entry);
      }
      return [...byUnit.values()].flatMap(({ due, ids }) =>
        chunks(ids).map((part) => listOps.bulk(orgId, { op: 'setDue', ids: part, args: due })),
      );
    }
    case 'addTag':
    case 'removeTag': {
      const add = op.op === 'addTag';
      // Only tasks whose tag state actually changes need the opposite op.
      const ids = op.ids.filter((i) => {
        const task = before.tasks[i];
        return task !== undefined && task.tagIds.includes(op.args.tagId) !== add;
      });
      return chunks(ids).map((part) =>
        listOps.bulk(orgId, {
          op: add ? 'removeTag' : 'addTag',
          ids: part,
          args: { tagId: op.args.tagId },
        }),
      );
    }
  }
}

/**
 * Moves that put `taskIds` back where they were in `before`, starting from `after`. Each task
 * goes directly below its original predecessor (restored first, in original order), so the
 * intents always name the real neighbours at the time the move is applied.
 */
export function restorePlacements(
  before: ListState,
  after: ListState,
  taskIds: readonly string[],
  ctx: ApplyContext,
): ListOpSpec[] {
  const groupIndex = new Map(orderedGroups(before).map((g, i) => [g.id, i]));
  const originals = new Map<string, string[]>();
  const changed = taskIds.filter((id) => {
    const was = before.tasks[id]?.placement;
    const now = after.tasks[id]?.placement;
    return was && now && (was.groupId !== now.groupId || was.position !== now.position);
  });
  const orderOf = (id: string) => {
    const groupId = before.tasks[id]?.placement?.groupId as string;
    let order = originals.get(groupId);
    if (!order) {
      order = tasksInGroup(before, groupId).map((t) => t.id);
      originals.set(groupId, order);
    }
    return { groupId, order, index: order.indexOf(id) };
  };
  changed.sort((a, b) => {
    const pa = orderOf(a);
    const pb = orderOf(b);
    return (
      (groupIndex.get(pa.groupId) ?? 0) - (groupIndex.get(pb.groupId) ?? 0) || pa.index - pb.index
    );
  });

  const ops: ListOpSpec[] = [];
  let state = after;
  for (const id of changed) {
    const { groupId, order, index } = orderOf(id);
    let predecessor: string | null = null;
    for (let j = index - 1; j >= 0; j--) {
      const candidate = order[j] as string;
      if (state.tasks[candidate]?.placement?.groupId === groupId) {
        predecessor = candidate;
        break;
      }
    }
    const current = tasksInGroup(state, groupId).filter((t) => t.id !== id);
    const at = predecessor === null ? 0 : current.findIndex((t) => t.id === predecessor) + 1;
    const op = listOps.moveTask(id, {
      groupId,
      afterId: current[at - 1]?.id ?? null,
      beforeId: current[at]?.id ?? null,
    });
    ops.push(op);
    state = applyOp(state, op, ctx);
  }
  return ops;
}
