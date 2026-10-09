import { spawn, spawnSync } from 'node:child_process';
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emailAuthorities } from '../src/auth/auth.ts';
import { EXIT_CONFIG, parseConfig } from '../src/config.ts';
import { TEST_ENV, tempDir } from './helpers.ts';

const serverRoot = join(import.meta.dirname, '..');
const FILE_SECRET = 'Zq8pW3xL0vN6tR2bY9mK4cH7jF1dS5gA';

function errorsOf(env: Record<string, string | undefined>): string[] {
  const result = parseConfig(env);
  if (result.ok) throw new Error('expected config errors');
  return result.errors;
}

describe('parseConfig', () => {
  it('applies the documented defaults', () => {
    const result = parseConfig({ ...TEST_ENV });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { config } = result;
    expect(config.dataDir).toBe('/data');
    expect(config.port).toBe(3000);
    expect(config.trustProxy).toBe(false);
    expect(config.logLevel).toBe('info');
    expect(config.backup).toEqual({ cron: '0 3 * * *', keepDaily: 7, keepWeekly: 4 });
    expect(config.uploadMaxMb).toBe(25);
    expect(config.oidcProviders).toEqual([]);
    expect(config.google).toEqual({
      clientId: TEST_ENV.ROOSTER_GOOGLE_CLIENT_ID,
      clientSecret: TEST_ENV.ROOSTER_GOOGLE_CLIENT_SECRET,
    });
    expect(config.smtp).toBeNull();
    expect(config.s3).toBeNull();
    expect(config.gitSha).toBe('dev');
    expect(config.webDir).toMatch(/[/\\]public$/);
    expect(config.vapidSubject).toBe('mailto:admin@example.com');
  });

  it('AC-0.3 reports a missing ROOSTER_BASE_URL by name', () => {
    const errors = errorsOf({ ...TEST_ENV, ROOSTER_BASE_URL: undefined });
    expect(errors).toEqual(['ROOSTER_BASE_URL: is required']);
  });

  it('lists every problem at once', () => {
    const errors = errorsOf({ PORT: 'abc', ROOSTER_AUTH_SECRET: 'short' });
    expect(errors).toEqual(
      expect.arrayContaining([
        'ROOSTER_BASE_URL: is required',
        'ROOSTER_ADMIN_EMAILS: must list at least one email',
        expect.stringMatching(/^ROOSTER_AUTH_SECRET: must be at least 32 characters/),
        expect.stringMatching(/^PORT: /),
      ]),
    );
  });

  it('treats empty values as unset', () => {
    const errors = errorsOf({ ...TEST_ENV, ROOSTER_BASE_URL: '' });
    expect(errors).toEqual(['ROOSTER_BASE_URL: is required']);
  });

  it('parses lists, booleans, numbers and JSON', () => {
    const result = parseConfig({
      ...TEST_ENV,
      ROOSTER_BASE_URL: 'https://rooster.example.com/',
      ROOSTER_ADMIN_EMAILS: ' A@Example.com, b@example.com ,',
      ROOSTER_ALLOWED_DOMAINS: 'Northwind.example',
      ROOSTER_TRUST_PROXY: 'true',
      PORT: '8080',
      ROOSTER_BACKUP_CRON: 'off',
      ROOSTER_OIDC_PROVIDERS:
        '[{"id":"sso","name":"SSO","discoveryUrl":"https://sso.example.com/.well-known/openid-configuration","clientId":"c","clientSecret":"s"}]',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.baseUrl).toBe('https://rooster.example.com');
    expect(result.config.adminEmails).toEqual(['a@example.com', 'b@example.com']);
    expect(result.config.allowedDomains).toEqual(['northwind.example']);
    expect(result.config.trustProxy).toBe(true);
    expect(result.config.port).toBe(8080);
    expect(result.config.backup.cron).toBeNull();
    expect(result.config.oidcProviders).toHaveLength(1);
  });

  it('rejects invalid values with readable messages', () => {
    const errors = errorsOf({
      ...TEST_ENV,
      ROOSTER_BASE_URL: 'ftp://example.com',
      ROOSTER_ADMIN_EMAILS: 'not-an-email',
      ROOSTER_OIDC_PROVIDERS: '{nope',
      ROOSTER_BACKUP_CRON: 'every day',
      ROOSTER_LOG_LEVEL: 'loud',
      ROOSTER_GOOGLE_CLIENT_ID: 'id-only',
      ROOSTER_GOOGLE_CLIENT_SECRET: undefined,
      ROOSTER_SMTP_URL: 'smtp://mail.example.com',
    });
    const keys = errors.map((e) => e.split(':')[0]);
    expect(keys).toEqual(
      expect.arrayContaining([
        'ROOSTER_BASE_URL',
        'ROOSTER_ADMIN_EMAILS',
        'ROOSTER_OIDC_PROVIDERS',
        'ROOSTER_BACKUP_CRON',
        'ROOSTER_LOG_LEVEL',
        'ROOSTER_GOOGLE_CLIENT_SECRET',
        'ROOSTER_MAIL_FROM',
      ]),
    );
  });

  it('P7: validates the mail sender, the VAPID keys and the VAPID subject', () => {
    const errors = errorsOf({
      ...TEST_ENV,
      ROOSTER_SMTP_URL: 'smtp://mail.example.com',
      ROOSTER_MAIL_FROM: 'Rooster <not an address>',
      ROOSTER_VAPID_PUBLIC: 'too-short',
      ROOSTER_VAPID_PRIVATE: 'also-short',
      ROOSTER_VAPID_SUBJECT: 'admin@example.com',
    });
    expect(errors.map((e) => e.split(':')[0]).sort()).toEqual([
      'ROOSTER_MAIL_FROM',
      'ROOSTER_VAPID_PRIVATE',
      'ROOSTER_VAPID_PUBLIC',
      'ROOSTER_VAPID_SUBJECT',
    ]);
    const ok = parseConfig({
      ...TEST_ENV,
      ROOSTER_SMTP_URL: 'smtps://u:p@smtp.example.com:465',
      ROOSTER_MAIL_FROM: ' Rooster <rooster@example.com> ',
      ROOSTER_VAPID_PUBLIC:
        'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
      ROOSTER_VAPID_PRIVATE: 'tUxbf-Mx9Ex4QgiRbWvt-Q1j0yAfGfgFFUFvcNt7ZnU',
      ROOSTER_VAPID_SUBJECT: 'https://tasks.example.com',
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.config.smtp?.from).toBe('Rooster <rooster@example.com>');
    expect(ok.config.vapidSubject).toBe('https://tasks.example.com');
    // Without a subject: the first admin, as mailto: (08 §3).
    const fallback = parseConfig({ ...TEST_ENV });
    expect(fallback.ok && fallback.config.vapidSubject).toBe('mailto:admin@example.com');
  });

  it('requires at least one sign-in provider', () => {
    const errors = errorsOf({
      ...TEST_ENV,
      ROOSTER_GOOGLE_CLIENT_ID: undefined,
      ROOSTER_GOOGLE_CLIENT_SECRET: undefined,
    });
    expect(errors).toEqual([
      expect.stringMatching(/^ROOSTER_OIDC_PROVIDERS: at least one sign-in provider is required/),
    ]);
    const empty = errorsOf({
      ...TEST_ENV,
      ROOSTER_GOOGLE_CLIENT_ID: undefined,
      ROOSTER_GOOGLE_CLIENT_SECRET: undefined,
      ROOSTER_OIDC_PROVIDERS: '[]',
    });
    expect(empty).toHaveLength(1);
  });

  it('accepts OIDC providers alone and rejects duplicate provider IDs', () => {
    const sso = {
      id: 'sso',
      name: 'SSO',
      discoveryUrl: 'https://sso.example.com/.well-known/openid-configuration',
      clientId: 'c',
      clientSecret: 's',
    };
    const only = parseConfig({
      ...TEST_ENV,
      ROOSTER_GOOGLE_CLIENT_ID: undefined,
      ROOSTER_GOOGLE_CLIENT_SECRET: undefined,
      ROOSTER_OIDC_PROVIDERS: JSON.stringify([sso]),
    });
    expect(only.ok).toBe(true);
    expect(errorsOf({ ...TEST_ENV, ROOSTER_OIDC_PROVIDERS: JSON.stringify([sso, sso]) })).toEqual([
      'ROOSTER_OIDC_PROVIDERS: provider id "sso" is used twice',
    ]);
    expect(
      errorsOf({ ...TEST_ENV, ROOSTER_OIDC_PROVIDERS: JSON.stringify([{ ...sso, id: 'google' }]) }),
    ).toEqual(['ROOSTER_OIDC_PROVIDERS: provider id "google" is used twice']);
  });

  it('rejects the change-me placeholder and repeated-pattern secrets', () => {
    for (const secret of [
      'change-me-change-me-change-me-change-me',
      'xK2pL9vQ7mR3tW8yZ1aB5cD6eF4gH0jCHANGE-ME',
    ]) {
      expect(errorsOf({ ...TEST_ENV, ROOSTER_AUTH_SECRET: secret })).toEqual([
        expect.stringMatching(/^ROOSTER_AUTH_SECRET: .*change-me.*openssl rand -base64 48/),
      ]);
    }
    expect(
      errorsOf({ ...TEST_ENV, ROOSTER_AUTH_SECRET: 'e2e-secret-e2e-secret-e2e-secret-e2e' }),
    ).toEqual([expect.stringMatching(/^ROOSTER_AUTH_SECRET: is too weak.*openssl rand/)]);
    // Random hex (16 symbols) and base64 secrets pass.
    for (const secret of [
      '3f9c0a7e1b5d2468ace013579bdf2468',
      'q1V9zK3m0Rj8fT2wXy7Lb5Nc4Hd6Gs0P+Ae/Uo==',
    ]) {
      expect(parseConfig({ ...TEST_ENV, ROOSTER_AUTH_SECRET: secret }).ok).toBe(true);
    }
  });

  it('parses ROOSTER_TRUSTED_PROXY_HOPS (default 1, at least 1)', () => {
    const parsed = (hops: string | undefined) => {
      const result = parseConfig({ ...TEST_ENV, ROOSTER_TRUSTED_PROXY_HOPS: hops });
      return result.ok ? result.config.trustedProxyHops : null;
    };
    expect(parsed(undefined)).toBe(1);
    expect(parsed('2')).toBe(2);
    expect(parsed('0')).toBeNull();
    expect(parsed('two')).toBeNull();
  });

  it('OIDC providers do not vouch for emails unless trustEmail is set', () => {
    const sso = {
      id: 'sso',
      name: 'SSO',
      discoveryUrl: 'https://sso.example.com/.well-known/openid-configuration',
      clientId: 'c',
      clientSecret: 's',
    };
    const result = parseConfig({
      ...TEST_ENV,
      ROOSTER_OIDC_PROVIDERS: JSON.stringify([sso, { ...sso, id: 'corp', trustEmail: true }]),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.oidcProviders.map((p) => [p.id, p.trustEmail])).toEqual([
      ['sso', false],
      ['corp', true],
    ]);
    expect([...emailAuthorities(result.config)].sort()).toEqual(['corp', 'google']);
    expect(
      errorsOf({
        ...TEST_ENV,
        ROOSTER_OIDC_PROVIDERS: JSON.stringify([{ ...sso, trustEmail: 'yes' }]),
      }),
    ).toEqual([expect.stringMatching(/^ROOSTER_OIDC_PROVIDERS: /)]);
  });

  it('reads <NAME>_FILE values, which win over the plain variable', () => {
    const dir = tempDir();
    try {
      const secretFile = join(dir.path, 'secret');
      writeFileSync(secretFile, `${FILE_SECRET}\n`);
      const result = parseConfig({
        ...TEST_ENV,
        ROOSTER_AUTH_SECRET: 'ignored-because-file-wins-xxxxxxxxxxxxxxx',
        ROOSTER_AUTH_SECRET_FILE: secretFile,
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.config.authSecret).toBe(FILE_SECRET);
    } finally {
      dir.cleanup();
    }
  });

  it('reports an unreadable <NAME>_FILE', () => {
    const errors = errorsOf({ ...TEST_ENV, ROOSTER_AUTH_SECRET_FILE: '/nonexistent/secret' });
    expect(errors).toEqual([expect.stringMatching(/^ROOSTER_AUTH_SECRET_FILE: cannot read/)]);
  });
});

describe('process boot', () => {
  function boot(extra: Record<string, string>) {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith('ROOSTER_') && k !== 'PORT'),
    );
    return spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd: serverRoot,
      env: { ...env, ...extra },
      encoding: 'utf8',
      timeout: 30_000,
    });
  }

  it('AC-0.3 exits with code 78 and a readable error when ROOSTER_BASE_URL is missing', () => {
    const result = boot({
      ROOSTER_AUTH_SECRET: TEST_ENV.ROOSTER_AUTH_SECRET,
      ROOSTER_ADMIN_EMAILS: 'a@b.test',
    });
    expect(result.status).toBe(EXIT_CONFIG);
    expect(result.stderr).toContain('invalid configuration');
    expect(result.stderr).toContain('ROOSTER_BASE_URL: is required');
  });

  it('exits with code 78 and the openssl hint when the secret is the placeholder', () => {
    const result = boot({
      ROOSTER_BASE_URL: TEST_ENV.ROOSTER_BASE_URL,
      ROOSTER_AUTH_SECRET: 'change-me-change-me-change-me-change-me',
      ROOSTER_ADMIN_EMAILS: 'a@b.test',
      ROOSTER_GOOGLE_CLIENT_ID: 'id',
      ROOSTER_GOOGLE_CLIENT_SECRET: 'secret',
    });
    expect(result.status).toBe(EXIT_CONFIG);
    expect(result.stderr).toContain('ROOSTER_AUTH_SECRET');
    expect(result.stderr).toContain('openssl rand -base64 48');
  });

  it('boots with umask 0077: the database and its directories are private', async () => {
    const data = tempDir();
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith('ROOSTER_') && k !== 'PORT'),
    );
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd: serverRoot,
      env: {
        ...env,
        ...TEST_ENV,
        ROOSTER_DATA_DIR: data.path,
        ROOSTER_WEB_DIR: join(data.path, 'no-web'),
        ROOSTER_LOG_LEVEL: 'info',
        PORT: String(41_000 + Math.floor(Math.random() * 2_000)),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('server did not start')), 30_000);
        child.stdout.on('data', (chunk: Buffer) => {
          if (chunk.toString().includes('rooster listening')) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once('exit', (code) => reject(new Error(`server exited with ${code}`)));
      });
      expect(statSync(join(data.path, 'rooster.db')).mode & 0o777).toBe(0o600);
      expect(statSync(join(data.path, 'backups')).mode & 0o777).toBe(0o700);
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('close', resolve));
      data.cleanup();
    }
  }, 40_000);

  it('exits with code 78 when no sign-in provider is configured', () => {
    const result = boot({
      ROOSTER_BASE_URL: TEST_ENV.ROOSTER_BASE_URL,
      ROOSTER_AUTH_SECRET: TEST_ENV.ROOSTER_AUTH_SECRET,
      ROOSTER_ADMIN_EMAILS: 'a@b.test',
    });
    expect(result.status).toBe(EXIT_CONFIG);
    expect(result.stderr).toContain('at least one sign-in provider is required');
  });
});
