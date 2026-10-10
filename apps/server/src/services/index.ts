import type { S3Client } from '@aws-sdk/client-s3';
import { BlobGc } from '../blob/gc.ts';
import { type BlobStores, createBlobStores } from '../blob/store.ts';
import { EventBus } from '../events/bus.ts';
import { JobBoard } from '../jobs/job-board.ts';
import { TaskQueue } from '../lib/task-queue.ts';
import { MailService } from '../mail/mail-service.ts';
import { type MailTransport, smtpTransport } from '../mail/transport.ts';
import { PushService } from '../push/push-service.ts';
import { type PushSender, webPushSender } from '../push/transport.ts';
import { VERSION } from '../version.ts';
import { ActivityService } from './activity-service.ts';
import { AdminService } from './admin-service.ts';
import { AttachmentService } from './attachment-service.ts';
import { AvatarService } from './avatar-service.ts';
import { BackupService } from './backup-service.ts';
import { CommentService } from './comment-service.ts';
import type { ServiceDeps } from './context.ts';
import { ExportService } from './export-service.ts';
import { FollowerService } from './follower-service.ts';
import { GrantService } from './grant-service.ts';
import { GroupService } from './group-service.ts';
import { IcalService } from './ical-service.ts';
import { IdempotencyStore } from './idempotency-store.ts';
import { IdentityService } from './identity-service.ts';
import { NotificationService } from './notification-service.ts';
import { OrderingService } from './ordering-service.ts';
import { OrgService, type OrgServiceOptions } from './org-service.ts';
import { PlacementService } from './placement-service.ts';
import { prefEnabled } from './pref-store.ts';
import { RecurrenceService } from './recurrence-service.ts';
import { ReminderService } from './reminder-service.ts';
import { RetentionService } from './retention-service.ts';
import { SearchService } from './search-service.ts';
import { SignInPolicy } from './sign-in-policy.ts';
import { SystemService } from './system-service.ts';
import { TagService } from './tag-service.ts';
import { expansionRemovalStep, TaskService } from './task-service.ts';
import { UserService } from './user-service.ts';

export interface Services {
  orgs: OrgService;
  users: UserService;
  admin: AdminService;
  signIn: SignInPolicy;
  /** PATs, CLI devices, OAuth apps and their grants (P8–P9, 11 §2). */
  grants: GrantService;
  /** Linked sign-in identities (P9, FR-SET-3). */
  identities: IdentityService;
  ordering: OrderingService;
  placements: PlacementService;
  groups: GroupService;
  tasks: TaskService;
  tags: TagService;
  search: SearchService;
  exports: ExportService;
  idempotency: IdempotencyStore;
  retention: RetentionService;
  backups: BackupService;
  activity: ActivityService;
  comments: CommentService;
  followers: FollowerService;
  notifications: NotificationService;
  push: PushService;
  mail: MailService;
  /** Push and email sends, outside requests and transactions (P7). */
  deliveries: TaskQueue;
  /** Domain events, published after commit (04 §4.5). */
  events: EventBus;
  // P10 services (tasks): recurrence, reminders.
  /** Recurring tasks: the stored rule and the next instance (FR-REC, ADR 0049 §1). */
  recurrence: RecurrenceService;
  /** Task reminders and the job that fires them (FR-REM, ADR 0049 §2). */
  reminders: ReminderService;
  // P10 services (files): blobs, attachments, avatars, calendar feeds.
  /** Attachment and avatar storage: local, or S3 with `ROOSTER_S3_BUCKET` (04 §4.8). */
  blobs: BlobStores;
  /** Deletes the blobs queued in `blob_gc` (ADR 0049 §3.6). */
  blobGc: BlobGc;
  /** Task attachments (FR-ATT). */
  attachments: AttachmentService;
  /** Uploaded avatars (FR-SET-1). */
  avatars: AvatarService;
  /** Calendar feeds (FR-CAL). */
  icalFeeds: IcalService;
  // P11 (ADR 0052 §7).
  /** The scheduler's last run of each job (`main.ts` hands it to the scheduler). */
  jobBoard: JobBoard;
  /** Admin → System. */
  system: SystemService;
}

/** Outbound transports; tests inject fakes. */
export interface DeliveryTransports {
  /** Default: `web-push`. */
  pushSender?: PushSender;
  /** Default: SMTP from `ROOSTER_SMTP_URL`, or none without it. */
  mailTransport?: MailTransport | null;
  /** P10: the S3 client of the blob store (tests inject one with a fake `send`). */
  s3Client?: S3Client;
}

/** P11: what Admin → System reads from outside the services. */
export interface SystemInputs {
  /** Open SSE streams; the hub is created after the services. */
  sseConnections?: () => number;
}

