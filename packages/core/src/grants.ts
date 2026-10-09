/**
 * The grant model (docs/spec/11-agent-access.md §2): what a PAT, CLI device or OAuth client may
 * do. Capabilities are OAuth-style scopes; constraints are the orgs and groups the user chose.
 * Pure and zod-free: the server enforces with it, the web previews it, the CLI explains it.
 */

/** The capabilities any user may grant (11 §2.1). The CLI's default login requests these. */
export const GRANT_SCOPES = [
  'tasks:read',
  'tasks:write',
  'comments:write',
  'tasks:assign',
  'groups:write',
  'tasks:delete',
  'notifications:read',
] as const;

/**
 * The admin routes (11 §2.1, ADR 0041). Only instance admins may grant it, only to PATs and CLI
 * logins, and it is checked against the user's current admin role on every request.
 */
export const ADMIN_SCOPE = 'admin';

/** Every scope a grant may hold: `GRANT_SCOPES` plus `admin`. */
export const ALL_GRANT_SCOPES = [...GRANT_SCOPES, ADMIN_SCOPE] as const;
export type GrantScope = (typeof ALL_GRANT_SCOPES)[number];

/** Scopes an OAuth or MCP client can never request or be granted (ADR 0041). */
export const OAUTH_EXCLUDED_SCOPES: readonly GrantScope[] = [ADMIN_SCOPE];

/** 11 §2.1: what each scope implies (transitively expanded by `expandScopes`). */
const IMPLIES: Readonly<Record<GrantScope, readonly GrantScope[]>> = {
  'tasks:read': [],
  'tasks:write': ['tasks:read'],
  'comments:write': ['tasks:read'],
  'tasks:assign': ['tasks:write'],
  'groups:write': ['tasks:read'],
  'tasks:delete': ['tasks:write'],
  'notifications:read': [],
  admin: [],
};

export function isGrantScope(value: string): value is GrantScope {
  return (ALL_GRANT_SCOPES as readonly string[]).includes(value);
}

/** The scopes plus everything they imply. */
export function expandScopes(scopes: Iterable<GrantScope>): Set<GrantScope> {
  const out = new Set<GrantScope>();
  const visit = (scope: GrantScope) => {
    if (out.has(scope)) return;
    out.add(scope);
    for (const implied of IMPLIES[scope]) visit(implied);
  };
  for (const scope of scopes) visit(scope);
  return out;
}

export function hasScope(granted: Iterable<GrantScope>, required: GrantScope): boolean {
  return expandScopes(granted).has(required);
}

/** The smallest set with the same meaning (drops implied scopes), in `ALL_GRANT_SCOPES` order. */
export function minimalScopes(scopes: Iterable<GrantScope>): GrantScope[] {
  const list = [...new Set(scopes)];
  const impliedByOthers = (scope: GrantScope) =>
    list.some((other) => other !== scope && expandScopes([other]).has(scope));
  return ALL_GRANT_SCOPES.filter((scope) => list.includes(scope) && !impliedByOthers(scope));
}

export type ReadAccess = 'all' | { groups: readonly string[] };
export type WriteAccess = 'none' | 'all' | { groups: readonly string[] };

export interface OrgGrant {
  orgId: string;
  read: ReadAccess;
  write: WriteAccess;
}

/** 11 §2.2. `"all"` includes orgs and groups created later; a list does not. */
export interface GrantConstraints {
  orgs: 'all' | readonly OrgGrant[];
}

export const UNCONSTRAINED: GrantConstraints = { orgs: 'all' };

function orgGrant(constraints: GrantConstraints, orgId: string): OrgGrant | null {
  if (constraints.orgs === 'all') return { orgId, read: 'all', write: 'all' };
  return constraints.orgs.find((o) => o.orgId === orgId) ?? null;
}

/** Whether the grant reaches the org at all (else everything in it is `404`). */
export function grantsOrg(constraints: GrantConstraints, orgId: string): boolean {
  return orgGrant(constraints, orgId) !== null;
}

/**
 * Whether a task may be read. `groupId` is where the task shows in the grant user's My tasks:
 * its own placement, else its nearest placed ancestor's (ADR 0037), or null when neither is in
 * their list (someone else's, unassigned, Everyone's tasks): those need the whole org.
 */
export function canRead(
  constraints: GrantConstraints,
  orgId: string,
  groupId: string | null,
): boolean {
  const org = orgGrant(constraints, orgId);
  if (org === null) return false;
  if (org.read === 'all') return true;
  return groupId !== null && org.read.groups.includes(groupId);
}

/** Whether a task in `groupId` (same meaning as `canRead`) may be written. */
export function canWrite(
  constraints: GrantConstraints,
  orgId: string,
  groupId: string | null,
): boolean {
  const org = orgGrant(constraints, orgId);
  if (org === null || org.write === 'none') return false;
  if (org.write === 'all') return true;
  return groupId !== null && org.write.groups.includes(groupId);
}

/** Org-wide writes (groups, tags, tasks outside the user's list) need `write: "all"`. */
export function canWriteOrg(constraints: GrantConstraints, orgId: string): boolean {
  return orgGrant(constraints, orgId)?.write === 'all';
}

/**
 * Narrowing only (11 §3.1, PATCH of an OAuth grant): every access `next` gives, `current`
 * already gave. Group lists are compared as sets; `"all"` covers any list.
 */
export function isNarrowing(current: GrantConstraints, next: GrantConstraints): boolean {
  if (next.orgs === 'all') return current.orgs === 'all';
  return next.orgs.every((n) => {
    const c = orgGrant(current, n.orgId);
    if (c === null) return false;
    const readOk =
      c.read === 'all' ||
      (n.read !== 'all' &&
        n.read.groups.every((g) => c.read !== 'all' && c.read.groups.includes(g)));
    const writeOk =
      n.write === 'none' ||
      c.write === 'all' ||
      (n.write !== 'all' &&
        c.write !== 'none' &&
        n.write.groups.every(
          (g) => c.write !== 'none' && c.write !== 'all' && c.write.groups.includes(g),
        ));
    return readOk && writeOk;
  });
}
