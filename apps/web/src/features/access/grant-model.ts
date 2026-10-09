import {
  expandScopes,
  GRANT_SCOPES,
  type GrantConstraints,
  type GrantScope,
  isNarrowing,
  minimalScopes,
  type OrgGrant,
  type ReadAccess,
  type WriteAccess,
} from '@rooster/core/grants';
import type { DeviceApprove, Grant, GrantPatch, TokenCreate } from '@rooster/core/schemas';

/**
 * The constraint editor's model (11 §2–3): pure functions over the contract shapes, so the
 * editor, the `/device` page, Connected apps and (P9) the OAuth consent screen share one set
 * of rules. Values may be transiently invalid while the user edits (an empty group list);
 * `grantIssues` says what blocks saving.
 */

export interface GrantGroupOption {
  id: string;
  name: string;
  isInbox: boolean;
}

export interface GrantOrgOption {
  id: string;
  name: string;
  isPersonal: boolean;
  /** The user's groups in this org, Inbox first; undefined while loading. */
  groups?: readonly GrantGroupOption[] | undefined;
}

/** The expiry select (11 §2.4). Mirrors `EXPIRY_DAYS` in `@rooster/core/schemas` (zod-free here). */
export const EXPIRY_DAY_CHOICES = [7, 30, 90, 365] as const;
export type ExpiryChoice = (typeof EXPIRY_DAY_CHOICES)[number] | 'never' | 'keep';

export interface GrantValue {
  /** What the user ticked; implied scopes are added on display and dropped on send. */
  scopes: readonly GrantScope[];
  constraints: GrantConstraints;
  /** Days from now, `never`, or `keep` (editing an existing grant only). */
  expiry: ExpiryChoice;
}

/** What may not be widened: the requested scopes on `/device`, the current grant when narrowing. */
export interface GrantCeiling {
  scopes?: readonly GrantScope[] | undefined;
  constraints?: GrantConstraints | undefined;
}

/** Scopes whose actions are checked against the write constraint (11 §2.2). */
const WRITE_SCOPES: readonly GrantScope[] = ['tasks:write', 'comments:write', 'groups:write'];

export function hasWriteScope(scopes: Iterable<GrantScope>): boolean {
  const expanded = expandScopes(scopes);
  return WRITE_SCOPES.some((scope) => expanded.has(scope));
}

/** The scopes the editor offers: all of them, or those within the ceiling. */
export function offeredScopes(ceiling?: GrantCeiling): GrantScope[] {
  if (!ceiling?.scopes) return [...GRANT_SCOPES];
  const allowed = expandScopes(ceiling.scopes);
  return GRANT_SCOPES.filter((scope) => allowed.has(scope));
}

export type ScopeState = 'off' | 'on' | 'implied';

/** `implied`: checked because another ticked scope includes it, so it can't be unticked. */
export function scopeState(scopes: readonly GrantScope[], scope: GrantScope): ScopeState {
  const others = scopes.filter((s) => s !== scope);
  if (expandScopes(others).has(scope)) return 'implied';
  return scopes.includes(scope) ? 'on' : 'off';
}

// ---------------------------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------------------------

function orgList(constraints: GrantConstraints, orgs: readonly GrantOrgOption[]): OrgGrant[] {
  if (constraints.orgs !== 'all') return [...constraints.orgs];
  return orgs.map((org) => ({ orgId: org.id, read: 'all', write: 'all' }));
}

function mapOrg(
  value: GrantValue,
  orgs: readonly GrantOrgOption[],
  orgId: string,
  fn: (org: OrgGrant) => OrgGrant,
): GrantValue {
  const list = orgList(value.constraints, orgs).map((org) => (org.orgId === orgId ? fn(org) : org));
  return { ...value, constraints: { orgs: list } };
}

function inboxOf(org: GrantOrgOption | undefined): string | undefined {
  return org?.groups?.find((group) => group.isInbox)?.id;
}

function writesNowhere(constraints: GrantConstraints): boolean {
  return constraints.orgs !== 'all' && constraints.orgs.every((org) => org.write === 'none');
}

/**
 * Ticks or unticks a scope. Unticking keeps what it implied ticked (unticking "Delete" leaves
 * "Add and change"). The first write scope on a grant that writes nowhere starts at the
 * personal org's Inbox, the least-privilege default of 11 §3.1.
 */
export function toggleScope(
  value: GrantValue,
  scope: GrantScope,
  on: boolean,
  orgs: readonly GrantOrgOption[],
): GrantValue {
  const next = on
    ? minimalScopes([...value.scopes, scope])
    : minimalScopes([...expandScopes(value.scopes)].filter((s) => s !== scope));
  let result: GrantValue = { ...value, scopes: next };
  if (on && !hasWriteScope(value.scopes) && hasWriteScope(next)) {
    const personal = orgs.find((org) => org.isPersonal);
    const inbox = inboxOf(personal);
    const list = value.constraints.orgs;
    if (
      personal &&
      inbox &&
      list !== 'all' &&
      writesNowhere(value.constraints) &&
      list.some((org) => org.orgId === personal.id)
    ) {
      result = mapOrg(result, orgs, personal.id, (org) => ({
        ...org,
        write: { groups: [inbox] },
        read: org.read === 'all' ? 'all' : { groups: union(org.read.groups, [inbox]) },
      }));
    }
  }
  return result;
}