/** Push and email sends in flight at once. */
const DELIVERY_CONCURRENCY = 4;

export function createServices(
  input: Omit<ServiceDeps, 'events'> & { events?: EventBus } & DeliveryTransports & SystemInputs,
  options: OrgServiceOptions = {},
): Services {
  const { pushSender, mailTransport, s3Client, sseConnections, ...rest } = input;
  const deps: ServiceDeps = { ...rest, events: input.events ?? new EventBus(input.logger) };
  const ordering = new OrderingService();
  const placements = new PlacementService(deps, ordering);
  const idempotency = new IdempotencyStore(deps);
  const activity = new ActivityService(deps);
  const followers = new FollowerService(deps);
  const deliveries = new TaskQueue(DELIVERY_CONCURRENCY, deps.logger);
  const push = new PushService(deps, deliveries, pushSender ?? webPushSender);
  const smtp = deps.config.smtp;
  const mail = new MailService(
    deps,
    deliveries,
    mailTransport === undefined ? (smtp === null ? null : smtpTransport(smtp.url)) : mailTransport,
  );
  const notifications = new NotificationService(deps, {
    channels: (tx, userId, type) => ({
      push: prefEnabled(tx, userId, type, 'push') && push.hasSubscription(tx, userId),
      email: mail.enabled() && prefEnabled(tx, userId, type, 'email'),
    }),
    dispatch: (items) => {
      push.sendNotifications(items.filter((i) => i.push).map((i) => i.id));
      mail.sendImmediate(items.filter((i) => i.email).map((i) => i.id));
    },
  });
  const orgs = new OrgService(deps, {
    memberRemovalSteps: [
      // Before the unassignment: it logs the tasks the member is still assigned.
      activity.memberRemovalStep,
      placements.memberRemovalStep,
      expansionRemovalStep,
      followers.memberRemovalStep,
      notifications.memberRemovalStep,
      ...(options.memberRemovalSteps ?? []),
    ],
    onMemberJoined: (tx, joined) => {
      if (joined.inviterId !== null && joined.inviterId !== joined.userId) {
        notifications.inviteAccepted(tx, { ...joined, inviterId: joined.inviterId });
      }
    },
    onEmailInvite: (tx, invite) => mail.inviteCreated(tx, invite),
  });
  const search = new SearchService(deps);
  const users = new UserService(deps);
  // P10 construction (tasks).
  const reminders = new ReminderService(deps, notifications);
  const recurrence = new RecurrenceService(deps, ordering, placements, activity, reminders);
  // P10 construction (files).
  const blobs = createBlobStores(deps.config, s3Client);
  const blobGc = new BlobGc(deps.db, blobs, deps.logger);
  // Purging tasks (permanent delete, the trash purge) and deleting orgs cascade to their
  // attachments, whose trigger queues the blobs: free them now rather than at the next minute.
  deps.events.on((event) => {
    if (event.type === 'task.purged' || event.type === 'org.deleted') blobGc.kick();
  });
  const backups = new BackupService(deps);
  const jobBoard = new JobBoard();
  return {
    orgs,
    users,
    grants: new GrantService(
      deps,
      (userId, sessionId) => users.sessionActive(userId, sessionId),
      (actor) => notifications.unreadCountFor(actor),
    ),
    identities: new IdentityService(deps),
    admin: new AdminService(deps),
    signIn: new SignInPolicy(deps, orgs),
    ordering,
    placements,
    groups: new GroupService(deps, ordering, placements),
    tasks: new TaskService(deps, placements, ordering, search, {
      activity,
      followers,
      notifications,
      recurrence,
      reminders,
    }),
    tags: new TagService(deps),
    search,
    exports: new ExportService(deps),
    idempotency,
    retention: new RetentionService(deps, placements, idempotency, notifications),
    backups,
    activity,
    comments: new CommentService(deps, followers, notifications),
    followers,
    notifications,
    push,
    mail,
    deliveries,
    events: deps.events,
    // P10 (tasks).
    recurrence,
    reminders,
    // P10 (files).
    blobs,
    blobGc,
    attachments: new AttachmentService(deps, blobs, blobGc, activity),
    avatars: new AvatarService(deps, blobs, users),
    icalFeeds: new IcalService(deps, VERSION),
    jobBoard,
    system: new SystemService(deps, {
      version: VERSION,
      startedAt: deps.clock(),
      backups,
      blobs,
      jobs: jobBoard,
      sseConnections: sseConnections ?? (() => 0),
    }),
  };
}

export type { Actor, ActorGrant, OpMeta, ServiceDeps } from './context.ts';
