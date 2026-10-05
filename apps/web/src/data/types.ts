/**
 * View-model types for Phase 1 screens. They mirror the API DTOs (05 §5, 06 §2.1,
 * §2.2, §2.10) so the query layer can return server payloads unchanged; once the
 * server's zod schemas land in `@rooster/core/schemas`, these should become
 * `z.infer` aliases.
 */
import type { DateFormat, Locale, TimeFormat } from '@rooster/core/dates';
import type { Prefs } from '@rooster/core/schemas';
import type { TagColor } from '@rooster/tokens';

export type OrgRole = 'owner' | 'member';
export type WeekStart = 0 | 1;

/** `GET /meta` → `providers[]`. */
export interface AuthProvider {
  id: string;
  name: string;
}

export interface UserSettings {
  locale: Locale;
  /** IANA zone, e.g. `Europe/Stockholm`. */
  timezone: string;
  /** 0 = Sunday, 1 = Monday. */
  weekStart: WeekStart;
  dateFormat: DateFormat;
  timeFormat: TimeFormat;
}

export interface CurrentUser extends UserSettings {
  id: string;
  name: string;
  email: string;
  image: string | null;
  isAdmin: boolean;
}

/** OrgDTO (05 §5) without the fractional `position`: the array order is the sidebar order. */
export interface Org {
  id: string;
  slug: string;
  name: string;
  isPersonal: boolean;
  avatarEmoji: string | null;
  color: TagColor | null;
  role: OrgRole;
  /** Sidebar section collapsed (`org_member_pref.collapsed`). */
  collapsed: boolean;
}

/** `GET /me`. */
export interface Me {
  user: CurrentUser;
  /** In the user's sidebar order. */
  orgs: Org[];
  /** `user.prefs` with defaults applied (05 §2); absent in older fixtures. */
  prefs?: Prefs;
}

export type ProfilePatch = Partial<UserSettings & { name: string }>;

/** `PUT /me/org-order` (06 §1 ordering intents). */
export interface OrgReorderIntent {
  orgId: string;
  /** The org directly below the moved one after the move (null: it is last). */
  beforeId: string | null;
  /** The org directly above the moved one after the move (null: it is first). */
  afterId: string | null;
}

export interface CreateOrgInput {
  name: string;
  avatarEmoji: string | null;
  color: TagColor | null;
}

export interface OrgPatch {
  name?: string;
  avatarEmoji?: string | null;
  color?: TagColor | null;
}

export interface OrgMember {
  userId: string;
  name: string;
  email: string;
  image: string | null;
  role: OrgRole;
}

export type InviteKind = 'email' | 'link';

export interface OrgInvite {
  id: string;
  kind: InviteKind;
  /** Email invites only. */
  email: string | null;
  role: OrgRole;
  /** Link invites only. */
  multiUse: boolean;
  uses: number;
  /**
   * The shareable URL. Null when the server cannot reproduce it (link tokens are
   * stored hashed, so only the create response may carry it).
   */
  url: string | null;
  expiresAt: number;
  createdAt: number;
}

export type CreateInviteInput =
  | { orgId: string; kind: 'email'; email: string; role: OrgRole; expiresInDays: number }
  | { orgId: string; kind: 'link'; role: OrgRole; multiUse: boolean; expiresInDays: number };

/** `POST /orgs/:orgId/invites` response. */
export interface CreatedInvite {
  id: string;
  kind: InviteKind;
  url: string;
}

export type InviteStatus = 'valid' | 'expired' | 'revoked' | 'used' | 'notFound';

/** `GET /invites/:token` (no auth). */
export interface InvitePreview {
  status: InviteStatus;
  org: {
    id: string;
    slug: string;
    name: string;
    avatarEmoji: string | null;
    color: TagColor | null;
  } | null;
  inviterName: string | null;
  role: OrgRole | null;
  expiresAt: number | null;
}

/** `GET /me/sessions`. */
export interface UserSession {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: number;
  /** better-auth `session.updatedAt`: refreshed by sliding renewal. */
  lastActiveAt: number;
  isCurrent: boolean;
}

export type AllowlistKind = 'email' | 'domain';

export interface AllowlistEntry {
  id: string;
  kind: AllowlistKind;
  value: string;
  createdAt: number;
}

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
  createdAt: number;
  disabledAt: number | null;
  isAdmin: boolean;
}

/**
 * The slice of TanStack Query's `UseQueryResult` that screens rely on (components
 * and tests can supply plain values).
 */
export interface QueryResult<T> {
  data: T | undefined;
  isPending: boolean;
  error: Error | null;
}

/** The slice of `UseMutationResult` that screens rely on. */
export interface MutationResult<TVariables, TData = void> {
  mutateAsync: (variables: TVariables) => Promise<TData>;
  isPending: boolean;
}