/** "All organisations, including ones you join later" (`orgs: "all"`) on or off. */
export function setAllOrgs(
  value: GrantValue,
  orgs: readonly GrantOrgOption[],
  on: boolean,
): GrantValue {
  if (on) return { ...value, constraints: { orgs: 'all' } };
  return { ...value, constraints: { orgs: orgList(value.constraints, orgs) } };
}

export function setOrgIncluded(
  value: GrantValue,
  orgs: readonly GrantOrgOption[],
  orgId: string,
  on: boolean,
): GrantValue {
  const list = orgList(value.constraints, orgs).filter((org) => org.orgId !== orgId);
  if (on) list.push({ orgId, read: 'all', write: 'none' });
  // Keep the user's org order (the sidebar's), not the order of ticking.
  const order = new Map(orgs.map((org, index) => [org.id, index]));
  list.sort((a, b) => (order.get(a.orgId) ?? 0) - (order.get(b.orgId) ?? 0));
  return { ...value, constraints: { orgs: list } };
}

export type ReadMode = 'all' | 'groups';
export type WriteMode = 'none' | 'all' | 'groups';

export function readMode(read: ReadAccess): ReadMode {
  return read === 'all' ? 'all' : 'groups';
}

export function writeMode(write: WriteAccess): WriteMode {
  return write === 'all' || write === 'none' ? write : 'groups';
}

/** Switching to "Only these groups" starts with the groups it may already write to. */
export function setReadMode(
  value: GrantValue,
  orgs: readonly GrantOrgOption[],
  orgId: string,
  mode: ReadMode,
): GrantValue {
  return mapOrg(value, orgs, orgId, (org) => {
    if (mode === readMode(org.read)) return org;
    if (mode === 'all') return { ...org, read: 'all' };
    const writing = org.write !== 'all' && org.write !== 'none' ? org.write.groups : [];
    return { ...org, read: { groups: [...writing] } };
  });
}

export function setWriteMode(
  value: GrantValue,
  orgs: readonly GrantOrgOption[],
  orgId: string,
  mode: WriteMode,
): GrantValue {
  return mapOrg(value, orgs, orgId, (org) => {
    if (mode === writeMode(org.write)) return org;
    if (mode !== 'groups') return { ...org, write: mode };
    return { ...org, write: { groups: [] } };
  });
}

function union(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])];
}

/**
 * Picks the groups it may read. Unpicking a group it may write to also stops the writing:
 * a grant never writes where it can't read.
 */
export function setReadGroups(
  value: GrantValue,
  orgs: readonly GrantOrgOption[],
  orgId: string,
  groups: readonly string[],
): GrantValue {
  return mapOrg(value, orgs, orgId, (org) => {
    const write =
      org.write !== 'all' && org.write !== 'none'
        ? { groups: org.write.groups.filter((g) => groups.includes(g)) }
        : org.write;
    return { ...org, read: { groups: [...groups] }, write };
  });
}

/** Picks the groups it may write to; with a limited read, they become readable too. */
export function setWriteGroups(
  value: GrantValue,
  orgs: readonly GrantOrgOption[],
  orgId: string,
  groups: readonly string[],
): GrantValue {
  return mapOrg(value, orgs, orgId, (org) => ({
    ...org,
    write: { groups: [...groups] },
    read: org.read === 'all' ? 'all' : { groups: union(org.read.groups, groups) },
  }));
}

export function setExpiry(value: GrantValue, expiry: ExpiryChoice): GrantValue {
  return { ...value, expiry };
}

// ---------------------------------------------------------------------------------------------
// Narrowing (11 §3.1)
// ---------------------------------------------------------------------------------------------

