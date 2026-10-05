import {
  adminUserPatchSchema,
  adminUserSchema,
  allowlistCreateSchema,
  allowlistEntrySchema,
  inviteCreatedSchema,
  inviteCreateSchema,
  invitePreviewSchema,
  inviteSchema,
  memberPatchSchema,
  memberSchema,
  mePatchSchema,
  meSchema,
  orgCreateSchema,
  orgDeleteSchema,
  orgOrderResultSchema,
  orgOrderSchema,
  orgPatchSchema,
  orgPrefPatchSchema,
  orgSchema,
  prefsSchema,
  sessionSchema,
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
