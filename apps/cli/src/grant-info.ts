import {
  expandScopes,
  GRANT_SCOPES,
  type GrantConstraints,
  type GrantScope,
  isGrantScope,
  minimalScopes,
  type OrgGrant,
} from '@rooster/core/grants';
import { type Grant, grantsApi, type Org, type RoosterApiError } from './api.ts';
import { CliError, EXIT, exitCodeForProblem } from './errors.ts';
import { currentLocale, t } from './i18n.ts';
import { clean } from './output/color.ts';
import type { Runtime } from './runtime.ts';

/** `--scope a,b --scope c` → scopes; unknown names are a usage error (exit 2). */
export function parseScopes(values: readonly string[]): GrantScope[] {
  const out: GrantScope[] = [];
  for (const value of values.flatMap((v) => v.split(/[\s,]+/)).filter((v) => v !== '')) {
    if (!isGrantScope(value)) {
      throw new CliError(
        EXIT.usage,
        t('grant.unknownScope', { scope: value, scopes: GRANT_SCOPES.join(', ') }),
      );
    }
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

/** `90d`, `90`, `never` → days (undefined = never). */
export function parseExpiry(value: string | undefined, fallback: number | undefined) {
  if (value === undefined || value === '') return fallback;
  if (value === 'never') return undefined;
  const match = /^(\d{1,4})d?$/.exec(value.trim());
  const days = match ? Number(match[1]) : Number.NaN;
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw new CliError(EXIT.usage, t('grant.badExpiry', { value }));
  }
  return days;
}

/** `org/Group name` → its parts; the org is a slug or `personal`. */
export function parseGroupSpec(spec: string): { org: string; group: string } {
  const slash = spec.indexOf('/');
  if (slash <= 0 || slash === spec.length - 1) {
    throw new CliError(EXIT.usage, t('grant.badGroupSpec', { spec }));
  }
  return { org: spec.slice(0, slash), group: spec.slice(slash + 1) };
}

export interface ConstraintFlags {
  orgs: readonly string[];
  readGroups: readonly string[];
  writeGroups: readonly string[];
}

/**
 * Builds the constraints of a new grant (11 §2.2) from `--org`, `--group` (read limited to
 * these groups) and `--write-group` (write limited to these groups). Without any flag the
 * grant covers every org, including future ones. Write is `all` in a listed org when a write
 * scope was asked for, else `none`; write groups are always readable.
 */
export async function buildConstraints(
  runtime: Runtime,
  flags: ConstraintFlags,
  scopes: readonly GrantScope[],
): Promise<GrantConstraints> {
  if (flags.orgs.length === 0 && flags.readGroups.length === 0 && flags.writeGroups.length === 0) {
    return { orgs: 'all' };
  }
  const writes = writesTasks(scopes);
  const byOrg = new Map<
    string,
    { read: Set<string> | 'all'; write: Set<string> | 'all' | 'none' }
  >();
  const entry = (org: Org) => {
    let e = byOrg.get(org.id);
    if (e === undefined) {
      e = { read: 'all', write: writes ? 'all' : 'none' };
      byOrg.set(org.id, e);
    }
    return e;
  };
  for (const slug of flags.orgs) entry(await runtime.findOrg(slug));
  for (const spec of flags.readGroups) {
    const { org: slug, group } = parseGroupSpec(spec);
    const org = await runtime.findOrg(slug);
    const e = entry(org);
    const id = (await findGroup(runtime, org.id, group)).id;
    e.read = e.read === 'all' ? new Set([id]) : e.read.add(id);
  }
  for (const spec of flags.writeGroups) {
    const { org: slug, group } = parseGroupSpec(spec);
    const org = await runtime.findOrg(slug);
    const e = entry(org);
    const id = (await findGroup(runtime, org.id, group)).id;
    e.write = e.write === 'all' || e.write === 'none' ? new Set([id]) : e.write.add(id);
  }
  const orgs: OrgGrant[] = [...byOrg].map(([orgId, e]) => {
    const write = e.write instanceof Set ? { groups: [...e.write] } : e.write;
    const read =
      e.read === 'all'
        ? ('all' as const)
        : { groups: [...new Set([...e.read, ...(e.write instanceof Set ? e.write : [])])] };
    return { orgId, read, write };
  });
  return { orgs };
}

/**
 * Whether a grant with these scopes changes things in an org, so its default write constraint
 * there is `all` rather than `none`. Commenting writes to the org's tasks too (11 §2.1), and
 * group changes are org-wide writes.
 */
export function writesTasks(scopes: Iterable<GrantScope>): boolean {
  const expanded = expandScopes(scopes);
  return (['tasks:write', 'comments:write', 'groups:write'] as const).some((s) => expanded.has(s));
}

/** A group of the user's list by exact name, then case-insensitive, then unique prefix. */
export async function findGroup(runtime: Runtime, orgId: string, name: string) {
  const groups = await runtime.groups(orgId);
  const wanted = name.toLocaleLowerCase();
  const exact = groups.find((g) => g.name === name);
  if (exact) return exact;
  const folded = groups.filter((g) => g.name.toLocaleLowerCase() === wanted);
  if (folded.length === 1 && folded[0]) return folded[0];
  const prefixed = groups.filter((g) => g.name.toLocaleLowerCase().startsWith(wanted));
  if (prefixed.length === 1 && prefixed[0]) return prefixed[0];
  if (prefixed.length > 1) {
    throw new CliError(
      EXIT.notFound,
      t('group.ambiguous', { name, matches: prefixed.map((g) => g.name).join(', ') }),
    );
  }
  throw new CliError(EXIT.notFound, t('group.notFound', { name }));
}

/** Scope list for display: the minimal set (implied scopes dropped). */
export function scopeSummary(scopes: readonly GrantScope[]): string {
  return minimalScopes(scopes).join(', ');
}

/** One line per constrained org, with group names where the user's list knows them. */
export async function constraintLines(
  runtime: Runtime,
  constraints: GrantConstraints,
): Promise<string[]> {
  if (constraints.orgs === 'all') return [t('grant.allOrgs')];
  const lines: string[] = [];
  for (const o of constraints.orgs) {
    const org = await runtime.orgById(o.orgId);
    const name = org === undefined ? o.orgId : `${clean(org.name)} (${org.slug})`;
    const names = async (ids: readonly string[]) => {
      if (org === undefined) return ids.join(', ');
      const groups = await runtime.groups(org.id).catch(() => []);
      return ids.map((id) => clean(groups.find((g) => g.id === id)?.name ?? id)).join(', ');
    };
    const read = o.read === 'all' ? t('grant.everything') : await names(o.read.groups);
    const write =
      o.write === 'all'
        ? t('grant.everything')
        : o.write === 'none'
          ? t('grant.nothing')
          : await names(o.write.groups);
    lines.push(t('grant.orgLine', { org: name, read, write }));
  }
  return lines;
}

/** The grant behind the current credential, or null (best effort, for explanations). */
export async function currentGrant(runtime: Runtime): Promise<Grant | null> {
  try {
    const grants = await grantsApi.list(await runtime.api());
    return grants.find((g) => g.current) ?? null;
  } catch {
    return null;
  }
}

/**
 * Turns an API failure into the CLI's message and exit code. A missing capability or a
 * target outside the grant (exit 3) is explained in the user's language: which scope is
 * missing, and which groups the credential may write to (07 §4.2, 11 §2.3).
 */
export async function describeApiError(
  runtime: Runtime,
  error: RoosterApiError,
): Promise<CliError> {
  const exit = exitCodeForProblem(error.status, error.code);
  const widen = t('denied.widen');
  // The server's detail names the missing scope or the allowed groups (in English); other
  // languages get the same facts from the grant itself (`@rooster/core/grants`).
  const english = currentLocale() === 'en';
  if ((error.code === 'forbidden_scope' || error.code === 'outside_grant') && english) {
    return new CliError(exit, error.problem?.detail ?? error.message, error.code);
  }
  if (error.code === 'forbidden_scope') {
    const scope = runtime.requiredScope;
    const grant = await currentGrant(runtime);
    if (scope === undefined) return new CliError(exit, error.message, error.code);
    const has = grant === null ? '' : ` ${t('denied.has', { scopes: scopeSummary(grant.scopes) })}`;
    return new CliError(exit, `${t('denied.scope', { scope })}${has} ${widen}`, error.code);
  }
  if (error.code === 'outside_grant') {
    const grant = await currentGrant(runtime);
    const org = await runtime.org().catch(() => null);
    const o =
      grant === null || org === null || grant.constraints.orgs === 'all'
        ? null
        : (grant.constraints.orgs.find((c) => c.orgId === org.id) ?? null);
    if (o === null || org === null) return new CliError(exit, error.message, error.code);
    let message: string;
    if (o.write === 'none') message = t('denied.noWrite', { org: clean(org.name) });
    else if (o.write === 'all') message = t('denied.orgWide', { org: clean(org.name) });
    else {
      const groups = await runtime.groups(org.id).catch(() => []);
      const names = o.write.groups.map((id) => clean(groups.find((g) => g.id === id)?.name ?? id));
      message = t('denied.groups', {
        groups: names.join(', '),
        count: names.length,
        org: clean(org.name),
      });
    }
    return new CliError(exit, `${message} ${widen}`, error.code);
  }
  if (error.code === 'unauthenticated') {
    return new CliError(exit, t('auth.sessionInvalid'), error.code);
  }
  const detail = error.problem?.detail ?? error.message;
  const fields = (error.problem as { errors?: { path: string; message: string }[] } | undefined)
    ?.errors;
  const extra =
    fields === undefined || fields.length === 0
      ? ''
      : `\n${fields.map((f) => `  ${f.path}: ${f.message}`).join('\n')}`;
  return new CliError(exit, `${detail}${extra}`, error.code);
}
