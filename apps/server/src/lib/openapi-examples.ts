/**
 * Realistic example values for the OpenAPI components (routes/schemas.ts). The contract test
 * parses every example with its schema, so they cannot drift from the DTOs.
 */

/** UUIDv7 ids shared by the examples, so that references between them line up. */
export const EX = {
  user: '0199c5a0-1b2c-7a3d-8e4f-5a6b7c8d9e01',
  otherUser: '0199c5a0-1b2c-7a3d-8e4f-5a6b7c8d9e02',
  org: '0199c5a0-2c3d-7b4e-9f50-6b7c8d9e0a01',
  personalOrg: '0199c5a0-2c3d-7b4e-9f50-6b7c8d9e0a02',
  inbox: '0199c5a0-3d4e-7c5f-a061-7c8d9e0a1b01',
  prio: '0199c5a0-3d4e-7c5f-a061-7c8d9e0a1b02',
  upcoming: '0199c5a0-3d4e-7c5f-a061-7c8d9e0a1b03',
  task: '0199c5a1-4e5f-7d60-b172-8d9e0a1b2c01',
  otherTask: '0199c5a1-4e5f-7d60-b172-8d9e0a1b2c02',
  subtask: '0199c5a1-4e5f-7d60-b172-8d9e0a1b2c03',
  tag: '0199c5a1-5f60-7e71-8283-9e0a1b2c3d01',
  otherTag: '0199c5a1-5f60-7e71-8283-9e0a1b2c3d02',
  comment: '0199c5a2-6071-7f82-9394-0a1b2c3d4e01',
  activity: '0199c5a2-6071-7f82-9394-0a1b2c3d4e02',
  notification: '0199c5a2-7182-7093-a4a5-1b2c3d4e5f01',
  invite: '0199c5a2-8293-71a4-b5b6-2c3d4e5f6a01',
  session: '0199c5a2-93a4-72b5-86c7-3d4e5f6a7b01',
  allowlist: '0199c5a2-a4b5-73c6-97d8-4e5f6a7b8c01',
  push: '0199c5a2-b5c6-74d7-a8e9-5f6a7b8c9d01',
  reminder: '0199c5a2-c6d7-75e8-b9fa-6a7b8c9d0e01',
  attachment: '0199c5a2-d7e8-76f9-8a0b-7b8c9d0e1f01',
  icalFeed: '0199c5a2-e8f9-770a-9b1c-8c9d0e1f2a01',
  nextTask: '0199c5a1-4e5f-7d60-b172-8d9e0a1b2c04',
} as const;

/** 2026-10-09T08:00:00Z. */
export const T = 1_791_532_800_000;
const DAY = 86_400_000;

export const orgExample = {
  id: EX.org,
  slug: 'acme',
  name: 'Acme',
  isPersonal: false,
  avatarEmoji: '🚀',
  color: 'blue',
  role: 'owner',
  position: 'a1',
  collapsed: false,
};

export const personalOrgExample = {
  ...orgExample,
  id: EX.personalOrg,
  slug: 'anna',
  name: 'Personal',
  isPersonal: true,
  avatarEmoji: '🏠',
  color: 'amber',
  position: 'a0',
};

export const prefsExample = {
  parseTitleDates: true,
  completeHideMs: 1500,
  swipeLeft: 'date',
  swipeRight: 'complete',
  reminderTime: '08:00',
  allDayReminderTime: '09:00',
  digestTime: '07:00',
  emailMode: 'batch',
};

export const meExample = {
  id: EX.user,
  name: 'Anna Lindqvist',
  email: 'anna@example.com',
  image: null,
  locale: 'en',
  timezone: 'Europe/Stockholm',
  weekStart: 1,
  dateFormat: 'd MMM',
  timeFormat: '24h',
  prefs: prefsExample,
  isAdmin: false,
  orgs: [personalOrgExample, orgExample],
};

export const memberExample = {
  userId: EX.otherUser,
  name: 'Bo Ek',
  email: 'bo@example.com',
  image: null,
  role: 'member',
  joinedAt: T - 30 * DAY,
};

export const inviteExample = {
  id: EX.invite,
  kind: 'email',
  email: 'cleo@example.com',
  role: 'member',
  multiUse: false,
  uses: 0,
  createdAt: T,
  expiresAt: T + 7 * DAY,
  url: 'https://rooster.example.com/invite/Zk9wQ2xhdmUtdG9rZW4',
};

