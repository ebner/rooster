import {
  activityPageSchema,
  activitySchema,
  adminUserPatchSchema,
  adminUserSchema,
  allowlistCreateSchema,
  allowlistEntrySchema,
  backupSchema,
  bulkOpSchema,
  bulkResultSchema,
  commentCreateSchema,
  commentPatchSchema,
  commentSchema,
  exportCommentSchema,
  exportTaskSchema,
  followStateSchema,
  groupCreateResultSchema,
  groupCreateSchema,
  groupDeleteSchema,
  groupMoveResultSchema,
  groupMoveSchema,
  groupPatchSchema,
  groupSchema,
  inviteCreatedSchema,
  inviteCreateSchema,
  invitePreviewSchema,
  inviteSchema,
  mailTestResultSchema,
  memberPatchSchema,
  memberSchema,
  mePatchSchema,
  meSchema,
  myListSchema,
  notificationMarkResultSchema,
  notificationMarkSchema,
  notificationPageSchema,
  notificationPrefsPutSchema,
  notificationPrefsSchema,
  notificationSchema,
  orgCreateSchema,
  orgDeleteSchema,
  orgExportSchema,
  orgOrderResultSchema,
  orgOrderSchema,
  orgPatchSchema,
  orgPrefPatchSchema,
  orgSchema,
  placementSchema,
  prefsSchema,
  pushSubscriptionCreateSchema,
  pushSubscriptionSchema,
  reindexResultSchema,
  resolvedMemberSchema,
  searchHitSchema,
  sessionSchema,
  subtaskReorderResultSchema,
  subtaskReorderSchema,
  tagCreateSchema,
  tagMergeSchema,
  tagPatchSchema,
  tagSchema,
  taskCompleteResultSchema,
  taskCompleteSchema,
  taskCreateSchema,
  taskDetailSchema,
  taskDuplicateSchema,
  taskMoveResultSchema,
  taskMoveSchema,
  taskPageSchema,
  taskPatchResultSchema,
  taskPatchSchema,
  taskSchema,
  trashPageSchema,
  vapidPublicKeySchema,
} from '@rooster/core/schemas';
import { describe, named, z } from '../lib/openapi.ts';

const AFTER_ID =
  'Ordering intent: the item that will be directly ABOVE (lower position). Null or absent with `beforeId` set means the top; both absent means the end.';
const BEFORE_ID = 'Ordering intent: the item that will be directly BELOW (higher position).';
const POSITION =
  'Fractional-index key computed by the server. Compare with plain code-unit order (never locale-aware); never send it back.';
const NEXT_CURSOR = 'Pass as `cursor` to get the next page; null on the last page.';

