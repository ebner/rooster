import { defineCommand } from 'citty';
import { type Grant, grantsApi, RoosterApiError, type TokenCreate } from '../api.ts';
import { CliError, EXIT } from '../errors.ts';
import {
  buildConstraints,
  constraintLines,
  parseExpiry,
  parseScopes,
  scopeSummary,
} from '../grant-info.ts';
import { t } from '../i18n.ts';
import { clean, paint } from '../output/color.ts';
import { styles } from '../output/theme.ts';
import { type Runtime, rt } from '../runtime.ts';
import { confirmOrAbort, positionals, readOptions, stringOptions } from './util.ts';

/** 11 §2.4: PATs expire after 90 days unless asked otherwise. */
export const TOKEN_DEFAULT_EXPIRY_DAYS = 90;

const day = (ms: number | null) => (ms === null ? '—' : new Date(ms).toISOString().slice(0, 10));

async function printGrants(runtime: Runtime, grants: readonly Grant[]): Promise<void> {
  const { out } = runtime;
  if (out.json) {
    out.data(grants);
    return;
  }
  if (out.quiet) {
    for (const grant of grants) out.line(grant.id);
    return;
  }
  if (grants.length === 0) {
    out.notice(t('apps.none'));
    return;
  }
  for (const grant of grants) {
    const current = grant.current ? ` ${paint(t('apps.current'), styles.accent, out.level)}` : '';
    out.line(
      `${paint(grant.id.slice(0, 13), styles.muted, out.level)}  ${paint(clean(grant.label), styles.heading, out.level)}${current}`,
    );
    const facts = [
      t(`grant.kind.${grant.kind}`),
      ...(grant.tokenPrefix === null ? [] : [`${clean(grant.tokenPrefix)}…`]),
      scopeSummary(grant.scopes),
    ];
    out.line(`    ${facts.join(' · ')}`);
    for (const line of await constraintLines(runtime, grant.constraints)) out.line(`    ${line}`);
    out.line(
      `    ${paint(
        t('apps.dates', {
          created: day(grant.createdAt),
          used: day(grant.lastUsedAt),
          expires: grant.expiresAt === null ? t('grant.never') : day(grant.expiresAt),
        }),
        styles.muted,
        out.level,
      )}`,
    );
  }
}

/**
 * Creating tokens and revoking other grants need the browser session (11 §2.1); a CLI device
 * or PAT gets `403 forbidden_scope`, explained here with where to do it instead.
 */
async function browserOnly<T>(request: Promise<T>, key: string): Promise<T> {
  try {
    return await request;
  } catch (error) {
    if (error instanceof RoosterApiError && error.code === 'forbidden_scope') {
      throw new CliError(EXIT.auth, t(key), error.code);
    }
    throw error;
  }
}

/** A grant by full ID or unique ID prefix (as `apps ls` prints it). */
async function findGrant(runtime: Runtime, id: string, kind?: Grant['kind']): Promise<Grant> {
  const grants = (await grantsApi.list(await runtime.api())).filter(
    (g) => kind === undefined || g.kind === kind,
  );
  const matches = grants.filter((g) => g.id === id || g.id.startsWith(id.toLowerCase()));
  if (matches.length === 1 && matches[0]) return matches[0];
  if (matches.length > 1) throw new CliError(EXIT.notFound, t('apps.ambiguous', { id }));
  throw new CliError(EXIT.notFound, t('apps.notFound', { id }));
}

async function revoke(runtime: Runtime, id: string, kind?: Grant['kind']): Promise<void> {
  const grant = await findGrant(runtime, id, kind);
  if (grant.current) await confirmOrAbort(runtime, t('apps.confirmCurrent'));
  await browserOnly(grantsApi.remove(await runtime.api(), grant.id), 'apps.browserOnly');
  if (runtime.out.json) runtime.out.data({ id: grant.id, revoked: true });
  else runtime.out.notice(t('apps.revoked', { label: clean(grant.label) }));
}

