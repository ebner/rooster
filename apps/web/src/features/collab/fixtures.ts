import { formatMention } from '@rooster/core/mentions';
import type { ActivityItem, Notification } from '@rooster/core/schemas';
import { fixtureIds } from '../shell/fixtures';

/** Fixed people, comments, activity and notifications for the kitchen sink and tests. */

const minute = 60_000;
const id = (n: number) => `0192f5d0-7a1e-7c3a-9f10-${String(n).padStart(12, '0')}`;
export const fixtureTaskId = id(900);

export const fixturePeople: Record<string, { name: string; image: string | null }> = {
  [fixtureIds.jannik]: { name: 'Jannik Lunde', image: null },
  [fixtureIds.anna]: { name: 'Anna Lindqvist', image: null },
  [fixtureIds.markus]: { name: 'Markus Lindén', image: null },
  [fixtureIds.sara]: { name: 'Sara Öberg', image: null },
  [fixtureIds.olof]: { name: 'Olof Åkesson', image: null },
};

export const fixtureCandidates = Object.entries(fixturePeople)
  .filter(([userId]) => userId !== fixtureIds.jannik)
  .map(([userId, p]) => ({
    userId,
    name: p.name,
    email: `${p.name.split(' ')[0]?.toLowerCase()}@example.com`,
    image: p.image,
  }));

/** A feed ending `now`: activity, comments (others', own, edited) in time order. */
export function fixtureFeed(now: number): ActivityItem[] {
  const at = (minutesAgo: number) => now - minutesAgo * minute;
  const base = { taskId: fixtureTaskId, via: 'web' as const };
  return [
    {
      kind: 'activity',
      activity: {
        ...base,
        id: id(1),
        actorId: fixtureIds.anna,
        type: 'created',
        data: {},
        createdAt: at(3000),
      },
    },
    {
      kind: 'activity',
      activity: {
        ...base,
        id: id(2),
        actorId: fixtureIds.anna,
        type: 'renamed',
        data: { from: 'Q4', to: 'Q4 draft' },
        createdAt: at(2990),
      },
    },
    {
      kind: 'activity',
      activity: {
        ...base,
        id: id(3),
        actorId: fixtureIds.anna,
        type: 'renamed',
        data: { from: 'Q4 draft', to: 'Write Q4 plan' },
        createdAt: at(2988),
      },
    },
    {
      kind: 'activity',
      activity: {
        ...base,
        id: id(4),
        actorId: fixtureIds.jannik,
        type: 'assigned',
        data: { from: fixtureIds.anna, to: fixtureIds.jannik },
        createdAt: at(2000),
      },
    },
    {
      kind: 'comment',
      comment: {
        id: id(10),
        taskId: fixtureTaskId,
        authorId: fixtureIds.anna,
        body: `${formatMention('Jannik Lunde', fixtureIds.jannik)} can you take this? The **numbers** are in the [budget sheet](https://example.com/budget).\n\n- Revenue\n- Costs`,
        createdAt: at(1500),
        editedAt: null,
      },
    },
    ...[0, 1, 2].map(
      (i): ActivityItem => ({
        kind: 'activity',
        activity: {
          ...base,
          id: id(20 + i),
          actorId: fixtureIds.jannik,
          type: 'description_edited',
          data: {},
          createdAt: at(900 - i * 30),
        },
      }),
    ),
    ...['Draft outline', 'Collect numbers'].map(
      (title, i): ActivityItem => ({
        kind: 'activity',
        activity: {
          ...base,
          id: id(30 + i),
          actorId: fixtureIds.jannik,
          type: 'subtask_added',
          data: { subtaskId: id(130 + i), title },
          createdAt: at(800 - i),
        },
      }),
    ),
    {
      kind: 'activity',
      activity: {
        ...base,
        id: id(40),
        actorId: fixtureIds.markus,
        via: 'cli',
        type: 'due_changed',
        data: { from: null, to: { dueDate: '2026-10-12', dueTime: null } },
        createdAt: at(300),
      },
    },
    {
      kind: 'comment',
      comment: {
        id: id(11),
        taskId: fixtureTaskId,
        authorId: fixtureIds.jannik,
        body: 'On it. I moved the due date to *Monday* and added `v2` notes.',
        createdAt: at(120),
        editedAt: at(100),
      },
    },
    {
      kind: 'comment',
      comment: {
        id: id(12),
        taskId: fixtureTaskId,
        authorId: fixtureIds.jannik,
        body: `Thanks ${formatMention('Markus Lindén', fixtureIds.markus)}!`,
        createdAt: at(0),
        editedAt: null,
      },
    },
  ];
}

/** The pending (unsent) comment of `fixtureFeed`. */
export const fixturePendingId = id(12);
/** An own comment to show in its editor. */
export const fixtureOwnCommentId = id(11);

export function fixtureNotifications(now: number): Notification[] {
  const at = (minutesAgo: number) => now - minutesAgo * minute;
  const anna = { id: fixtureIds.anna, name: 'Anna Lindqvist', image: null };
  const task = { id: fixtureTaskId, seq: 42, title: 'Write Q4 plan' };
  const common = { orgId: fixtureIds.companyOrg, orgSlug: 'brightwater', task, actor: anna };
  return [
    {
      ...common,
      id: id(50),
      type: 'mention',
      data: { commentId: id(10), excerpt: '@Jannik Lunde can you take this? The numbers are in…' },
      readAt: null,
      createdAt: at(2),
    },
    { ...common, id: id(51), type: 'assigned', data: {}, readAt: null, createdAt: at(65) },
    {
      ...common,
      id: id(52),
      type: 'due_changed',
      data: { from: null, to: { dueDate: '2026-10-12', dueTime: '14:00' } },
      readAt: at(10),
      createdAt: at(300),
    },
    {
      ...common,
      id: id(53),
      type: 'comment',
      data: { commentId: id(11), excerpt: 'Looks good to me.' },
      readAt: at(10),
      createdAt: at(1500),
    },
    { ...common, id: id(54), type: 'completed', data: {}, readAt: at(10), createdAt: at(3000) },
    {
      ...common,
      id: id(55),
      type: 'invite_accepted',
      task: null,
      actor: { id: fixtureIds.sara, name: 'Sara Öberg', image: null },
      data: { userId: fixtureIds.sara },
      readAt: at(10),
      createdAt: at(6000),
    },
    // P10 (FR-REM-3): the user's own reminders have no actor; the second fired late.
    {
      ...common,
      id: id(56),
      type: 'reminder',
      actor: null,
      data: {
        reminderId: id(60),
        fireAt: at(1),
        late: false,
        to: { dueDate: '2026-10-12', dueTime: '14:00' },
      },
      readAt: null,
      createdAt: at(1),
    },
    {
      ...common,
      id: id(57),
      type: 'reminder',
      actor: null,
      data: { reminderId: id(61), fireAt: at(7000), late: true },
      readAt: at(10),
      createdAt: at(6900),
    },
    // Phase 12 (11 §9.4): a device-grant approval; no actor, no task, the personal org.
    {
      id: id(58),
      orgId: fixtureIds.personalOrg,
      orgSlug: 'personal',
      type: 'device_connected',
      task: null,
      actor: null,
      data: {
        grantId: '0192f5d0-7a1e-7c3a-9f10-00000000c003',
        clientName: 'Acme Agent',
        clientHost: 'agent.acme.example',
        ip: '203.0.113.7',
      },
      readAt: null,
      createdAt: at(8000),
    },
  ];
}
