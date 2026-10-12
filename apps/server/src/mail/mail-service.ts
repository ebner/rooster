import { type DateFormat, formatRelative, type TimeFormat } from '@rooster/core/dates';
import type { MailTestResult, UnsubscribeCategory } from '@rooster/core/schemas';
import type { Locale } from '@rooster/i18n';
import { and, asc, eq, gt, inArray, isNull, min, sql } from 'drizzle-orm';
import type { ReactElement } from 'react';
import { notification, organization, user } from '../db/schema/index.ts';
import { AppError } from '../lib/errors.ts';
import { logSafeError } from '../lib/log-safe-error.ts';
import type { TaskQueue } from '../lib/task-queue.ts';
import {
  type AssignedTask,
  dueContext,
  newInInbox,
  splitOverdue,
  tasksDueByToday,
  todayOrg,
} from '../services/assigned-tasks.ts';
import {
  type Actor,
  afterCommit,
  immediate,
  readOnly,
  type ServiceDeps,
  type Tx,
} from '../services/context.ts';
import { loadDeliverable, toDeliverable } from '../services/deliverable.ts';
import { requireAdminAccess, requireBrowserSession } from '../services/grant-access.ts';
import { claimJobRun, dueSlot, jobScope, lastUserRun } from '../services/job-runs.ts';
import {
  loadRecipient,
  prefEnabled,
  type Recipient,
  recipientsWithPref,
  setPref,
} from '../services/pref-store.ts';
import { type DescribedNotification, describeNotification } from './describe.ts';
import { instantDate, longDate, mailT } from './i18n.ts';
import { mailLogo } from './logo.ts';
import { renderMail } from './render.ts';
import { DigestEmail, type DigestSection } from './templates/digest.tsx';
import { InviteEmail } from './templates/invite.tsx';
import { type ListItem, logoCid, type UnsubscribeLink } from './templates/layout.tsx';
import { BatchEmail, NotificationEmail } from './templates/notifications.tsx';
import { ReminderEmail } from './templates/reminder.tsx';
import { TestEmail } from './templates/test.tsx';
import { type InlineImage, type MailTransport, SmtpSendError } from './transport.ts';
import { parseUnsubscribeToken, unsubscribeToken } from './unsubscribe-token.ts';

/** FR-NOT-3: batched notification emails go out once the oldest waited this long. */
export const BATCH_WAIT_MS = 15 * 60_000;
/** Pending notifications older than this are given up on (a failing address, SMTP down). */
export const BATCH_GIVE_UP_MS = 24 * 3_600_000;
/** Tasks listed per digest section before "and N more". */
export const DIGEST_SECTION_MAX = 10;

export const DIGEST_JOB = 'digest';

const logoImage: InlineImage = {
  cid: logoCid,
  filename: 'rooster.png',
  contentType: 'image/png',
  content: Buffer.from(mailLogo.png, 'base64'),
};

/** A user's email jobs share one delivery-queue key (lib/task-queue.ts). */
const mailKey = (userId: string) => `mail:${userId}`;

const DAY_MS = 86_400_000;

/** The batch job's queue: the same predicate as the `notification_email_pending` index. */
const emailPending = sql`${notification.emailedAt} IS NULL AND json_extract(${notification.data}, '$.emailPending') = 1`;

/** An email invite as OrgService hands it over, inside its transaction. */
export interface EmailInvite {
  email: string;
  orgId: string;
  inviterId: string;
  url: string;
  expiresAt: number;
}

/**
 * Email (FR-NOT-3, FR-ORG-3): invites, notifications at once or batched, the daily digest and
 * unsubscribe links. Only active with `ROOSTER_SMTP_URL`; without it nothing is queued and no
 * job sends (AC-7.3).
 */
export class MailService {
  private readonly host: string;

  constructor(
    private readonly deps: ServiceDeps,
    private readonly queue: TaskQueue,
    private readonly transport: MailTransport | null,
  ) {
    this.host = new URL(deps.config.baseUrl).host;
  }

  enabled(): boolean {
    return this.transport !== null && this.deps.config.smtp !== null;
  }

  private url(path: string): string {
    return `${this.deps.config.baseUrl}${path}`;
  }

  private unsubscribeUrl(userId: string, category: UnsubscribeCategory): string {
    return this.url(
      `/unsubscribe/${unsubscribeToken(this.deps.config.authSecret, userId, category)}`,
    );
  }

