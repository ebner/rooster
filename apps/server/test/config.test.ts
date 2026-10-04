import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXIT_CONFIG, parseConfig } from '../src/config.ts';
import { TEST_ENV, tempDir } from './helpers.ts';

const serverRoot = join(import.meta.dirname, '..');

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
    expect(config.google).toBeNull();
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

  it('reads <NAME>_FILE values, which win over the plain variable', () => {
    const dir = tempDir();
    try {
      const secretFile = join(dir.path, 'secret');
      writeFileSync(secretFile, `${'s'.repeat(40)}\n`);
      const result = parseConfig({
        ...TEST_ENV,
        ROOSTER_AUTH_SECRET: 'ignored-because-file-wins-xxxxxxxxxxxxxxx',
        ROOSTER_AUTH_SECRET_FILE: secretFile,
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.config.authSecret).toBe('s'.repeat(40));
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
  it('AC-0.3 exits with code 78 and a readable error when ROOSTER_BASE_URL is missing', () => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith('ROOSTER_') && k !== 'PORT'),
    );
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd: serverRoot,
      env: {
        ...env,
        ROOSTER_AUTH_SECRET: TEST_ENV.ROOSTER_AUTH_SECRET,
        ROOSTER_ADMIN_EMAILS: 'a@b.test',
      },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status).toBe(EXIT_CONFIG);
    expect(result.stderr).toContain('invalid configuration');
    expect(result.stderr).toContain('ROOSTER_BASE_URL: is required');
  });
});
