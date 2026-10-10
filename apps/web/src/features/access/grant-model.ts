import {
  ADMIN_SCOPE,
  ALL_GRANT_SCOPES,
  expandScopes,
  GRANT_SCOPES,
  type GrantConstraints,
  type GrantScope,
  isNarrowing,
  minimalScopes,
  OAUTH_EXCLUDED_SCOPES,
  type OrgGrant,
  type ReadAccess,
  type WriteAccess,
} from '@rooster/core/grants';
import type {
  DeviceApprove,
  DeviceRequest,
  Grant,
  GrantPatch,
  OAuthConsentDecision,
  OAuthConsentRequest,
  TokenCreate,
} from '@rooster/core/schemas';

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
/**
 * `session`: "This session only", the idle timeout of an OAuth grant (11 §2.4, ADR 0041),
 * offered on the consent screen only.
 */
export type ExpiryChoice = (typeof EXPIRY_DAY_CHOICES)[number] | 'never' | 'keep' | 'session';

export interface GrantValue {
  /** What the user ticked; implied scopes are added on display and dropped on send. */
  scopes: readonly GrantScope[];
  constraints: GrantConstraints;
  /** Days from now, `never`, `keep` (editing an existing grant only) or `session` (consent). */
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

/**
 * The scopes the editor offers: all of them, or those within the ceiling. `admin` only with
 * `admin: true`, which callers set for instance admins only (ADR 0041/0042).
 */
export function offeredScopes(
  ceiling?: GrantCeiling,
  options: { admin?: boolean | undefined } = {},
): GrantScope[] {
  const base: readonly GrantScope[] = options.admin ? ALL_GRANT_SCOPES : GRANT_SCOPES;
  if (!ceiling?.scopes) return [...base];
  const allowed = expandScopes(ceiling.scopes);
  return base.filter((scope) => allowed.has(scope));
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
  let result: GrantValue = withWriteImpliesRead({ ...value, scopes: next });
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

/**
 * Writing everywhere in an org implies reading everywhere in it: a credential that may create a
 * task must be able to read it back (else it creates, then gets 404 editing it). Applied after
 * every edit while the grant has a write scope.
 */
export function withWriteImpliesRead(value: GrantValue): GrantValue {
  const list = value.constraints.orgs;
  if (list === 'all' || !hasWriteScope(value.scopes)) return value;
  if (!list.some((org) => org.write === 'all' && org.read !== 'all')) return value;
  return {
    ...value,
    constraints: {
      orgs: list.map((org) => (org.write === 'all' ? { ...org, read: 'all' as const } : org)),
    },
  };
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
  return withWriteImpliesRead(
    mapOrg(value, orgs, orgId, (org) => {
      if (mode === readMode(org.read)) return org;
      if (mode === 'all') return { ...org, read: 'all' };
      const writing = org.write !== 'all' && org.write !== 'none' ? org.write.groups : [];
      return { ...org, read: { groups: [...writing] } };
    }),
  );
}

export function setWriteMode(
  value: GrantValue,
  orgs: readonly GrantOrgOption[],
  orgId: string,
  mode: WriteMode,
): GrantValue {
  return withWriteImpliesRead(
    mapOrg(value, orgs, orgId, (org) => {
      if (mode === writeMode(org.write)) return org;
      if (mode !== 'groups') return { ...org, write: mode };
      return { ...org, write: { groups: [] } };
    }),
  );
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
        org.read === 'all' || write === 'all'
          ? 'all'
          : write === 'none'
            ? org.read
            : { groups: union(org.read.groups, write.groups) };
      return { orgId: org.orgId, read, write };
    }),
  };
}

