import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { USER_STORAGE_MB_DEFAULT } from '@rooster/core/limits';
import { Cron } from 'croner';
import { z } from 'zod';

/** EX_CONFIG from sysexits.h: the process was started with an invalid configuration. */
export const EXIT_CONFIG = 78;

// Resolved relative to the running module: `src/` under tsx, `dist/` in the bundle.
// Both sit next to the server package root, where the Docker image puts the web build.
export const DEFAULT_WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../public');

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const emailSchema = z.email();

const csvList = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );

const emailList = csvList.pipe(z.array(emailSchema.transform((e) => e.toLowerCase())));

const booleanFlag = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'], {
      error: 'must be one of true, false, 1, 0, yes, no',
    })
    .optional()
    .transform((v) => (v === undefined ? fallback : v === 'true' || v === '1' || v === 'yes'));

/** `on`/`off` switches (11 §4.2, §6.1); the boolean spellings are accepted too. */
const onOffFlag = (fallback: boolean) =>
  z
    .enum(['on', 'off', 'true', 'false', '1', '0', 'yes', 'no'], {
      error: 'must be on or off',
    })
    .optional()
    .transform((v) =>
      v === undefined ? fallback : v === 'on' || v === 'true' || v === '1' || v === 'yes',
    );

const intInRange = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? fallback : Number(v)))
    .pipe(z.number({ error: 'must be a number' }).int().min(min).max(max));

const oidcProviderSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, 'must be lowercase letters, digits, - or _'),
  name: z.string().min(1),
  discoveryUrl: z.url(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  scopes: z.array(z.string().min(1)).optional(),
  /**
   * The provider is authoritative for the email addresses it asserts, so a first sign-in
   * through it may join an existing account with the same verified email (FR-AUTH-5).
   * Off by default: an untrusted provider could assert anyone's address.
   */
  trustEmail: z.boolean().default(false),
});

export type OidcProviderConfig = z.infer<typeof oidcProviderSchema>;

/** better-auth's ID for the built-in Google provider. */
export const GOOGLE_PROVIDER_ID = 'google';

const oidcProviders = z
  .string()
  .optional()
  .transform((raw, ctx) => {
    if (raw === undefined) return [];
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      ctx.addIssue({ code: 'custom', message: 'must be a JSON array' });
      return z.NEVER;
    }
  })
  .pipe(z.array(oidcProviderSchema));

/**
 * Below this many distinct characters a secret is a short pattern repeated to length
 * (`test-secret-test-secret-…`). Not 16: a 32-character hex secret has fewer than 16 distinct
 * characters most of the time, and fewer than 10 about once in 10,000.
 */
const MIN_SECRET_DISTINCT_CHARS = 10;

/** At least 32 characters, not the `.env.example` placeholder, and not a repeated pattern. */
const authSecret = z
  .string()
  .min(32, 'must be at least 32 characters')
  .superRefine((v, ctx) => {
    const hint = 'generate a secret with: openssl rand -base64 48';
    if (/change-me/i.test(v)) {
      ctx.addIssue({
        code: 'custom',
        message: `still contains the "change-me" placeholder; ${hint}`,
      });
    } else if (new Set(v).size < MIN_SECRET_DISTINCT_CHARS) {
      ctx.addIssue({
        code: 'custom',
        message: `is too weak (fewer than ${MIN_SECRET_DISTINCT_CHARS} distinct characters); ${hint}`,
      });
    }
  });

const backupCron = z
  .string()
  .optional()
  .transform((v, ctx) => {
    const pattern = v ?? '0 3 * * *';
    if (pattern === 'off') return null;
    try {
      new Cron(pattern, { paused: true }).stop();
    } catch {
      ctx.addIssue({ code: 'custom', message: `"${pattern}" is not a valid cron pattern` });
      return z.NEVER;
    }
    return pattern;
  });

/** A base64url VAPID key that decodes to `bytes` bytes (P-256: 65 public, 32 private). */
const vapidKey = (bytes: number) =>
  z
    .string()
    .optional()
    .refine(
      (v) =>
        v === undefined ||
        (/^[A-Za-z0-9_-]+={0,2}$/.test(v) && Buffer.from(v, 'base64url').length === bytes),
      `must be a base64url P-256 key of ${bytes} bytes (generate with: npx web-push generate-vapid-keys)`,
    );

