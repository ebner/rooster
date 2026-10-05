import {
  adminUserPatchSchema,
  adminUserSchema,
  allowlistCreateSchema,
  allowlistEntrySchema,
  backupSchema,
  bulkOpSchema,
  bulkResultSchema,
  exportTaskSchema,
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
  memberPatchSchema,
  memberSchema,
  mePatchSchema,
  meSchema,
  myListSchema,
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
  reindexResultSchema,
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
} from '@rooster/core/schemas';
import { named, z } from '../lib/openapi.ts';

// DTOs from @rooster/core, registered as named OpenAPI components (06 §4).
export const OrgSchema = named(orgSchema, 'Org');
export const OrgCreateSchema = named(orgCreateSchema, 'OrgCreate');
export const OrgPatchSchema = named(orgPatchSchema, 'OrgPatch');
export const OrgDeleteSchema = named(orgDeleteSchema, 'OrgDelete');
export const OrgOrderSchema = named(orgOrderSchema, 'OrgOrder');
export const OrgOrderResultSchema = named(orgOrderResultSchema, 'OrgOrderResult');
export const OrgPrefPatchSchema = named(orgPrefPatchSchema, 'OrgPrefPatch');
export const MemberSchema = named(memberSchema, 'Member');
export const MemberPatchSchema = named(memberPatchSchema, 'MemberPatch');
export const InviteSchema = named(inviteSchema, 'Invite');
export const InviteCreateSchema = named(inviteCreateSchema, 'InviteCreate');
export const InviteCreatedSchema = named(inviteCreatedSchema, 'InviteCreated');
export const InvitePreviewSchema = named(invitePreviewSchema, 'InvitePreview');
export const PrefsSchema = named(prefsSchema, 'Prefs');
// Nested DTOs are re-attached so the document references them instead of inlining.
export const MeSchema = named(
  meSchema.extend({ prefs: PrefsSchema, orgs: z.array(OrgSchema) }),
  'Me',
);
export const MePatchSchema = named(mePatchSchema, 'MePatch');
export const SessionSchema = named(sessionSchema, 'Session');
export const AllowlistEntrySchema = named(allowlistEntrySchema, 'AllowlistEntry');
export const AllowlistCreateSchema = named(allowlistCreateSchema, 'AllowlistCreate');
export const AdminUserSchema = named(adminUserSchema, 'AdminUser');
export const AdminUserPatchSchema = named(adminUserPatchSchema, 'AdminUserPatch');

// Phase 2: the list (05 §5, 06 §2.3–2.4).
export const GroupSchema = named(groupSchema, 'Group');
export const GroupCreateSchema = named(groupCreateSchema, 'GroupCreate');
export const GroupCreateResultSchema = named(
  groupCreateResultSchema.extend({ group: GroupSchema }),
  'GroupCreateResult',
);
export const GroupPatchSchema = named(groupPatchSchema, 'GroupPatch');
export const GroupMoveSchema = named(groupMoveSchema, 'GroupMove');
export const GroupMoveResultSchema = named(groupMoveResultSchema, 'GroupMoveResult');
export const GroupDeleteSchema = named(groupDeleteSchema, 'GroupDelete');
export const PlacementSchema = named(placementSchema, 'Placement');
export const TaskSchema = named(
  taskSchema.extend({ placement: PlacementSchema.nullable() }),
  'Task',
);
export const MyListSchema = named(
  myListSchema.extend({ groups: z.array(GroupSchema), tasks: z.array(TaskSchema) }),
  'MyList',
);
export const TaskCreateSchema = named(taskCreateSchema, 'TaskCreate');
export const TaskPatchSchema = named(taskPatchSchema, 'TaskPatch');
export const TaskPatchResultSchema = named(
  taskPatchResultSchema.extend({ task: TaskSchema }),
  'TaskPatchResult',
);
export const TaskMoveSchema = named(taskMoveSchema, 'TaskMove');
export const TaskMoveResultSchema = named(
  taskMoveResultSchema.extend({ placement: PlacementSchema }),
  'TaskMoveResult',
);
export const TaskCompleteSchema = named(taskCompleteSchema, 'TaskComplete');
export const TaskCompleteResultSchema = named(
  taskCompleteResultSchema.extend({ task: TaskSchema, next: TaskSchema.optional() }),
  'TaskCompleteResult',
);
export const BulkOpSchema = named(bulkOpSchema, 'BulkOp');
export const BulkResultSchema = named(bulkResultSchema, 'BulkResult');
export const TrashPageSchema = named(
  trashPageSchema.extend({ items: z.array(TaskSchema) }),
  'TrashPage',
);
export const TaskPageSchema = named(
  taskPageSchema.extend({ items: z.array(TaskSchema) }),
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
export const SubtaskReorderSchema = named(subtaskReorderSchema, 'SubtaskReorder');
export const SubtaskReorderResultSchema = named(subtaskReorderResultSchema, 'SubtaskReorderResult');
export const TaskDuplicateSchema = named(taskDuplicateSchema, 'TaskDuplicate');
export const TagSchema = named(tagSchema, 'Tag');
export const TagCreateSchema = named(tagCreateSchema, 'TagCreate');
export const TagPatchSchema = named(tagPatchSchema, 'TagPatch');
export const TagMergeSchema = named(tagMergeSchema, 'TagMerge');

// Phase 5: search, reindex and export (06 §2.8, ADR 0012).
export const SearchHitSchema = named(searchHitSchema.extend({ task: TaskSchema }), 'SearchHit');
export const SearchResultSchema = named(z.array(SearchHitSchema), 'SearchResult');
export const ReindexResultSchema = named(reindexResultSchema, 'ReindexResult');
export const ExportTaskSchema = named(
  exportTaskSchema.extend({ placement: PlacementSchema.nullable() }),
  'ExportTask',
);
export const OrgExportSchema = named(
  orgExportSchema.extend({
    groups: z.array(GroupSchema),
    tags: z.array(TagSchema),
    tasks: z.array(ExportTaskSchema),
    // Always empty in v1.0 (comments arrive in Phase 6); `never` has no OpenAPI form.
    comments: z.array(z.never()).max(0).openapi({ type: 'array', maxItems: 0, items: {} }),
  }),
  'OrgExport',
);
