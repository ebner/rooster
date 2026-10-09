import {
  expandScopes,
  GRANT_SCOPES,
  type GrantConstraints,
  type GrantScope,
} from '@rooster/core/grants';
import type { TFunction } from 'i18next';
import { type GrantOrgOption, hasWriteScope, normalizeConstraints } from './grant-model';

/** The i18n key fragment of each scope. */
export const scopeKeys = {
  'tasks:read': 'tasksRead',
  'tasks:write': 'tasksWrite',
  'comments:write': 'commentsWrite',
  'tasks:assign': 'tasksAssign',
  'groups:write': 'groupsWrite',
  'tasks:delete': 'tasksDelete',
  'notifications:read': 'notificationsRead',
} as const satisfies Record<GrantScope, string>;

function listOf(items: readonly string[], locale: string): string {
  return new Intl.ListFormat(locale, { type: 'conjunction' }).format(items);
}

/**
 * "Add and change tasks, comment and read notifications": every scope the grant has, in plain
 * words, leaving out "see tasks" when another scope already includes it.
 */
export function describeScopes(
  scopes: readonly GrantScope[],
  t: TFunction<'settings'>,
  locale: string,
): string {
  const expanded = expandScopes(scopes);
  const seeImplied = [...expanded].some(
    (scope) => scope !== 'tasks:read' && expandScopes([scope]).has('tasks:read'),
  );
  const labels = GRANT_SCOPES.filter(
    (scope) => expanded.has(scope) && !(scope === 'tasks:read' && seeImplied),
  ).map((scope) => t(`access.scope.${scopeKeys[scope]}.short`));
  const sentence = listOf(labels, locale);
  return sentence.charAt(0).toLocaleUpperCase(locale) + sentence.slice(1);
}

function orgName(orgs: readonly GrantOrgOption[], id: string, t: TFunction<'settings'>): string {
  return orgs.find((org) => org.id === id)?.name ?? t('access.summary.unknownOrg');
}

function groupName(
  org: GrantOrgOption | undefined,
  id: string,
  t: TFunction<'settings'>,
): string | undefined {
  const groups = org?.groups;
  if (!groups) return undefined;
  const group = groups.find((g) => g.id === id);
  if (!group) return t('access.summary.removedGroup');
  return group.isInbox ? t('access.inbox') : group.name;
}

/** "Acme › Prio", or "2 groups in Acme" while the groups are still loading. */
function groupPhrases(
  orgs: readonly GrantOrgOption[],
  orgId: string,
  ids: readonly string[],
  t: TFunction<'settings'>,
): string[] {
  const org = orgs.find((o) => o.id === orgId);
  const name = orgName(orgs, orgId, t);
  const names = ids.map((id) => groupName(org, id, t));
  if (names.some((n) => n === undefined)) {
    return [t('access.summary.groupsIn', { count: ids.length, org: name })];
  }
  return names.map((group) => t('access.summary.groupPath', { org: name, group }));
}

/**
 * The live summary sentence (11 §3.1): "Can read everything in Personal and Acme; can add and
 * change tasks only in Acme › Prio."
 */
export function describeWhere(
  value: { scopes: readonly GrantScope[]; constraints: GrantConstraints },
  orgs: readonly GrantOrgOption[],
  t: TFunction<'settings'>,
  locale: string,
): string {
  const constraints = normalizeConstraints(value);
  const writes = hasWriteScope(value.scopes);
  const verb = expandScopes(value.scopes).has('tasks:write')
    ? t('access.summary.verbTasks')
    : t('access.summary.verbChanges');
  if (constraints.orgs === 'all') {
    return writes ? t('access.summary.allOrgsWrite', { verb }) : t('access.summary.allOrgsRead');
  }
  const list = constraints.orgs;
  if (list.length === 0) return t('access.summary.nothing');

  const readAll = list
    .filter((org) => org.read === 'all')
    .map((org) => orgName(orgs, org.orgId, t));
  const readGroups = list.flatMap((org) =>
    org.read === 'all' ? [] : groupPhrases(orgs, org.orgId, org.read.groups, t),
  );
  const readParts = [
    ...(readAll.length > 0
      ? [t('access.summary.everythingIn', { orgs: listOf(readAll, locale) })]
      : []),
    ...(readGroups.length > 0
      ? [t('access.summary.only', { groups: listOf(readGroups, locale) })]
      : []),
  ];
  const read = t('access.summary.read', { parts: listOf(readParts, locale) });

  const writeAll = list
    .filter((org) => org.write === 'all')
    .map((org) => orgName(orgs, org.orgId, t));
  const writeGroups = list.flatMap((org) =>
    org.write === 'all' || org.write === 'none'
      ? []
      : groupPhrases(orgs, org.orgId, org.write.groups, t),
  );
  if (!writes || (writeAll.length === 0 && writeGroups.length === 0)) {
    return t('access.summary.readOnly', { read });
  }
  const writeParts = [
    ...(writeAll.length > 0
      ? [t('access.summary.anywhereIn', { orgs: listOf(writeAll, locale) })]
      : []),
    ...(writeGroups.length > 0
      ? [t('access.summary.onlyIn', { groups: listOf(writeGroups, locale) })]
      : []),
  ];
  return t('access.summary.readWrite', { read, verb, parts: listOf(writeParts, locale) });
}

/** "Oct 9", or "Jan 7, 2027" outside this year, in the viewer's zone: grant dates mid-sentence. */
export function formatGrantDate(
  instant: number,
  prefs: { locale: string; timezone: string },
  now: number,
): string {
  const year = (ms: number) =>
    new Intl.DateTimeFormat('en', { year: 'numeric', timeZone: prefs.timezone }).format(ms);
  return new Intl.DateTimeFormat(prefs.locale, {
    day: 'numeric',
    month: 'short',
    ...(year(instant) === year(now) ? {} : { year: 'numeric' }),
    timeZone: prefs.timezone,
  }).format(instant);
}