  private links(
    recipient: Recipient,
    categories: readonly UnsubscribeCategory[],
  ): UnsubscribeLink[] {
    const t = mailT(recipient.locale);
    return [...new Set(categories)].map((category) => ({
      label: t('footer.unsubscribe', { category: t(`category.${category}`) }),
      url: this.unsubscribeUrl(recipient.id, category),
    }));
  }

  private frame(recipient: Recipient, categories: readonly UnsubscribeCategory[]) {
    return {
      locale: recipient.locale,
      t: mailT(recipient.locale),
      host: this.host,
      unsubscribe: this.links(recipient, categories),
      settingsUrl: this.url('/settings/notifications'),
    };
  }

  /**
   * Sends one message. RFC 8058: `List-Unsubscribe` points at the first category's one-click
   * URL (the footer has one link per category).
   */
  private async send(input: {
    to: string;
    subject: string;
    element: ReactElement;
    unsubscribe?: { userId: string; category: UnsubscribeCategory };
  }): Promise<void> {
    const transport = this.transport;
    const smtp = this.deps.config.smtp;
    if (transport === null || smtp === null) return;
    const { html, text } = await renderMail(input.element);
    const headers: Record<string, string> = { 'Auto-Submitted': 'auto-generated' };
    if (input.unsubscribe !== undefined) {
      const { userId, category } = input.unsubscribe;
      headers['List-Unsubscribe'] = `<${this.unsubscribeUrl(userId, category)}>`;
      headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    }
    await transport.send({
      from: smtp.from,
      to: input.to,
      subject: input.subject,
      html,
      text,
      headers,
      inline: [logoImage],
    });
  }

  // --- the admin's test ------------------------------------------------------------------

  /**
   * POST /admin/mail/test (ADR 0059): a test email to the signed-in admin's own address, and
   * the SMTP server's verdict. Only ever to the caller, so it cannot mail anyone else; a
   * refusal is `502 mail_failed` with the shape-checked SMTP code and status only.
   */
  async sendTest(actor: Actor): Promise<MailTestResult> {
    requireBrowserSession(actor);
    requireAdminAccess(actor);
    if (!this.enabled()) {
      throw new AppError(
        'mail_not_configured',
        409,
        'Email is off: set ROOSTER_SMTP_URL and ROOSTER_MAIL_FROM.',
      );
    }
    const recipient = readOnly(this.deps.db, (tx) => loadRecipient(tx, actor.userId));
    if (recipient === null) throw new AppError('not_found', 404, 'Not found.');
    const t = mailT(recipient.locale);
    const now = this.deps.clock();
    const outcome = await this.queue.run(
      'mail-test',
      async () => {
        try {
          await this.send({
            to: recipient.email,
            subject: t('test.subject'),
            element: TestEmail({
              locale: recipient.locale,
              t,
              host: this.host,
              unsubscribe: [],
              settingsUrl: this.url('/settings/notifications'),
              sentBy: recipient.name,
              when: instantDate(recipient.locale, now, recipient.timezone),
              url: this.url('/admin'),
            }),
          });
          return { ok: true as const };
        } catch (err) {
          return { ok: false as const, err };
        }
      },
      mailKey(actor.userId),
    );
    if (outcome?.ok !== true) {
      const err = outcome?.err;
      const reason = err instanceof SmtpSendError ? ` (${err.message})` : '';
      if (err !== undefined) {
        this.deps.logger.warn({ err: logSafeError(err) }, 'test email failed');
      }
      throw new AppError(
        'mail_failed',
        502,
        `The mail server did not accept the message${reason}. The server log has the details.`,
      );
    }
    return { to: recipient.email, sentAt: now };
  }

  // --- invites --------------------------------------------------------------------------