/** RFC 8292: the push service's contact for this server, a mailto: or https: URL. */
const vapidSubject = z
  .string()
  .optional()
  .refine((v) => v === undefined || /^(mailto:\S+@\S+|https:\/\/\S+)$/.test(v), {
    error: 'must be a mailto: or https:// URL',
  });

/** `Name <address>` or a bare address. */
const mailFrom = z
  .string()
  .optional()
  .refine(
    (v) => v === undefined || /^(?:[^<>]*<[^<>\s]+@[^<>\s]+>|[^<>\s]+@[^<>\s]+)$/.test(v.trim()),
    {
      error: 'must be an email address, optionally as "Name <address>"',
    },
  );

const envSchema = z.object({
  ROOSTER_BASE_URL: z
    .url({ protocol: /^https?$/, error: 'must be an absolute http(s) URL' })
    .transform((u) => u.replace(/\/+$/, '')),
  ROOSTER_AUTH_SECRET: authSecret,
  ROOSTER_ADMIN_EMAILS: emailList.refine((l) => l.length > 0, 'must list at least one email'),
  ROOSTER_ALLOWED_EMAILS: emailList,
  ROOSTER_ALLOWED_DOMAINS: csvList.transform((l) => l.map((d) => d.toLowerCase())),
  ROOSTER_GOOGLE_CLIENT_ID: z.string().optional(),
  ROOSTER_GOOGLE_CLIENT_SECRET: z.string().optional(),
  ROOSTER_OIDC_PROVIDERS: oidcProviders,
  ROOSTER_DATA_DIR: z.string().default('/data'),
  ROOSTER_WEB_DIR: z.string().optional(),
  PORT: intInRange(3000, 1, 65535),
  ROOSTER_TRUST_PROXY: booleanFlag(false),
  ROOSTER_TRUSTED_PROXY_HOPS: intInRange(1, 1, 16),
  ROOSTER_LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  ROOSTER_SMTP_URL: z
    .url({ protocol: /^smtps?$/, error: 'must be an smtp:// or smtps:// URL' })
    .optional(),
  ROOSTER_MAIL_FROM: mailFrom,
  ROOSTER_VAPID_PUBLIC: vapidKey(65),
  ROOSTER_VAPID_PRIVATE: vapidKey(32),
  ROOSTER_VAPID_SUBJECT: vapidSubject,
  ROOSTER_UPLOAD_MAX_MB: intInRange(25, 1, 10_240),
  /** P11: attachment bytes per uploader in MB; `0` = no quota (ADR 0052 §6). Up to 1 PB. */
  ROOSTER_USER_STORAGE_MB: intInRange(USER_STORAGE_MB_DEFAULT, 0, 1_073_741_824),
  /** P10: the only host S3 requests go to (SSRF, 04 §4.11). */
  ROOSTER_S3_ENDPOINT: z
    .url({ protocol: /^https?$/, error: 'must be an absolute http(s) URL' })
    .optional(),
  ROOSTER_S3_REGION: z.string().optional(),
  ROOSTER_S3_BUCKET: z.string().optional(),
  ROOSTER_S3_ACCESS_KEY_ID: z.string().optional(),
  ROOSTER_S3_SECRET_ACCESS_KEY: z.string().optional(),
  ROOSTER_S3_FORCE_PATH_STYLE: booleanFlag(false),
  ROOSTER_BACKUP_CRON: backupCron,
  ROOSTER_BACKUP_KEEP_DAILY: intInRange(7, 0, 1000),
  ROOSTER_BACKUP_KEEP_WEEKLY: intInRange(4, 0, 1000),
  /** P9: Dynamic Client Registration for older MCP clients (11 §4.2). Off by default. */
  ROOSTER_OAUTH_DCR: onOffFlag(false),
  /** P9: the best-effort discovery documents (11 §6.1). The OAuth metadata stays either way. */
  ROOSTER_AGENT_DISCOVERY: onOffFlag(true),
  ROOSTER_GIT_SHA: z.string().default('dev'),
  /** Test-only (AC-8.4): check every /api/v1 response against the OpenAPI document. */
  ROOSTER_VALIDATE_RESPONSES: booleanFlag(false),
});

