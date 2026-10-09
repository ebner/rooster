import { todayIn } from '@rooster/core/dates';
import { mentionsToPlain } from '@rooster/core/mentions';
import { compareKeys } from '@rooster/core/ordering';
import type { ExportComment, ExportTask, OrgExport, Tag } from '@rooster/core/schemas';
import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { comment, placement, tag as tagTable, task, taskGroup, user } from '../db/schema/index.ts';
import { toCommentDto } from './comment-service.ts';
import { type Actor, immediate, type ServiceDeps } from './context.ts';
import { listGroups } from './group-service.ts';
import {
  chunked,
  loadTaskExtras,
  placementsFor,
  type TaskRow,
  toGroupDto,
  toTaskDto,
} from './list-access.ts';
import { requireMembership } from './org-access.ts';
import { toTagDto } from './tag-service.ts';

export interface OrgExportFile {
  data: OrgExport;
  /** `rooster-<slug>-<yyyy-mm-dd>` (the actor's today); the route adds the extension. */
  fileStem: string;
}

const bySubtaskOrder = (a: TaskRow, b: TaskRow) =>
  compareKeys(a.subtaskPosition ?? '', b.subtaskPosition ?? '') || compareKeys(a.id, b.id);

/** `GET /orgs/:orgId/export` (FR-SET-5, 06 §2.8): the actor's data in one org. */
export class ExportService {
  constructor(private readonly deps: ServiceDeps) {}

  /**
   * My groups in order; my placed tasks (open and completed, not deleted) in group order and
   * position, each followed depth-first by its live subtasks (any assignee) in sibling
   * order; the org tags those tasks carry; and the live comments on those tasks (in task
   * order, oldest first per task). Members only (404 otherwise).
   */
  exportOrg(actor: Actor, orgRef: string): OrgExportFile {
    return immediate(this.deps.db, (tx) => {
      const { org } = requireMembership(tx, actor.userId, orgRef);
      const me = tx
        .select({ id: user.id, email: user.email, name: user.name, timezone: user.timezone })
        .from(user)
        .where(eq(user.id, actor.userId))
        .get();
      const groups = listGroups(tx, actor.userId, org.id);
      const groupIndex = new Map(groups.map((g, i) => [g.id, i]));
      const placed = tx
        .select({ task, groupId: placement.groupId, position: placement.position })
        .from(placement)
        .innerJoin(task, eq(task.id, placement.taskId))
        .innerJoin(taskGroup, eq(taskGroup.id, placement.groupId))
        .where(
          and(
            eq(placement.userId, actor.userId),
            eq(placement.orgId, org.id),
            isNull(task.deletedAt),
            isNull(taskGroup.deletedAt),
          ),
        )
        .all()
        .sort(
          (a, b) =>
            (groupIndex.get(a.groupId) ?? 0) - (groupIndex.get(b.groupId) ?? 0) ||
            compareKeys(a.position, b.position) ||
            compareKeys(a.task.id, b.task.id),
        );
      const children = new Map<string, TaskRow[]>();
      for (const row of tx
        .select()
        .from(task)
        .where(and(eq(task.orgId, org.id), isNotNull(task.parentId), isNull(task.deletedAt)))
        .orderBy(asc(task.id))
        .all()) {
        const siblings = children.get(row.parentId as string);
        if (siblings === undefined) children.set(row.parentId as string, [row]);
        else siblings.push(row);
      }
      for (const siblings of children.values()) siblings.sort(bySubtaskOrder);

      const rows: TaskRow[] = [];
      const seen = new Set<string>();
      const visit = (row: TaskRow) => {
        if (seen.has(row.id)) return;
        seen.add(row.id);
        rows.push(row);
        for (const child of children.get(row.id) ?? []) visit(child);
      };
      for (const p of placed) visit(p.task);

      const ids = rows.map((r) => r.id);
      const places = placementsFor(tx, actor.userId, ids);
      const extras = loadTaskExtras(tx, ids);
      const tasks: ExportTask[] = rows.map((r) => ({
        ...toTaskDto(r, places.get(r.id) ?? null, {}, extras),
        description: r.description,
      }));
      const used = new Set(tasks.flatMap((t) => t.tagIds));
      const tags: Tag[] =
        used.size === 0
          ? []
          : tx
              .select()
              .from(tagTable)
              .where(and(eq(tagTable.orgId, org.id), inArray(tagTable.id, [...used])))
              .orderBy(asc(tagTable.createdAt), asc(tagTable.id))
              .all()
              .map(toTagDto);
      const order = new Map(ids.map((id, i) => [id, i]));
      const comments: ExportComment[] = chunked(ids)
        .flatMap((chunk) =>
          tx
            .select({ row: comment, authorName: user.name })
            .from(comment)
            .innerJoin(user, eq(user.id, comment.authorId))
            .where(and(inArray(comment.taskId, chunk), isNull(comment.deletedAt)))
            .all(),
        )
        .sort(
          (a, b) =>
            (order.get(a.row.taskId) ?? 0) - (order.get(b.row.taskId) ?? 0) ||
            a.row.createdAt - b.row.createdAt ||
            compareKeys(a.row.id, b.row.id),
        )
        .map((c) => ({ ...toCommentDto(c.row), authorName: c.authorName }));
      const now = this.deps.clock();
      return {
        data: {
          format: 'rooster-export',
          version: 1,
          exportedAt: now,
          org: { id: org.id, slug: org.slug, name: org.name },
          user: { id: actor.userId, email: me?.email ?? actor.email, name: me?.name ?? '' },
          groups: groups.map(toGroupDto),
          tags,
          tasks,
          comments,
        },
        fileStem: `rooster-${org.slug}-${todayIn(me?.timezone ?? 'UTC', now)}`,
      };
    });
  }
}