  /**
   * Called by OrgService inside the invite's transaction: queues the invite email for after
   * commit. Returns whether an email will go out (`emailed` in the response). The invitee
   * usually has no account yet, so the email is in the inviter's language unless the address
   * belongs to an existing user.
   */
  inviteCreated(tx: Tx, invite: EmailInvite): boolean {
    if (!this.enabled()) return false;
    const inviter = loadRecipient(tx, invite.inviterId);
    const existing = tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, invite.email))
      .get();
    const invitee = existing === undefined ? null : loadRecipient(tx, existing.id);
    const org = tx
      .select({ name: organization.name })
      .from(organization)
      .where(eq(organization.id, invite.orgId))
      .get();
    if (org === undefined) return false;
    const locale: Locale = invitee?.locale ?? inviter?.locale ?? 'en';
    const timezone = invitee?.timezone ?? inviter?.timezone ?? 'UTC';
    const inviterName = inviter?.name ?? null;
    afterCommitSend(tx, () =>
      this.queue.run(
        'mail-invite',
        async () => {
          const t = mailT(locale);
          await this.send({
            to: invite.email,
            subject:
              inviterName === null
                ? t('invite.subjectAnonymous', { org: org.name })
                : t('invite.subject', { inviter: inviterName, org: org.name }),
            element: InviteEmail({
              locale,
              t,
              host: this.host,
              inviter: inviterName,
              org: org.name,
              url: invite.url,
              expires: instantDate(locale, invite.expiresAt, timezone),
            }),
          });
        },
        // Invites count against the inviter's email jobs.
        mailKey(invite.inviterId),
      ),
    );
    return true;
  }

  // --- notifications --------------------------------------------------------------------

  /**
   * After commit: the new notifications that wait for an email. Recipients with
   * `emailMode: 'immediate'` get one email each now; batch recipients are left to the batch
   * job. A failed immediate send stays pending, so the batch job retries it.
   */
  sendImmediate(items: readonly { id: string; userId: string }[]): void {
    if (!this.enabled()) return;
    for (const { id, userId } of items) {
      void this.queue.run('mail-notification', () => this.sendOne(id), mailKey(userId));
    }
  }

  private async sendOne(id: string): Promise<void> {
    const now = this.deps.clock();
    const claimed = immediate(this.deps.db, (tx) => {
      const found = loadDeliverable(tx, id);
      if (found === null) return null;
      // A task reminder is time-bound: it never waits for the batch (ADR 0049 §2.3).
      const timeBound = found.notification.type === 'reminder';
      if (!timeBound && found.recipient.prefs.emailMode !== 'immediate') return null;
      if (!prefEnabled(tx, found.recipient.id, found.notification.type, 'email')) return null;
      const pending = tx
        .update(notification)
        .set({ emailedAt: now })
        .where(and(eq(notification.id, id), emailPending))
        .run().changes;
      return pending === 1 ? found : null;
    });
    if (claimed === null) return;
    const { recipient } = claimed;
    const t = mailT(recipient.locale);
    const item = describeNotification(claimed.notification, recipient, t, now);
    try {
      if (claimed.notification.type === 'reminder') {
        await this.send({
          to: recipient.email,
          subject: t('reminder.subject', { title: item.subject }),
          element: ReminderEmail({
            ...this.frame(recipient, ['reminder']),
            item,
            url: this.url(item.path),
          }),
          unsubscribe: { userId: recipient.id, category: 'reminder' },
        });
        return;
      }
      await this.send({
        to: recipient.email,
        subject:
          claimed.notification.taskId === null ? item.event : `${item.event}: ${item.subject}`,
        element: NotificationEmail({
          ...this.frame(recipient, [claimed.notification.type]),
          item,
          url: this.url(item.path),
        }),
        unsubscribe: { userId: recipient.id, category: claimed.notification.type },
      });
    } catch (err) {
      releaseEmails(this.deps, [id], now);
      throw err;
    }
  }

  /**
   * The email batch job (every 5 minutes; FR-NOT-3): each user whose oldest pending
   * notification waited 15 minutes gets everything pending in one email. Cells switched off
   * since are left out. Resolves after the sends.
   */
  async runBatches(): Promise<number> {
    if (!this.enabled()) return 0;
    const now = this.deps.clock();
    const users = readOnly(this.deps.db, (tx) =>
      tx
        .select({ userId: notification.userId, oldest: min(notification.createdAt) })
        .from(notification)
        .where(and(emailPending, gt(notification.createdAt, now - BATCH_GIVE_UP_MS)))
        .groupBy(notification.userId)
        .all()
        .filter((r) => r.oldest !== null && r.oldest <= now - BATCH_WAIT_MS)
        .map((r) => r.userId),
    );
    const sent = await Promise.all(
      users.map((userId) =>
        this.queue.run('mail-batch', () => this.sendBatch(userId, now), mailKey(userId)),
      ),
    );
    return sent.filter((s) => s === true).length;
  }

  private async sendBatch(userId: string, now: number): Promise<boolean> {
    const batch = immediate(this.deps.db, (tx) => {
      const recipient = loadRecipient(tx, userId);
      if (recipient === null) return null;
      const rows = tx
        .select({ row: notification, name: organization.name, slug: organization.slug })
        .from(notification)
        .innerJoin(organization, eq(organization.id, notification.orgId))
        .where(
          and(
            eq(notification.userId, userId),
            emailPending,
            gt(notification.createdAt, now - BATCH_GIVE_UP_MS),
            isNull(organization.deletedAt),
          ),
        )
        .orderBy(asc(notification.createdAt), asc(notification.id))
        .all()
        .map((r) => toDeliverable(r.row, r))
        .filter((n) => prefEnabled(tx, userId, n.type, 'email'));
      if (rows.length === 0) return null;
      // Read and claimed in one synchronous transaction: nothing can claim them in between.
      tx.update(notification)
        .set({ emailedAt: now })
        .where(
          inArray(
            notification.id,
            rows.map((r) => r.id),
          ),
        )
        .run();
      return { recipient, rows };
    });
    if (batch === null) return false;
    const { recipient, rows } = batch;
    const t = mailT(recipient.locale);
    const items = rows.map((n) => ({
      ...describeNotification(n, recipient, t, now),
      key: n.id,
      type: n.type,
    }));
    const first = rows[0];
    if (first === undefined) return false;
    const categories = rows.map((r) => r.type);
    const frame = this.frame(recipient, categories);
    try {
      if (items.length === 1 && items[0] !== undefined) {
        const item: DescribedNotification = items[0];
        await this.send({
          to: recipient.email,
          subject: first.taskId === null ? item.event : `${item.event}: ${item.subject}`,
          element: NotificationEmail({ ...frame, item, url: this.url(item.path) }),
          unsubscribe: { userId, category: first.type },
        });
      } else {
        await this.send({
          to: recipient.email,
          subject: t('batch.subject', { count: items.length }),
          element: BatchEmail({
            ...frame,
            items: items.map((i) => ({ ...i, url: this.url(i.path) })),
            inboxUrl: this.url('/inbox'),
          }),
          unsubscribe: { userId, category: first.type },
        });
      }
    } catch (err) {
      releaseEmails(
        this.deps,
        rows.map((r) => r.id),
        now,
      );
      throw err;
    }
    return true;
  }

  // --- the daily digest -----------------------------------------------------------------

  /**
   * The per-minute digest job (FR-NOT-3): at `prefs.digestTime` local (within the grace
   * window, claimed per local date), every user with the digest on gets overdue, due today
   * and new in the Inbox since their previous digest, across their orgs. An empty digest is
   * not sent. Resolves after the sends.
   */
  async runDigests(): Promise<number> {
    if (!this.enabled()) return 0;
    const now = this.deps.clock();
    // Only who and which day are claimed here. The content is read when the send leaves the
    // queue, which may be much later: membership, access and the account are as of then.
    const due = immediate(this.deps.db, (tx) => {
      const out: { userId: string; date: string; since: number }[] = [];
      for (const recipient of recipientsWithPref(tx, 'digest', 'email')) {
        try {
          const slot = dueSlot(now, recipient.timezone, recipient.prefs.digestTime);
          if (slot === null) continue;
          const scope = jobScope(recipient.id, slot.date);
          const since = lastUserRun(tx, DIGEST_JOB, recipient.id, scope) ?? now - DAY_MS;
          if (!claimJobRun(tx, DIGEST_JOB, scope, now)) continue;
          out.push({ userId: recipient.id, date: slot.date, since });
        } catch (err) {
          this.deps.logger.warn({ err: logSafeError(err), userId: recipient.id }, 'digest skipped');
        }
      }
      return out;
    });
    const sent = await Promise.all(
      due.map((d) =>
        this.queue.run(
          'mail-digest',
          () => this.sendDigestOf(d.userId, d.date, d.since, now),
          mailKey(d.userId),
        ),
      ),
    );
    return sent.filter((s) => s === true).length;
  }

  /** Reads one claimed digest as of now and sends it; false when there is nothing to send. */
  private async sendDigestOf(
    userId: string,
    date: string,
    since: number,
    now: number,
  ): Promise<boolean> {
    const digest = readOnly(this.deps.db, (tx) => {
      const recipient = loadRecipient(tx, userId);
      if (recipient === null || !prefEnabled(tx, userId, 'digest', 'email')) return null;
      const content = this.digestOf(tx, recipient, now, since, date);
      return content === null ? null : { recipient, ...content };
    });
    if (digest === null) return false;
    await this.sendDigest(digest.recipient, date, digest.sections, digest.todayPath);
    return true;
  }

  /** The digest's sections, or null when all are empty. */
  private digestOf(
    tx: Tx,
    recipient: Recipient,
    now: number,
    since: number,
    date: string,
  ): { sections: DigestSection[]; todayPath: string } | null {
    // The day the digest is for (its claimed slot), also when it is caught up after midnight.
    const ctx = dueContext(recipient.timezone, now, date);
    const today = tasksDueByToday(tx, recipient.id, ctx);
    const { overdue, dueToday } = splitOverdue(today, ctx);
    const listed = new Set(today.map((t) => t.id));
    const inbox = newInInbox(tx, recipient.id, since).filter((t) => !listed.has(t.id));
    const all = [...overdue, ...dueToday, ...inbox];
    if (all.length === 0) return null;
    const showOrg = new Set(all.map((t) => t.orgId)).size > 1;
    const format = {
      today: ctx.today,
      locale: recipient.locale,
      dateFormat: recipient.dateFormat as DateFormat,
      timeFormat: recipient.timeFormat as TimeFormat,
    };
    const item = (task: AssignedTask): ListItem => {
      const meta = [
        ...(task.dueDate === null
          ? []
          : [formatRelative({ dueDate: task.dueDate, dueTime: task.dueTime }, format)]),
        ...(showOrg ? [task.orgName] : []),
      ];
      return {
        key: task.id,
        title: task.title,
        url: this.url(`/o/${task.orgSlug}/t/${task.id}`),
        ...(meta.length === 0 ? {} : { meta: meta.join(' · ') }),
      };
    };
    const section = (id: DigestSection['id'], tasks: AssignedTask[]): DigestSection[] =>
      tasks.length === 0
        ? []
        : [
            {
              id,
              items: tasks.slice(0, DIGEST_SECTION_MAX).map(item),
              more: Math.max(0, tasks.length - DIGEST_SECTION_MAX),
            },
          ];
    const org = todayOrg(tx, recipient.id, today);
    return {
      sections: [
        ...section('overdue', overdue),
        ...section('dueToday', dueToday),
        ...section('inbox', inbox),
      ],
      todayPath: org === null ? '/' : `/o/${org.slug}/today`,
    };
  }

  /** Renders and sends one digest. */
  private async sendDigest(
    recipient: Recipient,
    date: string,
    sections: DigestSection[],
    todayPath: string,
  ): Promise<void> {
    const t = mailT(recipient.locale);
    await this.send({
      to: recipient.email,
      subject: t('digest.subject', { date: longDate(recipient.locale, date) }),
      element: this.digestElement(recipient, date, sections, todayPath),
      unsubscribe: { userId: recipient.id, category: 'digest' },
    });
  }

  private digestElement(
    recipient: Recipient,
    date: string,
    sections: DigestSection[],
    todayPath: string,
  ) {
    return DigestEmail({
      ...this.frame(recipient, ['digest']),
      date: longDate(recipient.locale, date),
      sections,
      todayUrl: this.url(todayPath),
    });
  }

  // --- unsubscribe ----------------------------------------------------------------------

  /**
   * GET /unsubscribe/:token: what the link would turn off, without changing anything. Mail
   * gateways (Outlook Safe Links and the like) open links in advance, so only the POST acts.
   * Null for a forged or malformed token, or a deleted user.
   */
  checkUnsubscribe(token: string): { category: UnsubscribeCategory; locale: Locale } | null {
    return readOnly(this.deps.db, (tx) => this.resolveUnsubscribe(tx, token));
  }

  /**
   * POST /unsubscribe/:token (the page's button, or RFC 8058 one-click): turns off exactly
   * that category's email cell. Idempotent.
   */
  unsubscribe(token: string): { category: UnsubscribeCategory; locale: Locale } | null {
    return immediate(this.deps.db, (tx) => {
      const found = this.resolveUnsubscribe(tx, token);
      if (found !== null) setPref(tx, found.userId, found.category, 'email', false);
      return found === null ? null : { category: found.category, locale: found.locale };
    });
  }

  private resolveUnsubscribe(tx: Tx, token: string) {
    const parsed = parseUnsubscribeToken(this.deps.config.authSecret, token);
    if (parsed === null) return null;
    const row = tx
      .select({ locale: user.locale })
      .from(user)
      .where(eq(user.id, parsed.userId))
      .get();
    if (row === undefined) return null;
    const locale: Locale = row.locale === 'sv' ? 'sv' : 'en';
    return { ...parsed, locale };
  }
}

/** A failed send gives its claim back, so the batch job retries it. */
function releaseEmails(deps: ServiceDeps, ids: readonly string[], claimedAt: number): void {
  immediate(deps.db, (tx) => {
    tx.update(notification)
      .set({ emailedAt: null })
      .where(and(inArray(notification.id, [...ids]), eq(notification.emailedAt, claimedAt)))
      .run();
  });
}

function afterCommitSend(tx: Tx, send: () => unknown): void {
  afterCommit(tx, () => {
    void send();
  });
}