// DTOs from @rooster/core, registered as named OpenAPI components (06 §4).
export const OrgSchema = named(
  describe(orgSchema, {
    slug: 'URL name, unique per instance; accepted wherever `{orgId}` is.',
    isPersonal: 'Every user has exactly one personal org; it cannot be shared or deleted.',
    role: 'My role in the org.',
    position: `My sidebar order of orgs. ${POSITION}`,
    collapsed: 'Whether I collapsed the org in my sidebar.',
  }),
  'Org',
);
export const OrgCreateSchema = named(orgCreateSchema, 'OrgCreate');
export const OrgPatchSchema = named(orgPatchSchema, 'OrgPatch');
export const OrgDeleteSchema = named(orgDeleteSchema, 'OrgDelete');
export const OrgOrderSchema = named(
  describe(orgOrderSchema, { afterId: AFTER_ID, beforeId: BEFORE_ID }),
  'OrgOrder',
);
export const OrgOrderResultSchema = named(orgOrderResultSchema, 'OrgOrderResult');
export const OrgPrefPatchSchema = named(orgPrefPatchSchema, 'OrgPrefPatch');
export const MemberSchema = named(
  describe(memberSchema, {
    email:
      'Only for the signed-in browser. Apps and tokens with a grant never see colleagues’ emails (11 §2.1).',
  }),
  'Member',
);
export const ResolvedMemberSchema = named(resolvedMemberSchema, 'ResolvedMember');
export const MemberPatchSchema = named(memberPatchSchema, 'MemberPatch');
export const InviteSchema = named(inviteSchema, 'Invite');
export const InviteCreateSchema = named(
  describe(inviteCreateSchema, {
    email:
      'Invite this address (single use; sent by email when SMTP is configured). Omit it for a link invite.',
    multiUse: 'Link invites only: the link can be used by several people until it expires.',
    expiresInDays: 'Default 7.',
  }),
  'InviteCreate',
);
export const InviteCreatedSchema = named(inviteCreatedSchema, 'InviteCreated');
export const InvitePreviewSchema = named(invitePreviewSchema, 'InvitePreview');
export const PrefsSchema = named(prefsSchema, 'Prefs');
// Nested DTOs are re-attached so the document references them instead of inlining.
export const MeSchema = named(
  meSchema.extend({ prefs: PrefsSchema, orgs: z.array(OrgSchema) }),
  'Me',
);
export const MePatchSchema = named(
  describe(mePatchSchema, {
    timezone: 'IANA timezone; due-date views are evaluated in it.',
    weekStart: '0 = Sunday, 1 = Monday.',
    prefs: 'Merged into the stored prefs: send only the keys that change.',
  }),
  'MePatch',
);
export const SessionSchema = named(sessionSchema, 'Session');
export const AllowlistEntrySchema = named(allowlistEntrySchema, 'AllowlistEntry');
export const AllowlistCreateSchema = named(allowlistCreateSchema, 'AllowlistCreate');
export const AdminUserSchema = named(adminUserSchema, 'AdminUser');
export const AdminUserPatchSchema = named(adminUserPatchSchema, 'AdminUserPatch');