export const inviteCreatedExample = {
  id: EX.invite,
  kind: 'link',
  url: 'https://rooster.example.com/invite/Zk9wQ2xhdmUtdG9rZW4',
  expiresAt: T + 7 * DAY,
  emailed: false,
};

export const invitePreviewExample = {
  kind: 'link',
  orgSlug: 'acme',
  orgName: 'Acme',
  orgAvatarEmoji: '🚀',
  orgColor: 'blue',
  inviterName: 'Anna Lindqvist',
  role: 'member',
  email: null,
  expiresAt: T + 7 * DAY,
  valid: true,
  reason: null,
};

export const sessionExample = {
  id: EX.session,
  createdAt: T - 2 * DAY,
  updatedAt: T,
  expiresAt: T + 28 * DAY,
  ipAddress: '203.0.113.7',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) Firefox/150.0',
  current: true,
};

export const groupExample = {
  id: EX.prio,
  orgId: EX.org,
  kind: 'normal',
  name: 'Prio',
  position: 'a1',
  collapsed: false,
};

export const inboxExample = {
  ...groupExample,
  id: EX.inbox,
  kind: 'inbox',
  name: 'Inbox',
  position: 'a0',
};

export const placementExample = { groupId: EX.prio, position: 'a1V' };

export const taskExample = {
  id: EX.task,
  orgId: EX.org,
  seq: 42,
  parentId: null,
  subtaskPosition: null,
  title: 'Pay invoice',
  hasDescription: true,
  assigneeId: EX.user,
  createdBy: EX.user,
  dueDate: '2026-10-10',
  dueTime: null,
  dueTz: null,
  startDate: null,
  completedAt: null,
  tagIds: [EX.tag],
  counts: { subtasks: 1, subtasksDone: 0, comments: 2, attachments: 0 },
  placement: placementExample,
  createdAt: T,
  updatedAt: T,
};

export const subtaskExample = {
  ...taskExample,
  id: EX.subtask,
  seq: 43,
  parentId: EX.task,
  subtaskPosition: 'a0',
  title: 'Find the invoice number',
  hasDescription: false,
  dueDate: null,
  tagIds: [],
  counts: { subtasks: 0, subtasksDone: 0, comments: 0, attachments: 0 },
  placement: null,
};

export const taskDetailExample = {
  ...taskExample,
  description: 'Invoice **#2026-117** from the printer. Pay via the bank app.',
  subtasks: [subtaskExample],
  parentChain: [],
  followers: [EX.user],
};

export const tagExample = {
  id: EX.tag,
  orgId: EX.org,
  name: 'finance',
  color: 'green',
  createdAt: T - 10 * DAY,
};

export const commentExample = {
  id: EX.comment,
  taskId: EX.task,
  authorId: EX.user,
  body: `Paid, thanks @[Bo Ek](user:${EX.otherUser})!`,
  createdAt: T,
  editedAt: null,
};

export const activityExample = {
  id: EX.activity,
  taskId: EX.task,
  actorId: EX.user,
  via: 'cli',
  createdAt: T,
  type: 'due_changed',
  data: { from: null, to: { dueDate: '2026-10-10', dueTime: null } },
};

export const notificationExample = {
  id: EX.notification,
  orgId: EX.org,
  orgSlug: 'acme',
  type: 'mention',
  task: { id: EX.task, seq: 42, title: 'Pay invoice' },
  actor: { id: EX.user, name: 'Anna Lindqvist', image: null },
  data: { commentId: EX.comment, excerpt: 'Paid, thanks @Bo Ek!' },
  readAt: null,
  createdAt: T,
};

export const backupExample = {
  name: 'manual-2026-10-09T08-00-00-000Z.db',
  size: 4_194_304,
  createdAt: T,
  kind: 'manual',
};

export const pushSubscriptionExample = {
  id: EX.push,
  userAgent: 'Chrome on Android',
  createdAt: T - DAY,
  lastOkAt: T,
};

export const adminUserExample = {
  id: EX.otherUser,
  name: 'Bo Ek',
  email: 'bo@example.com',
  image: null,
  createdAt: T - 30 * DAY,
  disabledAt: null,
  isAdmin: false,
};