const tokenCreateArgs = () =>
  ({
    name: { type: 'positional', required: true, description: t('token.arg.name') },
    scope: { type: 'string', valueHint: 'tasks:read,…', description: t('token.arg.scope') },
    'read-only': { type: 'boolean', description: t('token.arg.readOnly') },
    org: { type: 'string', valueHint: 'slug', description: t('token.arg.org') },
    group: { type: 'string', valueHint: 'org/name', description: t('token.arg.group') },
    'write-group': {
      type: 'string',
      valueHint: 'org/name',
      description: t('token.arg.writeGroup'),
    },
    expires: { type: 'string', valueHint: '90d|never', description: t('token.arg.expires') },
  }) as const;

const tokenCreate = defineCommand({
  meta: () => ({ name: 'create', description: t('token.cmd.create') }),
  args: tokenCreateArgs,
  async run({ args, rawArgs }) {
    // Scopes and constraints shape the grant: a value that looks like another option is
    // refused, never read as one (`--scope --read-only` must not widen or narrow anything).
    const given = readOptions(rawArgs, stringOptions(tokenCreateArgs()));
    const all = (name: string) => [...(given.values.get(name) ?? [])];
    const runtime = rt();
    const name = positionals(args).join(' ').trim();
    if (name === '') throw new CliError(EXIT.usage, t('token.nameMissing'));
    const requested = all('scope');
    if (args['read-only'] === true && requested.length > 0) {
      throw new CliError(EXIT.usage, t('token.readOnlyAndScope'));
    }
    const scopes = requested.length === 0 ? (['tasks:read'] as const) : parseScopes(requested);
    const constraints = await buildConstraints(
      runtime,
      {
        orgs: all('org'),
        readGroups: all('group'),
        writeGroups: all('write-group'),
      },
      [...scopes],
    );
    const expiresInDays = parseExpiry(
      typeof args.expires === 'string' ? args.expires : undefined,
      TOKEN_DEFAULT_EXPIRY_DAYS,
    );
    const created = await browserOnly(
      grantsApi.createToken(await runtime.api(), {
        name,
        scopes: [...scopes],
        constraints: constraints as TokenCreate['constraints'],
        ...(expiresInDays === undefined ? {} : { expiresInDays }),
      }),
      'token.browserOnly',
    );
    const { out } = runtime;
    if (out.json) {
      out.data(created);
      return;
    }
    // The token alone on stdout (pipe it into a secret store); the rest on stderr.
    out.line(created.token);
    out.notice(t('token.shownOnce'));
    out.notice(`${scopeSummary(created.grant.scopes)}`);
    for (const line of await constraintLines(runtime, created.grant.constraints)) out.notice(line);
  },
});

const tokenLs = defineCommand({
  meta: () => ({ name: 'ls', description: t('token.cmd.ls') }),
  async run() {
    const runtime = rt();
    const grants = await grantsApi.list(await runtime.api());
    await printGrants(
      runtime,
      grants.filter((g) => g.kind === 'pat'),
    );
  },
});

const tokenRevoke = defineCommand({
  meta: () => ({ name: 'revoke', description: t('token.cmd.revoke') }),
  args: () => ({ id: { type: 'positional', required: true, description: t('apps.arg.id') } }),
  async run({ args }) {
    await revoke(rt(), positionals(args)[0] ?? '', 'pat');
  },
});

export const tokenCommand = defineCommand({
  meta: () => ({ name: 'token', description: t('cmd.token') }),
  subCommands: { create: tokenCreate, ls: tokenLs, revoke: tokenRevoke },
});

const appsLs = defineCommand({
  meta: () => ({ name: 'ls', description: t('apps.cmd.ls') }),
  async run() {
    const runtime = rt();
    await printGrants(runtime, await grantsApi.list(await runtime.api()));
  },
});

const appsRevoke = defineCommand({
  meta: () => ({ name: 'revoke', description: t('apps.cmd.revoke') }),
  args: () => ({ id: { type: 'positional', required: true, description: t('apps.arg.id') } }),
  async run({ args }) {
    await revoke(rt(), positionals(args)[0] ?? '');
  },
});

export const appsCommand = defineCommand({
  meta: () => ({ name: 'apps', description: t('cmd.apps') }),
  subCommands: { ls: appsLs, revoke: appsRevoke },
});