// Phase 2: the list (05 §5, 06 §2.3–2.4).
export const GroupSchema = named(
  describe(groupSchema, {
    kind: 'Every user has one Inbox per org: always first, cannot be renamed or deleted.',
    position: `${POSITION} Ignored for the Inbox.`,
  }),
  'Group',
);
export const GroupCreateSchema = named(
  describe(groupCreateSchema, {
    id: 'Client-chosen UUIDv7, so an offline client can refer to the group before it syncs.',
    afterId: AFTER_ID,
    beforeId: BEFORE_ID,
    splitAfterTaskId:
      'Split instead: the group is inserted after this task’s group and every task below the task moves into it. Intents are then ignored.',
  }),
  'GroupCreate',
);
export const GroupCreateResultSchema = named(
  groupCreateResultSchema.extend({ group: GroupSchema }),
  'GroupCreateResult',
);
export const GroupPatchSchema = named(groupPatchSchema, 'GroupPatch');
export const GroupMoveSchema = named(
  describe(groupMoveSchema, { afterId: AFTER_ID, beforeId: BEFORE_ID }),
  'GroupMove',
);
export const GroupMoveResultSchema = named(groupMoveResultSchema, 'GroupMoveResult');
export const GroupDeleteSchema = named(
  describe(groupDeleteSchema, {
    moveTasksTo: 'Move the group’s tasks to the end of this group of mine.',
    deleteTasks: 'Move the group’s tasks to Trash instead.',
  }),
  'GroupDelete',
);
export const PlacementSchema = named(
  describe(placementSchema, {
    groupId: 'One of my groups.',
    position: `Order within the group. ${POSITION}`,
  }),
  'Placement',
);
export const TaskSchema = named(
  describe(taskSchema.extend({ placement: PlacementSchema.nullable() }), {
    seq: 'Org-scoped human number (`#42`); null only while a client-created task is unsynced.',
    parentId: 'The parent task when this is a subtask.',
    subtaskPosition: `Order among sibling subtasks. ${POSITION}`,
    description: 'Markdown. Left out of list payloads; see `hasDescription`.',
    hasDescription: 'True when the description is not blank.',
    assigneeId: 'Null: unassigned.',
    dueDate: 'Floating calendar date: no timezone, compare as a string.',
    dueTime: 'Wall-clock time; only with `dueDate` and `dueTz`.',
    dueTz: 'IANA timezone of `dueTime`.',
    startDate: 'Start of a date range ending at `dueDate`; only with a due date, never after it.',
    completedAt: 'Null while open.',
    tagIds: 'Org tag IDs, in the order they were added.',
    placement: 'Where the task is in MY list; null when it is not in my list (e.g. a subtask).',
    deletedAt: 'Only in Trash payloads.',
    deletedBy: 'Only in Trash payloads.',
  }),
  'Task',
);
export const MyListSchema = named(
  myListSchema.extend({ groups: z.array(GroupSchema), tasks: z.array(TaskSchema) }),
  'MyList',
);
export const TaskCreateSchema = named(
  describe(taskCreateSchema, {
    id: 'Client-chosen UUIDv7: retrying the same create returns the task; other content with the same ID is `409 id_conflict`.',
    afterId: AFTER_ID,
    beforeId: BEFORE_ID,
    groupId: 'Target group in my list (default: the Inbox). Ignored for subtasks.',
    parentId:
      'Creates a subtask (same org, at most 5 levels). Intents then refer to sibling subtasks.',
    tagIds: 'Existing org tags to attach.',
    tagNames: 'Tag names to attach; unknown names are created.',
    assigneeId:
      'Default: me (a subtask: its parent’s assignee). Another member gets it at the top of their Inbox; null creates it unassigned.',
    parse:
      'Run the natural-language parser on the title, in my locale and timezone: a date phrase ("tomorrow", "fri 14:00") and a trailing `>Group` token are taken out of the title.',
  }),
  'TaskCreate',
);
export const TaskPatchSchema = named(
  describe(taskPatchSchema, {
    dueDate:
      'The due unit (dueDate, dueTime, dueTz, startDate) is replaced as a whole when any of them is present; absent members become null. Null clears the due date.',
    parentId:
      'Re-parent: an ID makes it a subtask (appended to the parent’s subtasks), null makes it top-level (top of the assignee’s Inbox).',
    assigneeId:
      'An org member, or null (unassigned). A new assignee gets the task at the top of their Inbox.',
  }),
  'TaskPatch',
);
export const TaskPatchResultSchema = named(
  taskPatchResultSchema.extend({ task: TaskSchema }),
  'TaskPatchResult',
);
export const TaskMoveSchema = named(
  describe(taskMoveSchema, {
    groupId: 'One of my groups.',
    afterId: AFTER_ID,
    beforeId: BEFORE_ID,
  }),
  'TaskMove',
);
export const TaskMoveResultSchema = named(
  taskMoveResultSchema.extend({ placement: PlacementSchema }),
  'TaskMoveResult',
);
export const TaskCompleteSchema = named(taskCompleteSchema, 'TaskComplete');
export const TaskCompleteResultSchema = named(
  taskCompleteResultSchema.extend({ task: TaskSchema, next: TaskSchema.optional() }),
  'TaskCompleteResult',
);
export const BulkOpSchema = named(bulkOpSchema, 'BulkOp', {
  description:
    'One operation on up to 200 tasks: `complete`, `uncomplete`, `delete`, `restore`, `move` (`args`: a TaskMove; the tasks stay in the given order), `addTag`/`removeTag` (`args.tagId`), `setDue` (`args`: the due unit) or `assign` (`args.assigneeId`).',
});
export const BulkResultSchema = named(bulkResultSchema, 'BulkResult', {
  description:
    'One result per ID, in request order. A failed task carries the problem `code` it would have got on its own (e.g. `not_found`).',
});
export const TrashPageSchema = named(
  describe(trashPageSchema.extend({ items: z.array(TaskSchema) }), { nextCursor: NEXT_CURSOR }),
  'TrashPage',
);
export const TaskPageSchema = named(
  describe(taskPageSchema.extend({ items: z.array(TaskSchema) }), { nextCursor: NEXT_CURSOR }),
  'TaskPage',
);
export const BackupSchema = named(backupSchema, 'Backup');

