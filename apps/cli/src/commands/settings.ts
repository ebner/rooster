import { defineCommand } from 'citty';
import { DEFAULT_PROFILE, normalizeServer, PROFILE_KEYS, type ProfileKey } from '../config.ts';
import { CliError, EXIT } from '../errors.ts';
import { isLocale, t } from '../i18n.ts';
import { clean, paint } from '../output/color.ts';
import { styles } from '../output/theme.ts';
import { rt } from '../runtime.ts';
import { needs, positionals } from './util.ts';

const orgLs = defineCommand({
  meta: () => ({ name: 'ls', description: t('org.cmd.ls') }),
  async run() {
    const runtime = needs('tasks:read');
    const me = await runtime.me();
    const current = await runtime.org().catch(() => null);
    const { out } = runtime;
    if (out.json) {
      out.data(me.orgs);
      return;
    }
    const width = Math.max(...me.orgs.map((o) => o.slug.length));
    for (const org of me.orgs) {
      if (out.quiet) {
        out.line(clean(org.slug));
        continue;
      }
      const marker = org.id === current?.id ? paint('*', styles.accent, out.level) : ' ';
      const notes = [
        ...(org.isPersonal ? [t('org.personal')] : []),
        ...(org.role === 'owner' ? [t('org.owner')] : []),
      ];
      const suffix =
        notes.length === 0 ? '' : `  ${paint(notes.join(', '), styles.muted, out.level)}`;
      out.line(`${marker} ${clean(org.slug).padEnd(width)}  ${clean(org.name)}${suffix}`);
    }
  },
});

const orgUse = defineCommand({
  meta: () => ({ name: 'use', description: t('org.cmd.use') }),
  args: () => ({ slug: { type: 'positional', required: true, description: t('org.arg.slug') } }),
  async run({ args }) {
    const runtime = rt();
    const org = await runtime.findOrg(positionals(args)[0] ?? '');
    runtime.config.updateProfile(runtime.profileName, (profile) => ({ ...profile, org: org.slug }));
    if (runtime.out.json) runtime.out.data(org);
    else runtime.out.notice(t('org.using', { org: clean(org.name), slug: org.slug }));
  },
});

export const orgCommand = defineCommand({
  meta: () => ({ name: 'org', description: t('cmd.org') }),
  subCommands: { ls: orgLs, use: orgUse },
});

const KEYS = [...PROFILE_KEYS, 'default_profile'] as const;
type Key = (typeof KEYS)[number];

function parseKey(value: string | undefined): Key {
  if (value !== undefined && (KEYS as readonly string[]).includes(value)) return value as Key;
  throw new CliError(EXIT.usage, t('config.badKey', { key: value ?? '', keys: KEYS.join(', ') }));
}

const configGet = defineCommand({
  meta: () => ({ name: 'get', description: t('config.cmd.get') }),
  args: () => ({ key: { type: 'positional', required: false, description: t('config.arg.key') } }),
  run({ args }) {
    const runtime = rt();
    const raw = positionals(args)[0];
    const config = runtime.config.read();
    const values: Record<string, string | undefined> = {
      default_profile: config.default_profile ?? DEFAULT_PROFILE,
      ...Object.fromEntries(PROFILE_KEYS.map((k) => [k, runtime.profile[k]])),
    };
    if (raw === undefined) {
      if (runtime.out.json) runtime.out.data({ profile: runtime.profileName, ...values });
      else {
        runtime.out.line(`profile = ${runtime.profileName}`);
        for (const [key, value] of Object.entries(values)) {
          if (value !== undefined) runtime.out.line(`${key} = ${value}`);
        }
      }
      return;
    }
    const value = values[parseKey(raw)];
    if (value === undefined) throw new CliError(EXIT.notFound, t('config.unset', { key: raw }));
    if (runtime.out.json) runtime.out.data({ [raw]: value });
    else runtime.out.line(value);
  },
});

const configSet = defineCommand({
  meta: () => ({ name: 'set', description: t('config.cmd.set') }),
  args: () => ({
    key: { type: 'positional', required: true, description: t('config.arg.key') },
    value: { type: 'positional', required: true, description: t('config.arg.value') },
  }),
  run({ args }) {
    const runtime = rt();
    const [raw, value = ''] = positionals(args);
    const key = parseKey(raw);
    const clear = value === '' || value === 'none';
    if (key === 'default_profile') {
      runtime.config.update(({ default_profile: _old, ...rest }) =>
        clear ? rest : { ...rest, default_profile: value },
      );
    } else {
      let next = value;
      if (!clear && key === 'server') next = normalizeServer(value);
      if (!clear && key === 'locale' && !isLocale(value)) {
        throw new CliError(EXIT.usage, t('config.badLocale', { value }));
      }
      runtime.config.updateProfile(runtime.profileName, (profile) => {
        const updated = { ...profile };
        if (clear) delete updated[key as ProfileKey];
        else updated[key as ProfileKey] = next;
        return updated;
      });
    }
    runtime.out.notice(t('config.saved', { key, profile: runtime.profileName }));
  },
});

const configPath = defineCommand({
  meta: () => ({ name: 'path', description: t('config.cmd.path') }),
  run() {
    const runtime = rt();
    if (runtime.out.json) runtime.out.data({ path: runtime.config.path });
    else runtime.out.line(runtime.config.path);
  },
});

export const configCommand = defineCommand({
  meta: () => ({ name: 'config', description: t('cmd.config') }),
  subCommands: { get: configGet, set: configSet, path: configPath },
});
