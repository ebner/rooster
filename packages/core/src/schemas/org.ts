import { z } from 'zod';
import { timestampSchema } from './common.ts';
import { nameSchema } from './text.ts';

/** `organization.slug` pattern (05 §2): lowercase, digits and dashes, 2–39 characters. */
export const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,38}$/;
export const SLUG_MAX_LENGTH = 39;

/** Resolves to the caller's personal org wherever an org ID or slug is accepted (05 §2). */
export const PERSONAL_ORG_ALIAS = 'personal';
/** Slugs no org may take. */
export const RESERVED_SLUGS: readonly string[] = [PERSONAL_ORG_ALIAS];

// A slug shaped like a UUID would be ambiguous where an org ID or slug is accepted.
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isValidSlug(value: string): boolean {
  return SLUG_REGEX.test(value) && !UUID_SHAPE.test(value);
}

export function isReservedSlug(value: string): boolean {
  return RESERVED_SLUGS.includes(value);
}

/**
 * Derives a slug from an org name: Latin diacritics are folded (å → a, ö → o), every run of
 * other characters becomes one dash, and the result is cut to 39 characters. Returns `null`
 * when nothing usable remains (for example an emoji-only name).
 */
export function slugify(name: string): string | null {
  const folded = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[æÆ]/g, 'ae')
    .replace(/[øØ]/g, 'o')
    .toLowerCase();
  const slug = folded
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/, '');
  return isValidSlug(slug) ? slug : null;
}

/**
 * The `n`-th candidate for a unique slug: `base` itself first, then `base-2`, `base-3`, …,
 * shortening `base` so the result stays within 39 characters.
 */
export function slugCandidate(base: string, n: number): string {
  if (n <= 1) return base;
  const suffix = `-${n}`;
  return `${base.slice(0, SLUG_MAX_LENGTH - suffix.length).replace(/-+$/, '')}${suffix}`;
}

/** Tag palette names (03 §2.4); also used for org avatar colours. */
export const TAG_COLORS = [
  'gray',
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'blue',
  'indigo',
  'purple',
  'pink',
] as const;
export const tagColorSchema = z.enum(TAG_COLORS);

export const ORG_ROLES = ['owner', 'member'] as const;
export const orgRoleSchema = z.enum(ORG_ROLES);

export const slugSchema = z
  .string()
  .refine(isValidSlug, { error: 'Expected 2–39 lowercase letters, digits or dashes' })
  .refine((s) => !isReservedSlug(s), { error: 'This slug is reserved' });

/** One emoji (possibly a multi-codepoint sequence). */
export const avatarEmojiSchema = z.string().trim().min(1).max(16);

export const orgNameSchema = nameSchema(80);

/** OrgDTO (05 §5): an org as seen by one member. */
export const orgSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  isPersonal: z.boolean(),
  avatarEmoji: z.string().nullable(),
  color: tagColorSchema.nullable(),
  role: orgRoleSchema,
  /** Fractional key of the org in the member's sidebar. */
  position: z.string(),
  collapsed: z.boolean(),
});

export const orgCreateSchema = z.object({
  name: orgNameSchema,
  slug: slugSchema.optional(),
  avatarEmoji: avatarEmojiSchema.nullable().optional(),
  color: tagColorSchema.nullable().optional(),
});

export const orgPatchSchema = z.object({
  name: orgNameSchema.optional(),
  slug: slugSchema.optional(),
  avatarEmoji: avatarEmojiSchema.nullable().optional(),
  color: tagColorSchema.nullable().optional(),
});

export const orgDeleteSchema = z.object({
  /** Must equal the org's name exactly (FR-ORG-4). */
  confirmName: z.string(),
});

/** PUT /me/org-order: an ordering intent in the member's sidebar (06 §1). */
export const orgOrderSchema = z.object({
  orgId: z.string(),
  /** The org that will be directly below. */
  beforeId: z.string().nullable().optional(),
  /** The org that will be directly above. */
  afterId: z.string().nullable().optional(),
});

export const orgOrderResultSchema = z.object({
  orgId: z.string(),
  position: z.string(),
});

export const orgPrefPatchSchema = z.object({
  collapsed: z.boolean(),
});

