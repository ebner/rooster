import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import { adminSystemSchema } from '@rooster/core/schemas';
import type { AppEnv } from '../lib/context.ts';
import { named } from '../lib/openapi.ts';
import type { Services } from '../services/index.ts';
import { AUTHED, actorOf, body, idParam, json, problems } from './common.ts';
import {
  AdminUserPatchSchema,
  AdminUserSchema,
  AllowlistCreateSchema,
  AllowlistEntrySchema,
  BackupSchema,
  MailTestResultSchema,
  ReindexResultSchema,
} from './schemas.ts';

const tags = ['admin'];

/** P11 (ADR 0052 §7). */
export const AdminSystemSchema = named(adminSystemSchema, 'AdminSystem');

const getSystem = createRoute({
  method: 'get',
  path: '/api/v1/admin/system',
  tags,
  operationId: 'getSystemStatus',
  summary: 'Instance status for Admin → System (instance admins)',
  description:
    'The version, git SHA and start time; the database and WAL file sizes; the newest backup; the last run of each scheduled job since the server started (`null` before its first run); whether SMTP is configured; where the push keys come from and how many devices are subscribed; open realtime connections; attachment storage (backend, bytes, files and the per-user quota); and the number of users, organisations and live tasks.',
  responses: {
    200: json(AdminSystemSchema, 'The instance status'),
    ...problems(401, 'forbidden'),
  },
});

const listAllowlist = createRoute({
  method: 'get',
  path: '/api/v1/admin/allowlist',
  tags,
  operationId: 'listAllowlist',
  summary: 'Sign-in allowlist entries (instance admins)',
  description:
    'Who may sign in besides invitees and `ROOSTER_ADMIN_EMAILS`: single addresses and whole domains.',
  responses: {
    200: json(z.array(AllowlistEntrySchema), 'Entries'),
    ...problems(401, 'forbidden'),
  },
});

const addAllowlist = createRoute({
  method: 'post',
  path: '/api/v1/admin/allowlist',
  tags,
  operationId: 'addAllowlistEntry',
  summary: 'Allow an email address or a whole domain to sign in (instance admins)',
  description:
    'Values are stored lowercase and compared case-insensitively. A domain entry admits addresses from identity providers that vouch for the email. A duplicate is `409 already_exists`.',
  request: { body: body(AllowlistCreateSchema) },
  responses: {
    201: json(AllowlistEntrySchema, 'The entry'),
    ...problems(...AUTHED, 'forbidden', 'already_exists'),
  },
});

const deleteAllowlist = createRoute({
  method: 'delete',
  path: '/api/v1/admin/allowlist/{id}',
  tags,
  operationId: 'removeAllowlistEntry',
  summary: 'Remove an allowlist entry (instance admins)',
  description: 'Existing users keep their accounts; only new sign-ins are affected.',
  request: { params: z.object({ id: idParam('id', 'Entry ID') }) },
  responses: { 204: { description: 'Removed' }, ...problems(...AUTHED, 404, 'forbidden') },
});

const listUsers = createRoute({
  method: 'get',
  path: '/api/v1/admin/users',
  tags,
  operationId: 'listUsers',
  summary: 'All users of the instance (instance admins)',
  description: 'Every account, deactivated ones included (`disabledAt`).',
  responses: {
    200: json(z.array(AdminUserSchema), 'Users, newest first'),
    ...problems(401, 'forbidden'),
  },
});

const patchUser = createRoute({
  method: 'patch',
  path: '/api/v1/admin/users/{id}',
  tags,
  operationId: 'updateUser',
  summary: 'Deactivate or reactivate a user (instance admins)',
  description:
    'Deactivating signs the user out everywhere and blocks sign-in; their data stays. Admins cannot deactivate themselves (`409 cannot_disable_self`).',
  request: { params: z.object({ id: idParam('id', 'User ID') }), body: body(AdminUserPatchSchema) },
  responses: {
    200: json(AdminUserSchema, 'The user'),
    ...problems(...AUTHED, 404, 'forbidden', 'cannot_disable_self'),
  },
});

const listBackups = createRoute({
  method: 'get',
  path: '/api/v1/admin/backups',
  tags,
  operationId: 'listBackups',
  summary: 'Database snapshots, newest first (instance admins)',
  description:
    'Scheduled (daily, weekly), manual and pre-migration snapshots in `<dataDir>/backups`, with their size.',
  responses: { 200: json(z.array(BackupSchema), 'Backups'), ...problems(401, 'forbidden') },
});