/**
 * The Markdown rendering of an export (ADR 0012): `# Org`, then `## Group` per group in
 * order (empty ones too), tasks as checklist items with the due unit and `#tag`s, subtasks
 * nested two spaces deeper, the description as an indented paragraph under its task, and
 * its comments as indented quotes (author, UTC date, mentions as `@Name`). Deterministic:
 * the same export always renders the same text.
 */
export function renderExportMarkdown(data: OrgExport): string {
  const tagNames = new Map(data.tags.map((t) => [t.id, t.name]));
  const commentsOf = new Map<string, ExportComment[]>();
  for (const c of data.comments) {
    const list = commentsOf.get(c.taskId);
    if (list === undefined) commentsOf.set(c.taskId, [c]);
    else list.push(c);
  }
  const byParent = new Map<string, ExportTask[]>();
  const byGroup = new Map<string, ExportTask[]>();
  for (const t of data.tasks) {
    // Placed tasks are rows of their group (my own subtasks of others' tasks included, as in
    // the list); everything else is listed under its parent.
    const [map, key] =
      t.placement !== null ? [byGroup, t.placement.groupId] : [byParent, t.parentId ?? ''];
    const list = map.get(key);
    if (list === undefined) map.set(key, [t]);
    else list.push(t);
  }
  for (const list of byGroup.values()) {
    list.sort(
      (a, b) =>
        compareKeys(a.placement?.position ?? '', b.placement?.position ?? '') ||
        compareKeys(a.id, b.id),
    );
  }
  const lines: string[] = [`# ${data.org.name}`];
  const renderTask = (t: ExportTask, depth: number) => {
    const indent = '  '.repeat(depth);
    let line = `${indent}- [${t.completedAt === null ? ' ' : 'x'}] ${t.title}`;
    if (t.dueDate !== null) {
      const start = t.startDate === null ? '' : `start ${t.startDate}, `;
      line += ` — ${start}due ${t.dueDate}${t.dueTime === null ? '' : ` ${t.dueTime}`}`;
    }
    for (const id of t.tagIds) {
      const name = tagNames.get(id);
      if (name !== undefined) line += ` #${name}`;
    }
    lines.push(line);
    const description = t.description.trim();
    if (description !== '') {
      lines.push('');
      for (const text of description.split('\n')) {
        lines.push(text.trim() === '' ? '' : `${indent}  ${text}`);
      }
      lines.push('');
    }
    for (const c of commentsOf.get(t.id) ?? []) {
      const day = new Date(c.createdAt).toISOString().slice(0, 10);
      lines.push('', `${indent}  > **${c.authorName}** (${day}):`);
      for (const text of mentionsToPlain(c.body).trim().split('\n')) {
        lines.push(`${indent}  > ${text}`.trimEnd());
      }
      lines.push('');
    }
    for (const child of byParent.get(t.id) ?? []) renderTask(child, depth + 1);
  };
  for (const group of data.groups) {
    lines.push('', `## ${group.name}`);
    const tasks = byGroup.get(group.id) ?? [];
    if (tasks.length > 0) lines.push('');
    for (const t of tasks) renderTask(t, 0);
  }
  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}