// Phase 3: detail pane, subtasks and tags (06 §2.3–2.5).
export const TaskDetailSchema = named(
  taskDetailSchema.extend({
    placement: PlacementSchema.nullable(),
    subtasks: z.array(TaskSchema),
  }),
  'TaskDetail',
);
export const SubtaskReorderSchema = named(
  describe(subtaskReorderSchema, { afterId: AFTER_ID, beforeId: BEFORE_ID }),
  'SubtaskReorder',
);
export const SubtaskReorderResultSchema = named(subtaskReorderResultSchema, 'SubtaskReorderResult');
export const TaskDuplicateSchema = named(
  describe(taskDuplicateSchema, {
    id: 'Client-chosen UUIDv7 for the copy.',
    includeSubtasks: 'Copy every live subtask recursively (reopened). Default true.',
  }),
  'TaskDuplicate',
);
export const TagSchema = named(tagSchema, 'Tag');
export const TagCreateSchema = named(
  describe(tagCreateSchema, {
    name: 'Unique per org, case-insensitively.',
    color: 'Default: the next palette colour.',
  }),
  'TagCreate',
);
export const TagPatchSchema = named(tagPatchSchema, 'TagPatch');
export const TagMergeSchema = named(tagMergeSchema, 'TagMerge');

// Phase 5: search, reindex and export (06 §2.8, ADR 0012).
export const SearchHitSchema = named(
  describe(searchHitSchema.extend({ task: TaskSchema }), {
    snippet:
      'An excerpt of the best-matching field (title, description or comments) with matches wrapped in U+E000 … U+E001.',
  }),
  'SearchHit',
);
export const SearchResultSchema = named(z.array(SearchHitSchema), 'SearchResult');
export const ReindexResultSchema = named(reindexResultSchema, 'ReindexResult');
export const MailTestResultSchema = named(mailTestResultSchema, 'MailTestResult');
export const ExportCommentSchema = named(exportCommentSchema, 'ExportComment');
export const ExportTaskSchema = named(
  exportTaskSchema.extend({ placement: PlacementSchema.nullable() }),
  'ExportTask',
);
export const OrgExportSchema = named(
  orgExportSchema.extend({
    groups: z.array(GroupSchema),
    tags: z.array(TagSchema),
    tasks: z.array(ExportTaskSchema),
    comments: z.array(ExportCommentSchema),
  }),
  'OrgExport',
);

// Phase 6: collaboration (06 §2.6, ADR 0028).
export const CommentSchema = named(commentSchema, 'Comment');
export const CommentCreateSchema = named(
  describe(commentCreateSchema, {
    id: 'Client-chosen UUIDv7, so a retry or offline replay creates the comment once.',
    body: 'Markdown-light (no raw HTML). Mention a member as `@[Name](user:<id>)`.',
  }),
  'CommentCreate',
);
export const CommentPatchSchema = named(commentPatchSchema, 'CommentPatch');
export const ActivitySchema = named(activitySchema, 'Activity');
export const ActivityPageSchema = named(
  activityPageSchema.extend({
    items: z.array(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('comment'), comment: CommentSchema }),
        z.object({ kind: z.literal('activity'), activity: ActivitySchema }),
      ]),
    ),
  }),
  'ActivityPage',
);
export const FollowStateSchema = named(followStateSchema, 'FollowState');
export const NotificationSchema = named(notificationSchema, 'Notification');
export const NotificationPageSchema = named(
  notificationPageSchema.extend({ items: z.array(NotificationSchema) }),
  'NotificationPage',
);
export const NotificationMarkSchema = named(notificationMarkSchema, 'NotificationMark', {
  description: 'Either `ids` (up to 200 of my notifications) or `all: true`.',
});
export const NotificationMarkResultSchema = named(
  notificationMarkResultSchema,
  'NotificationMarkResult',
);
export const NotificationPrefsSchema = named(notificationPrefsSchema, 'NotificationPrefs');
export const NotificationPrefsPutSchema = named(notificationPrefsPutSchema, 'NotificationPrefsPut');

// Phase 7: notification delivery (06 §2.6, §2.10; ADR 0033).
export const VapidPublicKeySchema = named(vapidPublicKeySchema, 'VapidPublicKey');
export const PushSubscriptionCreateSchema = named(
  pushSubscriptionCreateSchema,
  'PushSubscriptionCreate',
);
export const PushSubscriptionSchema = named(pushSubscriptionSchema, 'PushSubscription');