function expiresInDays(expiry: ExpiryChoice): { expiresInDays?: number } {
  // `never`, `keep` and `session` send no day count.
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

/**
 * `POST /device/:userCode/approve`, with the request's `decisionNonce` unchanged: it binds the
 * approval to the session the request was shown to.
 */
export function toDeviceApprove(
  value: GrantValue,
  request: Pick<DeviceRequest, 'decisionNonce'>,
): DeviceApprove {
  return { decisionNonce: request.decisionNonce, ...toGrantInput(value) } as DeviceApprove;
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

/**
 * `/device`: what the CLI asked for, everywhere, no expiry (07 §2: the user's own terminal).
 * "Delete" starts as requested (ADR 0042 §4: asked for explicitly in the terminal). `admin`
 * only for instance admins; for anyone else the server drops it, so the page never shows it.
 */
export function defaultDeviceValue(
  requested: readonly GrantScope[],
  options: { isAdmin?: boolean | undefined } = {},
): GrantValue {
  const scopes = deviceScopes(requested, options);
  return {
    scopes: minimalScopes(scopes.length > 0 ? scopes : ['tasks:read']),
    constraints: { orgs: 'all' },
    expiry: 'never',
  };
}

/** The scopes the `/device` page may offer: the request, without `admin` for non-admins. */
export function deviceScopes(
  requested: readonly GrantScope[],
  options: { isAdmin?: boolean | undefined } = {},
): GrantScope[] {
  return requested.filter((scope) => scope !== ADMIN_SCOPE || options.isAdmin === true);
}

// ---------------------------------------------------------------------------------------------
// OAuth consent (11 §3.1, ADR 0041/0042)
// ---------------------------------------------------------------------------------------------

/** The OAuth default expiry (11 §2.4: 90 days for OAuth clients). */
export const OAUTH_DEFAULT_EXPIRY = 90 satisfies ExpiryChoice;

/**
 * What the consent screen may offer: the requested scopes, never `admin` (ADR 0041), which
 * the server already leaves out; filtered here too so a server slip can't put it on screen.
 */
export function consentScopes(request: Pick<OAuthConsentRequest, 'requestedScopes'>): GrantScope[] {
  return request.requestedScopes.filter((scope) => !OAUTH_EXCLUDED_SCOPES.includes(scope));
}

/**
 * On step-up, what the existing grant already allows. The server merges a step-up into the
 * grant (ADR 0045 §5), so these can't be taken away here: the screen shows them checked and
 * fixed, and narrowing happens in Settings → Connected apps.
 */
export function retainedScopes(request: Pick<OAuthConsentRequest, 'existing'>): GrantScope[] {
  return (request.existing?.scopes ?? []).filter((scope) => !OAUTH_EXCLUDED_SCOPES.includes(scope));
}

/** Whether `scopes` still include everything `fixed` allows (implied scopes count). */
export function keepsScopes(scopes: readonly GrantScope[], fixed: readonly GrantScope[]): boolean {
  const kept = expandScopes(scopes);
  return [...expandScopes(fixed)].every((scope) => kept.has(scope));
}

/**
 * The ceiling of the consent editor: the requested scopes plus what a step-up's grant already
 * has, and the client's `authorization_details`, which pre-fill the screen and may only be
 * narrowed (11 §2.2).
 */
export function consentCeiling(
  request: Pick<OAuthConsentRequest, 'requestedScopes' | 'prefill' | 'existing'>,
): GrantCeiling {
  return {
    scopes: minimalScopes([...consentScopes(request), ...retainedScopes(request)]),
    ...(request.prefill ? { constraints: request.prefill as GrantConstraints } : {}),
  };
}

/**
 * The consent screen's starting point, least privilege first (11 §3.1):
 * - Scopes: what the client asked for, but "Allow deleting tasks" unticked (ADR 0041/0042),
 *   plus on step-up everything the grant already has (`retainedScopes`, delete included).
 * - Where: `prefill` (the client's `authorization_details`), else the existing grant on
 *   step-up, else every current org (never `"all"`): read everything, write nothing, or the
 *   personal org's Inbox only when the client may write.
 * - Expiry: "This session only" again on a step-up of such a grant, else 90 days.
 *
 * `orgs` must have the personal org's groups loaded, or the write default stays "nothing".
 */
export function defaultConsentValue(
  request: Pick<OAuthConsentRequest, 'requestedScopes' | 'prefill' | 'existing'>,
  orgs: readonly GrantOrgOption[],
): GrantValue {
  const requested = consentScopes(request);
  const retained = retainedScopes(request);
  const asked = [...expandScopes(requested)].filter((scope) => scope !== 'tasks:delete');
  const expanded = [...asked, ...retained];
  const scopes = minimalScopes(expanded.length > 0 ? expanded : ['tasks:read']);
  const expiry: ExpiryChoice = request.existing?.idleTimeoutMs ? 'session' : OAUTH_DEFAULT_EXPIRY;
  const existing = request.existing?.constraints as GrantConstraints | undefined;
  const prefill = request.prefill as GrantConstraints | null;

  if (prefill) {
    // Step-up within what the client pre-filled keeps the user's earlier narrowing.
    const start = existing && isNarrowing(prefill, existing) ? existing : prefill;
    return withWriteImpliesRead({ scopes, constraints: start, expiry });
  }
  if (existing) return withWriteImpliesRead({ scopes, constraints: existing, expiry });

  const personal = orgs.find((org) => org.isPersonal);
  const inbox = inboxOf(personal);
  const writes = hasWriteScope(scopes);
  return {
    scopes,
    constraints: {
      orgs: orgs.map((org) => ({
        orgId: org.id,
        read: 'all',
        write: writes && org.id === personal?.id && inbox ? { groups: [inbox] } : 'none',
      })),
    },
    expiry,
  };
}

/**
 * `defaultConsentValue`, without what no longer exists for the user: on step-up the grant may
 * name orgs left or groups deleted since, which the server would refuse (`422`). `stale` says
 * what was dropped, for the note.
 */
export function consentStart(
  request: Pick<OAuthConsentRequest, 'requestedScopes' | 'prefill' | 'existing'>,
  orgs: readonly GrantOrgOption[],
): { value: GrantValue; stale: StaleIds } {
  return reconcileGrant(defaultConsentValue(request, orgs), orgs);
}

/** `POST /oauth/consent` with Allow. */
export function toConsentDecision(
  value: GrantValue,
  request: Pick<OAuthConsentRequest, 'oauthQuery' | 'decisionNonce'>,
): OAuthConsentDecision {
  const { scopes, constraints, expiresInDays: days } = toGrantInput(value);
  return {
    accept: true,
    oauthQuery: request.oauthQuery,
    // Unchanged: it binds the decision to the session the request was shown to.
    decisionNonce: request.decisionNonce,
    scopes,
    constraints,
    ...(value.expiry === 'session' ? { sessionOnly: true } : days ? { expiresInDays: days } : {}),
  } as OAuthConsentDecision;
}

/** Editing an existing grant. */
export function valueFromGrant(grant: Pick<Grant, 'scopes' | 'constraints'>): GrantValue {
  return withWriteImpliesRead({
    scopes: minimalScopes(grant.scopes),
    constraints: grant.constraints as GrantConstraints,
    expiry: 'keep',
  });
}

export interface StaleIds {
  /** Orgs the user has left. */
  orgs: number;
  /** Groups deleted since the grant was made. */
  groups: number;
}

/**
 * Drops what the grant names but no longer exists for the user (orgs left, groups deleted),
 * which the server would refuse (`422`) on any save, even a rename. Orgs are only judged once
 * known (non-empty), and an org's groups once loaded. An org whose readable groups are all
 * gone reached nothing and leaves the grant; a write list that empties becomes "none".
 * Returns the same `value` when nothing is stale.
 */
export function reconcileGrant(
  value: GrantValue,
  orgs: readonly GrantOrgOption[],
): { value: GrantValue; stale: StaleIds } {
  const stale: StaleIds = { orgs: 0, groups: 0 };
  const list = value.constraints.orgs;
  if (list === 'all' || orgs.length === 0) return { value, stale };
  const next: OrgGrant[] = [];
  let changed = false;
  for (const grant of list) {
    const org = orgs.find((o) => o.id === grant.orgId);
    if (!org) {
      stale.orgs += 1;
      changed = true;
      continue;
    }
    if (!org.groups) {
      next.push(grant);
      continue;
    }
    const known = new Set(org.groups.map((g) => g.id));
    const gone = new Set<string>();
    const keep = (ids: readonly string[]) =>
      ids.filter((id) => {
        if (known.has(id)) return true;
        gone.add(id);
        return false;
      });
    const read: ReadAccess = grant.read === 'all' ? 'all' : { groups: keep(grant.read.groups) };
    const writeGroups =
      grant.write === 'all' || grant.write === 'none' ? null : keep(grant.write.groups);
    if (gone.size === 0) {
      next.push(grant);
      continue;
    }
    stale.groups += gone.size;
    changed = true;
    if (read !== 'all' && read.groups.length === 0) continue;
    const write: WriteAccess =
      writeGroups === null
        ? (grant.write as 'all' | 'none')
        : writeGroups.length === 0
          ? 'none'
          : { groups: writeGroups };
    next.push({ orgId: grant.orgId, read, write });
  }
  return changed ? { value: { ...value, constraints: { orgs: next } }, stale } : { value, stale };
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