type Env = z.output<typeof envSchema>;

/**
 * Presence rules between variables. Checked on the raw values, separately from the schema,
 * so they are reported together with every per-variable problem.
 */
function crossFieldErrors(values: Record<string, string>): string[] {
  const errors: string[] = [];
  const has = (key: string) => values[key] !== undefined;
  const requireWith = (key: string, trigger: string) => {
    if (has(trigger) && !has(key)) errors.push(`${key}: required when ${trigger} is set`);
  };
  requireWith('ROOSTER_GOOGLE_CLIENT_SECRET', 'ROOSTER_GOOGLE_CLIENT_ID');
  requireWith('ROOSTER_GOOGLE_CLIENT_ID', 'ROOSTER_GOOGLE_CLIENT_SECRET');
  requireWith('ROOSTER_VAPID_PRIVATE', 'ROOSTER_VAPID_PUBLIC');
  requireWith('ROOSTER_VAPID_PUBLIC', 'ROOSTER_VAPID_PRIVATE');
  requireWith('ROOSTER_MAIL_FROM', 'ROOSTER_SMTP_URL');
  requireWith('ROOSTER_S3_ACCESS_KEY_ID', 'ROOSTER_S3_BUCKET');
  requireWith('ROOSTER_S3_SECRET_ACCESS_KEY', 'ROOSTER_S3_BUCKET');
  return errors;
}

/** Rules on parsed values: sign-in needs at least one provider, and provider IDs are unique. */
function providerErrors(env: Env): string[] {
  const ids = env.ROOSTER_OIDC_PROVIDERS.map((p) => p.id);
  if (env.ROOSTER_GOOGLE_CLIENT_ID !== undefined) ids.unshift(GOOGLE_PROVIDER_ID);
  if (ids.length === 0) {
    return [
      'ROOSTER_OIDC_PROVIDERS: at least one sign-in provider is required (set ROOSTER_GOOGLE_CLIENT_ID and ROOSTER_GOOGLE_CLIENT_SECRET, or ROOSTER_OIDC_PROVIDERS)',
    ];
  }
  const duplicates = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  return duplicates.map((id) => `ROOSTER_OIDC_PROVIDERS: provider id "${id}" is used twice`);
}

function toConfig(env: Env) {
  return {
    baseUrl: env.ROOSTER_BASE_URL,
    authSecret: env.ROOSTER_AUTH_SECRET,
    adminEmails: env.ROOSTER_ADMIN_EMAILS,
    allowedEmails: env.ROOSTER_ALLOWED_EMAILS,
    allowedDomains: env.ROOSTER_ALLOWED_DOMAINS,
    google:
      env.ROOSTER_GOOGLE_CLIENT_ID !== undefined && env.ROOSTER_GOOGLE_CLIENT_SECRET !== undefined
        ? { clientId: env.ROOSTER_GOOGLE_CLIENT_ID, clientSecret: env.ROOSTER_GOOGLE_CLIENT_SECRET }
        : null,
    oidcProviders: env.ROOSTER_OIDC_PROVIDERS,
    dataDir: resolve(env.ROOSTER_DATA_DIR),
    webDir: resolve(env.ROOSTER_WEB_DIR ?? DEFAULT_WEB_DIR),
    port: env.PORT,
    trustProxy: env.ROOSTER_TRUST_PROXY,
    trustedProxyHops: env.ROOSTER_TRUSTED_PROXY_HOPS,
    logLevel: env.ROOSTER_LOG_LEVEL,
    smtp:
      env.ROOSTER_SMTP_URL !== undefined && env.ROOSTER_MAIL_FROM !== undefined
        ? { url: env.ROOSTER_SMTP_URL, from: env.ROOSTER_MAIL_FROM.trim() }
        : null,
    vapid:
      env.ROOSTER_VAPID_PUBLIC !== undefined && env.ROOSTER_VAPID_PRIVATE !== undefined
        ? { publicKey: env.ROOSTER_VAPID_PUBLIC, privateKey: env.ROOSTER_VAPID_PRIVATE }
        : null,
    vapidSubject: env.ROOSTER_VAPID_SUBJECT ?? `mailto:${env.ROOSTER_ADMIN_EMAILS[0] ?? ''}`,
    uploadMaxMb: env.ROOSTER_UPLOAD_MAX_MB,
    /** Bytes; null without a quota (`ROOSTER_USER_STORAGE_MB=0`). */
    userStorageQuotaBytes:
      env.ROOSTER_USER_STORAGE_MB === 0 ? null : env.ROOSTER_USER_STORAGE_MB * 1024 * 1024,
    s3:
      env.ROOSTER_S3_BUCKET !== undefined &&
      env.ROOSTER_S3_ACCESS_KEY_ID !== undefined &&
      env.ROOSTER_S3_SECRET_ACCESS_KEY !== undefined
        ? {
            bucket: env.ROOSTER_S3_BUCKET,
            endpoint: env.ROOSTER_S3_ENDPOINT ?? null,
            region: env.ROOSTER_S3_REGION ?? 'us-east-1',
            accessKeyId: env.ROOSTER_S3_ACCESS_KEY_ID,
            secretAccessKey: env.ROOSTER_S3_SECRET_ACCESS_KEY,
            forcePathStyle: env.ROOSTER_S3_FORCE_PATH_STYLE,
          }
        : null,
    backup: {
      cron: env.ROOSTER_BACKUP_CRON,
      keepDaily: env.ROOSTER_BACKUP_KEEP_DAILY,
      keepWeekly: env.ROOSTER_BACKUP_KEEP_WEEKLY,
    },
    oauthDcr: env.ROOSTER_OAUTH_DCR,
    agentDiscovery: env.ROOSTER_AGENT_DISCOVERY,
    gitSha: env.ROOSTER_GIT_SHA,
    validateResponses: env.ROOSTER_VALIDATE_RESPONSES,
  };
}