export const searchHitExample = {
  task: taskExample,
  orgId: EX.org,
  snippet: 'Pay \uE000invoice\uE001',
};

/** Every component example, by component name. */
const reminderExample = {
  id: EX.reminder,
  taskId: EX.task,
  kind: 'relative',
  offsetMinutes: 60,
  remindAt: null,
  fireAt: T + 4 * 3_600_000,
  firedAt: null,
  createdAt: T,
};
const icalFeedExample = { id: EX.icalFeed, orgId: null, createdAt: T, lastUsedAt: T + DAY };

export const COMPONENT_EXAMPLES: Record<string, unknown> = {
  // Phase 10.
  TaskSkip: { nextId: EX.nextTask },
  TaskSkipResult: {
    next: { ...taskExample, id: EX.nextTask, seq: 43, dueDate: '2026-10-16' },
  },
  Reminder: reminderExample,
  ReminderCreate: { offsetMinutes: 60 },
  ReminderList: [reminderExample],
  Attachment: {
    id: EX.attachment,
    taskId: EX.task,
    filename: 'receipt.png',
    mime: 'image/png',
    size: 182_340,
    uploaderId: EX.user,
    image: { width: 1200, height: 800, thumb: true },
    createdAt: T,
  },
  IcalFeed: icalFeedExample,
  IcalFeedCreate: { orgId: null },
  IcalFeedCreated: {
    feed: icalFeedExample,
    url: 'https://rooster.example.com/ical/rcal_8Kx1q0ZpVb3mT2yWc9dLr5nA7fGh4jE6sUo0iQ1zXk.ics',
  },
  IcalFeedList: [icalFeedExample],
  Org: orgExample,
  OrgCreate: { name: 'Acme', avatarEmoji: '🚀', color: 'blue' },
  OrgPatch: { name: 'Acme Inc.' },
  OrgDelete: { confirmName: 'Acme' },
  OrgOrder: { orgId: EX.org, afterId: EX.personalOrg, beforeId: null },
  OrgOrderResult: { orgId: EX.org, position: 'a1' },
  OrgPrefPatch: { collapsed: true },
  Member: memberExample,
  MemberPatch: { role: 'owner' },
  Invite: inviteExample,
  InviteCreate: { email: 'cleo@example.com', role: 'member', expiresInDays: 7 },
  InviteCreated: inviteCreatedExample,
  InvitePreview: invitePreviewExample,
  Prefs: prefsExample,
  Me: meExample,
  MePatch: { timezone: 'Europe/Stockholm', prefs: { swipeLeft: 'move' } },
  Session: sessionExample,
  AllowlistEntry: { id: EX.allowlist, kind: 'domain', value: 'example.com', createdAt: T },
  AllowlistCreate: { kind: 'email', value: 'cleo@example.com' },
  AdminUser: adminUserExample,
  AdminUserPatch: { disabled: true },
  Group: groupExample,
  GroupCreate: { name: 'Waiting for', afterId: EX.prio, beforeId: EX.upcoming },
  GroupCreateResult: {
    group: { ...groupExample, id: EX.upcoming, name: 'Waiting for', position: 'a1V' },
    moved: [],
  },
  GroupPatch: { name: 'Next up' },
  GroupMove: { afterId: EX.inbox, beforeId: EX.prio },
  GroupMoveResult: { position: 'a0V' },
  GroupDelete: { moveTasksTo: EX.inbox },
  Placement: placementExample,
  Task: taskExample,
  MyList: {
    groups: [inboxExample, groupExample],
    tasks: [taskExample, subtaskExample],
    expandedTaskIds: [EX.task],
    serverTime: T,
  },
  TaskCreate: {
    id: EX.task,
    title: 'Pay invoice',
    dueDate: '2026-10-10',
    groupId: EX.prio,
    afterId: EX.otherTask,
    tagNames: ['finance'],
  },
  TaskPatch: { title: 'Pay invoice #2026-117', dueDate: '2026-10-12' },
  TaskPatchResult: { task: taskExample, ignoredFields: [] },
  TaskMove: { groupId: EX.prio, afterId: null, beforeId: EX.otherTask },
  TaskMoveResult: { placement: placementExample },
  TaskComplete: { completed: true },
  TaskCompleteResult: { task: { ...taskExample, completedAt: T } },
  BulkOp: { op: 'move', ids: [EX.task, EX.otherTask], args: { groupId: EX.prio } },
  BulkResult: {
    results: [
      { id: EX.task, ok: true },
      { id: EX.otherTask, ok: false, code: 'not_found' },
    ],
  },
  TrashPage: {
    items: [{ ...taskExample, placement: null, deletedAt: T, deletedBy: EX.user }],
    nextCursor: null,
  },
  TaskPage: { items: [taskExample], nextCursor: 'eyJvIjo1MH0' },
  Backup: backupExample,
  TaskDetail: taskDetailExample,
  SubtaskReorder: { afterId: null, beforeId: EX.subtask },
  SubtaskReorderResult: { subtaskPosition: 'Zz' },
  TaskDuplicate: { includeSubtasks: true },
  Tag: tagExample,
  TagCreate: { name: 'finance', color: 'green' },
  TagPatch: { name: 'money' },
  TagMerge: { intoId: EX.otherTag },
  SearchHit: searchHitExample,
  SearchResult: [searchHitExample],
  ReindexResult: { indexed: 1204, durationMs: 85, finishedAt: T },
  ExportComment: { ...commentExample, authorName: 'Anna Lindqvist' },
  ExportTask: { ...taskExample, description: 'Invoice **#2026-117** from the printer.' },
  OrgExport: {
    format: 'rooster-export',
    version: 1,
    exportedAt: T,
    org: { id: EX.org, slug: 'acme', name: 'Acme' },
    user: { id: EX.user, email: 'anna@example.com', name: 'Anna Lindqvist' },
    groups: [inboxExample, groupExample],
    tags: [tagExample],
    tasks: [{ ...taskExample, description: 'Invoice **#2026-117** from the printer.' }],
    comments: [{ ...commentExample, authorName: 'Anna Lindqvist' }],
  },
  Comment: commentExample,
  CommentCreate: { id: EX.comment, body: commentExample.body },
  CommentPatch: { body: 'Paid on Friday.' },
  Activity: activityExample,
  ActivityPage: {
    items: [
      { kind: 'activity', activity: activityExample },
      { kind: 'comment', comment: commentExample },
    ],
    nextCursor: null,
  },
  FollowState: { followers: [EX.user, EX.otherUser] },
  Notification: notificationExample,
  NotificationPage: { items: [notificationExample], nextCursor: null, unreadCount: 1 },
  NotificationMark: { ids: [EX.notification] },
  NotificationMarkResult: { unreadCount: 0 },
  NotificationPrefs: {
    prefs: [
      { type: 'mention', channel: 'inapp', enabled: true },
      { type: 'mention', channel: 'email', enabled: true },
      { type: 'digest', channel: 'email', enabled: false },
    ],
  },
  NotificationPrefsPut: { prefs: [{ type: 'comment', channel: 'push', enabled: false }] },
  VapidPublicKey: {
    publicKey:
      'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U',
  },
  PushSubscriptionCreate: {
    endpoint: 'https://fcm.googleapis.com/fcm/send/dXJsLXNhZmUtZXhhbXBsZQ',
    keys: {
      p256dh:
        'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
      auth: 'tBHItJI5svbpez7KI4CCXg',
    },
    userAgent: 'Chrome on Android',
  },
  PushSubscription: pushSubscriptionExample,
  SseHello: { version: '1.1.0', gitSha: 'abc1234', serverTime: T },
  SseInvalidate: { org: EX.org, keys: [['my-list', EX.org]], origin: 'tab-0199c5a2' },
  SseNotification: {
    unreadCount: 1,
    notification: {
      id: EX.notification,
      orgId: EX.org,
      type: 'mention',
      taskId: EX.task,
      actorName: 'Anna Lindqvist',
      title: 'Pay invoice',
    },
  },
  Problem: {
    type: 'about:blank',
    title: 'Unprocessable Content',
    status: 422,
    detail: 'The request did not pass validation.',
    code: 'validation_failed',
    errors: [{ path: 'title', message: 'Too small: expected string to have >=1 characters' }],
  },
  Meta: {
    version: '1.1.0',
    gitSha: 'abc1234',
    providers: [{ id: 'google', name: 'Google' }],
    features: { email: true, push: true, s3: false },
    serverTime: T,
  },
};