const createBackup = createRoute({
  method: 'post',
  path: '/api/v1/admin/backups',
  tags,
  operationId: 'createBackup',
  summary: 'Take a snapshot now (instance admins)',
  description:
    'A consistent online copy of the database (`manual-<time>.db`); the server keeps serving meanwhile.',
  responses: { 201: json(BackupSchema, 'The new backup'), ...problems(...AUTHED, 'forbidden') },
});

const downloadBackup = createRoute({
  method: 'get',
  path: '/api/v1/admin/backups/{name}',
  tags,
  operationId: 'downloadBackup',
  summary: 'Download a snapshot (instance admins)',
  description:
    'Streams the SQLite file as an attachment. Only names from the list are accepted; anything else is 404.',
  request: { params: z.object({ name: idParam('name', 'Backup file name') }) },
  responses: {
    200: {
      description: 'The SQLite database file',
      headers: {
        'Content-Disposition': {
          description: '`attachment; filename="<name>"`',
          schema: { type: 'string' },
          required: true,
        },
      },
      content: { 'application/vnd.sqlite3': { schema: z.string().openapi({ format: 'binary' }) } },
    },
    ...problems(401, 404, 'forbidden'),
  },
});

const reindexSearch = createRoute({
  method: 'post',
  path: '/api/v1/admin/search/reindex',
  tags,
  operationId: 'reindexSearch',
  summary: 'Rebuild the search index from the tasks (instance admins)',
  description:
    'Rebuilds the full-text index from the task table in one transaction. The server also does this at boot when the index looks out of step; this is the manual repair.',
  responses: {
    200: json(ReindexResultSchema, 'The rebuild'),
    ...problems(...AUTHED, 'forbidden'),
  },
});

const testMail = createRoute({
  method: 'post',
  path: '/api/v1/admin/mail/test',
  tags,
  operationId: 'sendTestMail',
  summary: "Send a test email to the admin's own address (instance admins, browser only)",
  description:
    "Sends a test email to the signed-in admin's own address through `ROOSTER_SMTP_URL` and waits for the SMTP server's answer. `409 mail_not_configured` without SMTP; `502 mail_failed` when the server refuses or cannot be reached (the detail names the SMTP code and status, never the server's text).",
  responses: {
    200: json(MailTestResultSchema, 'The SMTP server accepted the message'),
    ...problems(...AUTHED, 'forbidden', 'mail_not_configured', 'mail_failed'),
  },
});

export function registerAdminRoutes(
  app: OpenAPIHono<AppEnv>,
  { admin, backups, mail, search, system }: Services,
): void {
  app.openapi(getSystem, (c) => c.json(system.status(actorOf(c)), 200));
  app.openapi(reindexSearch, (c) => c.json(search.reindex(actorOf(c)), 200));
  app.openapi(testMail, async (c) => c.json(await mail.sendTest(actorOf(c)), 200));
  app.openapi(listBackups, (c) => c.json(backups.list(actorOf(c)), 200));
  app.openapi(createBackup, (c) => c.json(backups.createManual(actorOf(c)), 201));
  app.openapi(downloadBackup, (c) => {
    const file = backups.file(actorOf(c), c.req.valid('param').name);
    const stream = Readable.toWeb(createReadStream(file.path)) as ReadableStream<Uint8Array>;
    return c.body(stream, 200, {
      'Content-Type': 'application/vnd.sqlite3',
      'Content-Length': String(file.size),
      'Content-Disposition': `attachment; filename="${file.name}"`,
      'Cache-Control': 'no-store',
    });
  });
  app.openapi(listAllowlist, (c) => c.json(admin.listAllowlist(actorOf(c)), 200));
  app.openapi(addAllowlist, (c) =>
    c.json(admin.addAllowlist(actorOf(c), c.req.valid('json')), 201),
  );
  app.openapi(deleteAllowlist, (c) => {
    admin.removeAllowlist(actorOf(c), c.req.valid('param').id);
    return c.body(null, 204);
  });
  app.openapi(listUsers, (c) => c.json(admin.listUsers(actorOf(c)), 200));
  app.openapi(patchUser, (c) => {
    const { id } = c.req.valid('param');
    return c.json(admin.setDisabled(actorOf(c), id, c.req.valid('json').disabled), 200);
  });
}
