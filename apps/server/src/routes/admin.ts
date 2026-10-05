import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../lib/context.ts';
import type { Services } from '../services/index.ts';
import { AUTHED, actorOf, body, idParam, json, problems } from './common.ts';
import {
  AdminUserPatchSchema,
  AdminUserSchema,
  AllowlistCreateSchema,
  AllowlistEntrySchema,
  BackupSchema,
} from './schemas.ts';

const tags = ['admin'];

const listAllowlist = createRoute({
  method: 'get',
  path: '/api/v1/admin/allowlist',
  tags,
  operationId: 'listAllowlist',
  summary: 'Sign-in allowlist entries (instance admins)',
  responses: { 200: json(z.array(AllowlistEntrySchema), 'Entries'), ...problems(401, 403) },
});

const addAllowlist = createRoute({
  method: 'post',
  path: '/api/v1/admin/allowlist',
  tags,
  operationId: 'addAllowlistEntry',
  summary: 'Allow an email address or a whole domain to sign in (instance admins)',
  request: { body: body(AllowlistCreateSchema) },
  responses: { 201: json(AllowlistEntrySchema, 'The entry'), ...problems(...AUTHED, 409) },
});

const deleteAllowlist = createRoute({
  method: 'delete',
  path: '/api/v1/admin/allowlist/{id}',
  tags,
  operationId: 'removeAllowlistEntry',
  summary: 'Remove an allowlist entry (instance admins)',
  request: { params: z.object({ id: idParam('id', 'Entry ID') }) },
  responses: { 204: { description: 'Removed' }, ...problems(...AUTHED, 404) },
});

const listUsers = createRoute({
  method: 'get',
  path: '/api/v1/admin/users',
  tags,
  operationId: 'listUsers',
  summary: 'All users of the instance (instance admins)',
  responses: { 200: json(z.array(AdminUserSchema), 'Users, newest first'), ...problems(401, 403) },
});

const patchUser = createRoute({
  method: 'patch',
  path: '/api/v1/admin/users/{id}',
  tags,
  operationId: 'updateUser',
  summary: 'Deactivate or reactivate a user (instance admins)',
  description: 'Deactivating signs the user out everywhere.',
  request: { params: z.object({ id: idParam('id', 'User ID') }), body: body(AdminUserPatchSchema) },
  responses: { 200: json(AdminUserSchema, 'The user'), ...problems(...AUTHED, 404, 409) },
});

const listBackups = createRoute({
  method: 'get',
  path: '/api/v1/admin/backups',
  tags,
  operationId: 'listBackups',
  summary: 'Database snapshots, newest first (instance admins)',
  responses: { 200: json(z.array(BackupSchema), 'Backups'), ...problems(401, 403, 429) },
});

const createBackup = createRoute({
  method: 'post',
  path: '/api/v1/admin/backups',
  tags,
  operationId: 'createBackup',
  summary: 'Take a snapshot now (instance admins)',
  responses: { 201: json(BackupSchema, 'The new backup'), ...problems(...AUTHED) },
});

const downloadBackup = createRoute({
  method: 'get',
  path: '/api/v1/admin/backups/{name}',
  tags,
  operationId: 'downloadBackup',
  summary: 'Download a snapshot (instance admins)',
  description: 'Only names from the list are accepted; anything else is 404.',
  request: { params: z.object({ name: idParam('name', 'Backup file name') }) },
  responses: {
    200: {
      description: 'The SQLite database file',
      content: { 'application/vnd.sqlite3': { schema: z.string().openapi({ format: 'binary' }) } },
    },
    ...problems(401, 403, 404, 429),
  },
});

export function registerAdminRoutes(app: OpenAPIHono<AppEnv>, { admin, backups }: Services): void {
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
