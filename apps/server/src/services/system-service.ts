import { statSync } from 'node:fs';
import type { AdminSystem } from '@rooster/core/schemas';
import { inArray, isNull, sql } from 'drizzle-orm';
import type { BlobStores } from '../blob/store.ts';
import {
  attachment,
  instanceSetting,
  organization,
  pushSubscription,
  task,
  user,
} from '../db/schema/index.ts';
import type { JobBoard } from '../jobs/job-board.ts';
import type { BackupService } from './backup-service.ts';
import { type Actor, readOnly, type ServiceDeps } from './context.ts';
import { requireAdminAccess } from './grant-access.ts';

export interface SystemServiceDeps {
  version: string;
  /** ms epoch the server started. */
  startedAt: number;
  backups: BackupService;
  blobs: BlobStores;
  jobs: JobBoard;
  /** Open SSE streams (the hub; created after the services). */
  sseConnections: () => number;
}

const COUNT = sql<number>`count(*)`;

const fileSize = (path: string): number => statSync(path, { throwIfNoEntry: false })?.size ?? 0;

/** Admin → System (08 §9, ADR 0052 §7): what an operator checks first. */
export class SystemService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly system: SystemServiceDeps,
  ) {}

  /** GET /admin/system. Instance admins only (and an admin PAT, like every admin route). */
  status(actor: Actor): AdminSystem {
    requireAdminAccess(actor);
    const { config } = this.deps;
    const backup = this.system.backups.latest();
    const db = readOnly(this.deps.db, (tx) => ({
      users: tx.select({ n: COUNT }).from(user).get()?.n ?? 0,
      orgs: tx.select({ n: COUNT }).from(organization).get()?.n ?? 0,
      tasks: tx.select({ n: COUNT }).from(task).where(isNull(task.deletedAt)).get()?.n ?? 0,
      pushSubscriptions: tx.select({ n: COUNT }).from(pushSubscription).get()?.n ?? 0,
      attachments: tx
        .select({ n: COUNT, bytes: sql<number>`coalesce(sum(${attachment.size}), 0)` })
        .from(attachment)
        .get(),
      generatedKeys:
        tx
          .select({ key: instanceSetting.key })
          .from(instanceSetting)
          .where(inArray(instanceSetting.key, ['vapid_public', 'vapid_private']))
          .all().length === 2,
    }));
    return {
      version: this.system.version,
      gitSha: config.gitSha === 'dev' ? null : config.gitSha,
      startedAt: this.system.startedAt,
      database: this.databaseSize(),
      lastBackup:
        backup === null
          ? null
          : { name: backup.name, createdAt: backup.createdAt, sizeBytes: backup.size },
      jobs: this.system.jobs.list(),
      smtp: { configured: config.smtp !== null },
      push: {
        keySource: config.vapid !== null ? 'env' : db.generatedKeys ? 'generated' : 'none',
        subscriptions: db.pushSubscriptions,
      },
      sse: { connections: this.system.sseConnections() },
      storage: {
        backend: this.system.blobs.current.kind,
        attachmentBytes: db.attachments?.bytes ?? 0,
        attachmentCount: db.attachments?.n ?? 0,
        userQuotaBytes: config.userStorageQuotaBytes,
      },
      counts: { users: db.users, orgs: db.orgs, tasks: db.tasks },
    };
  }

  /**
   * The database file and its WAL. An in-memory database (tests) has no files: its size is
   * the page count.
   */
  private databaseSize(): AdminSystem['database'] {
    const { sqlite } = this.deps.db;
    if (sqlite.memory) {
      const pages = sqlite.pragma('page_count', { simple: true }) as number;
      const pageSize = sqlite.pragma('page_size', { simple: true }) as number;
      return { sizeBytes: pages * pageSize, walSizeBytes: 0 };
    }
    return { sizeBytes: fileSize(sqlite.name), walSizeBytes: fileSize(`${sqlite.name}-wal`) };
  }
}