/** Whether `next` stays within the ceiling: no scope or constraint beyond it. */
export function withinCeiling(next: GrantValue, ceiling: GrantCeiling | undefined): boolean {
  if (!ceiling) return true;
  if (ceiling.scopes) {
    const allowed = expandScopes(ceiling.scopes);
    if ([...expandScopes(next.scopes)].some((scope) => !allowed.has(scope))) return false;
  }
  if (ceiling.constraints) {
    return isNarrowing(ceiling.constraints, normalizeConstraints(next));
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Validation and payloads
// ---------------------------------------------------------------------------------------------

export type GrantIssue =
  | { kind: 'noScopes' }
  | { kind: 'noOrgs' }
  | { kind: 'noReadGroups'; orgId: string }
  | { kind: 'noWriteGroups'; orgId: string };

/** What blocks saving. An empty group list is not "nothing": the contract needs at least one. */
export function grantIssues(value: GrantValue): GrantIssue[] {
  const issues: GrantIssue[] = [];
  if (value.scopes.length === 0) issues.push({ kind: 'noScopes' });
  const list = value.constraints.orgs;
  if (list === 'all') return issues;
  if (list.length === 0) issues.push({ kind: 'noOrgs' });
  const writes = hasWriteScope(value.scopes);
  for (const org of list) {
    if (org.read !== 'all' && org.read.groups.length === 0) {
      issues.push({ kind: 'noReadGroups', orgId: org.orgId });
    }
    if (writes && org.write !== 'all' && org.write !== 'none' && org.write.groups.length === 0) {
      issues.push({ kind: 'noWriteGroups', orgId: org.orgId });
    }
  }
  return issues;
}

/** A write capability with nowhere to write: allowed, but worth a warning. */
export function writesNothing(value: Pick<GrantValue, 'scopes' | 'constraints'>): boolean {
  return hasWriteScope(value.scopes) && writesNowhere(value.constraints);
}

/**
 * The constraints as sent: without a write capability, write is "none" (the value the server
 * would enforce anyway, and what the summary says); written groups are always readable.
 */
export function normalizeConstraints(
  value: Pick<GrantValue, 'scopes' | 'constraints'>,
): GrantConstraints {
  const list = value.constraints.orgs;
  if (list === 'all') return { orgs: 'all' };
  const writes = hasWriteScope(value.scopes);
  return {
    orgs: list.map((org) => {
      const write: WriteAccess = writes ? org.write : 'none';
      const read: ReadAccess =
        org.read === 'all' || write === 'all' || write === 'none'
          ? org.read
          : { groups: union(org.read.groups, write.groups) };
      return { orgId: org.orgId, read, write };
    }),
  };
}

function expiresInDays(expiry: ExpiryChoice): { expiresInDays?: number } {
  return typeof expiry === 'number' ? { expiresInDays: expiry } : {};
}

/** The contract's `{scopes, constraints, expiresInDays}`, scopes minimal (ADR 0036). */
export function toGrantInput(value: GrantValue): {
  scopes: GrantScope[];
  constraints: GrantConstraints;
  expiresInDays?: number;
} {
  return {
    scopes: minimalScopes(value.scopes),
    constraints: normalizeConstraints(value),
    ...expiresInDays(value.expiry),
  };
}

/** `POST /me/tokens`. */
export function toTokenCreate(value: GrantValue, name: string): TokenCreate {
  return { name: name.trim(), ...toGrantInput(value) } as TokenCreate;
}

/** `POST /device/:userCode/approve`. */
export function toDeviceApprove(value: GrantValue): DeviceApprove {
  return toGrantInput(value) as DeviceApprove;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** `PATCH /me/grants/:id`: `keep` leaves the expiry out. */
export function toGrantPatch(value: GrantValue, now: number, label?: string): GrantPatch {
  const patch: GrantPatch = {
    scopes: minimalScopes(value.scopes),
    constraints: normalizeConstraints(value) as GrantPatch['constraints'],
  };
  if (value.expiry === 'never') patch.expiresAt = null;
  else if (typeof value.expiry === 'number') patch.expiresAt = now + value.expiry * DAY_MS;
  if (label !== undefined) patch.label = label.trim();
  return patch;
}

// ---------------------------------------------------------------------------------------------
// Defaults (11 §3.1–3.2, 07 §2)
// ---------------------------------------------------------------------------------------------

/** New token: read only, every current org (not future ones), 90 days. */
export function defaultTokenValue(orgs: readonly GrantOrgOption[]): GrantValue {
  return {
    scopes: ['tasks:read'],
    constraints: { orgs: orgs.map((org) => ({ orgId: org.id, read: 'all', write: 'none' })) },
    expiry: 90,
  };
}

/** `/device`: what the CLI asked for, everywhere, no expiry (07 §2: the user's own terminal). */
export function defaultDeviceValue(requested: readonly GrantScope[]): GrantValue {
  return {
    scopes: minimalScopes(requested.length > 0 ? requested : ['tasks:read']),
    constraints: { orgs: 'all' },
    expiry: 'never',
  };
}

/** Editing an existing grant. */
export function valueFromGrant(grant: Pick<Grant, 'scopes' | 'constraints'>): GrantValue {
  return {
    scopes: minimalScopes(grant.scopes),
    constraints: grant.constraints as GrantConstraints,
    expiry: 'keep',
  };
}

/** Narrow-only editing for OAuth grants (11 §3.2); PATs and devices change freely. */
export function ceilingForGrant(
  grant: Pick<Grant, 'kind' | 'scopes' | 'constraints'>,
): GrantCeiling | undefined {
  if (grant.kind !== 'oauth') return undefined;
  return { scopes: grant.scopes, constraints: grant.constraints as GrantConstraints };
}

/** Normalizes a user code the way better-auth does: letters and digits, upper case. */
export function normalizeUserCode(input: string): string {
  return input.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

/** `ABCDEFGH` → `ABCD-EFGH`, as terminals print it. */
export function formatUserCode(code: string): string {
  const clean = normalizeUserCode(code);
  return clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}