export const memberSchema = z.object({
  userId: z.string(),
  name: z.string(),
  /**
   * Browser sessions only: apps and tokens with a grant see names, never colleagues' emails
   * (11 §2.1). They assign by email through `GET /orgs/:orgId/members/resolve`.
   */
  email: z.string().optional(),
  image: z.string().nullable(),
  role: orgRoleSchema,
  joinedAt: timestampSchema,
});

/** `GET /orgs/:orgId/members/resolve`: the one member a query names. Never carries an email. */
export const resolvedMemberSchema = z.object({
  userId: z.string(),
  name: z.string(),
});

export const memberPatchSchema = z.object({
  role: orgRoleSchema,
});

export const INVITE_KINDS = ['email', 'link'] as const;
export const inviteKindSchema = z.enum(INVITE_KINDS);

export const INVITE_DEFAULT_EXPIRY_DAYS = 7;
const expiresInDaysSchema = z.int().min(1).max(90);

/**
 * POST /orgs/:orgId/invites. With `email`: an email invite (`multiUse` is not allowed).
 * Without: a link invite, single-use unless `multiUse`.
 */
export const inviteCreateSchema = z.object({
  email: z.email().max(254).optional(),
  role: orgRoleSchema.default('member'),
  multiUse: z.boolean().optional(),
  expiresInDays: expiresInDaysSchema.optional(),
});

export const inviteCreatedSchema = z.object({
  id: z.string(),
  kind: inviteKindSchema,
  /** `${BASE_URL}/invite/<token>`. Link tokens are stored hashed, so this is shown once. */
  url: z.string(),
  expiresAt: timestampSchema,
  /** P7: true when an invite email went out (SMTP configured); otherwise copy `url`. */
  emailed: z.boolean().optional(),
});

/** An open invite, as listed in org settings. */
export const inviteSchema = z.object({
  id: z.string(),
  kind: inviteKindSchema,
  email: z.string().nullable(),
  role: orgRoleSchema,
  multiUse: z.boolean(),
  uses: z.int().nonnegative(),
  createdAt: timestampSchema,
  expiresAt: timestampSchema,
  /** Email invites can be copied again; link invite URLs are shown only once. */
  url: z.string().nullable(),
});

export const INVITE_INVALID_REASONS = ['expired', 'revoked', 'used', 'org_deleted'] as const;

/** GET /invites/:token (public). */
export const invitePreviewSchema = z.object({
  kind: inviteKindSchema,
  /** Lets the invitee's client open the org right after joining. */
  orgSlug: z.string(),
  orgName: z.string(),
  orgAvatarEmoji: z.string().nullable(),
  orgColor: tagColorSchema.nullable(),
  inviterName: z.string().nullable(),
  role: orgRoleSchema,
  /** Email invites only: who the invite is for. */
  email: z.string().nullable(),
  expiresAt: timestampSchema,
  valid: z.boolean(),
  reason: z.enum(INVITE_INVALID_REASONS).nullable(),
});

export type Org = z.infer<typeof orgSchema>;
export type OrgRole = z.infer<typeof orgRoleSchema>;
export type TagColor = z.infer<typeof tagColorSchema>;
export type OrgCreate = z.infer<typeof orgCreateSchema>;
export type OrgPatch = z.infer<typeof orgPatchSchema>;
export type OrgOrder = z.infer<typeof orgOrderSchema>;
export type OrgOrderResult = z.infer<typeof orgOrderResultSchema>;
export type OrgPrefPatch = z.infer<typeof orgPrefPatchSchema>;
export type Member = z.infer<typeof memberSchema>;
export type ResolvedMember = z.infer<typeof resolvedMemberSchema>;
export type InviteKind = z.infer<typeof inviteKindSchema>;
export type InviteCreate = z.infer<typeof inviteCreateSchema>;
export type InviteCreated = z.infer<typeof inviteCreatedSchema>;
export type Invite = z.infer<typeof inviteSchema>;
export type InvitePreview = z.infer<typeof invitePreviewSchema>;
export type InviteInvalidReason = (typeof INVITE_INVALID_REASONS)[number];