export type Config = ReturnType<typeof toConfig>;

export type ConfigResult = { ok: true; config: Config } | { ok: false; errors: string[] };

const KNOWN_KEYS = new Set(Object.keys(envSchema.shape));

/**
 * Applies the `<NAME>_FILE` convention (Docker secrets): the file's content, without a
 * trailing newline, replaces `<NAME>`. Empty values count as unset so that blank lines
 * in an env file do not trip validation.
 */
function resolveEnv(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string,
): { values: Record<string, string>; errors: string[]; unreadable: Set<string> } {
  const values: Record<string, string> = {};
  const errors: string[] = [];
  const unreadable = new Set<string>();
  for (const key of KNOWN_KEYS) {
    const direct = env[key];
    const filePath = env[`${key}_FILE`];
    if (filePath !== undefined && filePath !== '') {
      try {
        const content = readFile(filePath).replace(/\r?\n$/, '');
        if (content !== '') values[key] = content;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        errors.push(`${key}_FILE: cannot read ${filePath} (${reason})`);
        unreadable.add(key);
      }
    } else if (direct !== undefined && direct !== '') {
      values[key] = direct;
    }
  }
  return { values, errors, unreadable };
}

/** Pure config parser: never exits and never touches `process`. */
export function parseConfig(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): ConfigResult {
  const { values, errors, unreadable } = resolveEnv(env, readFile);
  const parsed = envSchema.safeParse(values);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path[0] === undefined ? '(env)' : String(issue.path[0]);
      // Already reported as an unreadable <NAME>_FILE.
      if (unreadable.has(key)) continue;
      const message =
        issue.code === 'invalid_type' && values[key] === undefined ? 'is required' : issue.message;
      errors.push(`${key}: ${message}`);
    }
  }
  errors.push(...crossFieldErrors(values));
  if (parsed.success) errors.push(...providerErrors(parsed.data));
  if (errors.length > 0 || !parsed.success) return { ok: false, errors };
  return { ok: true, config: toConfig(parsed.data) };
}

/** Parses `process.env`; on failure prints every problem and exits with EX_CONFIG (78). */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = parseConfig(env);
  if (result.ok) return result.config;
  const lines = result.errors.map((e) => `  - ${e}`).join('\n');
  process.stderr.write(
    `rooster: invalid configuration\n${lines}\nSee apps/server/.env.example for the full reference.\n`,
  );
  process.exit(EXIT_CONFIG);
}
