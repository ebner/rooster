import type { AdminJobRun, AdminSystem } from '@rooster/core/schemas';
import { DatabaseZap, MailCheck, RefreshCw } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Focusable } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../data/errors';
import { type DisplayPrefs, formatTimeAgo } from '../../lib/format';
import { Banner } from '../../ui/banner';
import { Button } from '../../ui/button';
import { Chip } from '../../ui/chip';
import { Skeleton } from '../../ui/skeleton';
import { Tooltip } from '../../ui/tooltip';
import { formatBytes } from '../attachments/model';
import { SettingsSection } from '../settings/settings-section';

export interface SystemSectionProps {
  /** Undefined while the first request runs. */
  system: AdminSystem | undefined;
  error: Error | null;
  isRefreshing?: boolean;
  onRefresh: () => void;
  prefs: DisplayPrefs;
  now: number;
  /** "Rebuild search index" (ADR 0013); left out where there is no server (kitchen sink). */
  reindex?: ReindexAction | undefined;
  /** "Send test email" (ADR 0059), shown when SMTP is configured. */
  mailTest?: MailTestAction | undefined;
}

export interface MailTestAction {
  /** Resolves with the admin's address once the mail server accepted it; throws otherwise. */
  onRun: () => Promise<{ to: string }>;
  online: boolean;
}

export interface ReindexAction {
  /** Resolves with what was indexed; throws on failure. */
  onRun: () => Promise<{ indexed: number; durationMs: number }>;
  /** Admin is online-only: offline, the action is disabled. */
  online: boolean;
  /** Kitchen sink: start with the confirmation open. */
  defaultConfirming?: boolean;
}

/** The full date and time of an instant in the viewer's zone and clock (hover and focus). */
export function formatAbsolute(instant: number, prefs: DisplayPrefs): string {
  return new Intl.DateTimeFormat(prefs.locale, {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: prefs.timezone,
    hourCycle: prefs.timeFormat === '12h' ? 'h12' : 'h23',
  }).format(instant);
}

/** "3 hours ago", with the exact time on hover and keyboard focus. */
function Instant({ at, prefs, now }: { at: number; prefs: DisplayPrefs; now: number }) {
  const { t } = useTranslation('admin');
  const absolute = formatAbsolute(at, prefs);
  return (
    <Tooltip content={absolute}>
      <Focusable>
        <time
          dateTime={new Date(at).toISOString()}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: focus shows the exact time (the tooltip), as hover does.
          tabIndex={0}
          className="rounded-xs underline decoration-border-strong decoration-dotted underline-offset-2 outline-none focus-ring:outline-2 focus-ring:outline-border-focus"
        >
          {formatTimeAgo(at, now, prefs.locale, t('system.justNow'))}
        </time>
      </Focusable>
    </Tooltip>
  );
}

function Item({ label, children, testId }: { label: string; children: ReactNode; testId: string }) {
  return (
    <div
      className="flex flex-col gap-0.5 border-b border-border py-2 tablet:flex-row tablet:items-baseline tablet:gap-6"
      data-testid={`system-${testId}`}
    >
      <dt className="shrink-0 text-sm text-text-secondary tablet:w-label-col">{label}</dt>
      <dd className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
        {children}
      </dd>
    </div>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-text-muted">{children}</span>;
}

function JobStatus({ run }: { run: AdminJobRun }) {
  const { t } = useTranslation('admin');
  if (run.lastStatus === null) return <Chip color="gray">{t('system.jobs.never')}</Chip>;
  return run.lastStatus === 'ok' ? (
    <Chip color="green">{t('system.jobs.ok')}</Chip>
  ) : (
    <Chip color="red">{t('system.jobs.failed')}</Chip>
  );
}

function JobsTable({
  jobs,
  prefs,
  now,
}: {
  jobs: readonly AdminJobRun[];
  prefs: DisplayPrefs;
  now: number;
}) {
  const { t } = useTranslation('admin');
  if (jobs.length === 0) return <p className="text-sm text-text-muted">{t('system.jobs.none')}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm" data-testid="system-jobs">
        <caption className="pb-2 text-start text-sm font-medium text-text-secondary">
          {t('system.jobs.title')}
        </caption>
        <thead>
          <tr className="border-b border-border text-xs text-text-muted">
            <th scope="col" className="py-2 pe-3 text-start font-medium">
              {t('system.jobs.job')}
            </th>
            <th scope="col" className="py-2 pe-3 text-start font-medium">
              {t('system.jobs.lastRun')}
            </th>
            <th scope="col" className="py-2 text-start font-medium">
              {t('system.jobs.status')}
            </th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((run) => (
            <tr key={run.job} className="border-b border-border align-top last:border-b-0">
              <th scope="row" className="py-2 pe-3 text-start font-mono text-xs font-normal">
                {run.job}
              </th>
              <td className="py-2 pe-3 text-text-secondary">
                {run.lastRunAt === null ? (
                  <Muted>–</Muted>
                ) : (
                  <Instant at={run.lastRunAt} prefs={prefs} now={now} />
                )}
              </td>
              <td className="py-2">
                <div className="flex flex-col items-start gap-1">
                  <JobStatus run={run} />
                  {run.lastError && (
                    <span className="font-mono text-xs break-all text-text-danger">
                      {run.lastError}
                    </span>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type MailTestState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'sent'; to: string }
  | { kind: 'failed'; detail: string | null };

/**
 * "Send test email" (`POST /admin/mail/test`): no confirmation, since it only ever goes to
 * the admin's own address; the result says where it went, or what the mail server answered.
 */
function MailTestControl({ action }: { action: MailTestAction }) {
  const { t } = useTranslation('admin');
  const [state, setState] = useState<MailTestState>({ kind: 'idle' });
  const run = async () => {
    setState({ kind: 'running' });
    try {
      const { to } = await action.onRun();
      setState({ kind: 'sent', to });
    } catch (err) {
      const mailFailed = err instanceof ApiError && err.code === 'mail_failed';
      setState({ kind: 'failed', detail: mailFailed ? err.message : null });
    }
  };
  return (
    <div className="flex w-full flex-col items-start gap-2 pt-1" data-testid="system-mail-test">
      <Button
        size="sm"
        icon={MailCheck}
        isLoading={state.kind === 'running'}
        isDisabled={!action.online}
        onPress={() => void run()}
      >
        {t('system.mailTest.action')}
      </Button>
      <p role="status" className="text-sm empty:hidden">
        {state.kind === 'sent' && t('system.mailTest.sent', { to: state.to })}
      </p>
      {state.kind === 'failed' && (
        <Banner tone="danger" role="alert">
          <span className="flex flex-col gap-1">
            <span>{t('system.mailTest.failed')}</span>
            {state.detail && <span className="font-mono text-xs">{state.detail}</span>}
          </span>
        </Banner>
      )}
    </div>
  );
}

type ReindexState =
  | { kind: 'idle' }
  | { kind: 'confirming' }
  | { kind: 'running' }
  | { kind: 'done'; indexed: number; durationMs: number }
  | { kind: 'failed' };

/**
 * "Rebuild search index" (`POST /admin/search/reindex`): asks inline first (02 §1, no modal),
 * then says how many tasks it indexed. Focus goes to Cancel on asking and back to the button.
 */
function ReindexControl({ action, locale }: { action: ReindexAction; locale: string }) {
  const { t } = useTranslation('admin');
  const [state, setState] = useState<ReindexState>(
    action.defaultConfirming ? { kind: 'confirming' } : { kind: 'idle' },
  );
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const asking = state.kind === 'confirming' || state.kind === 'running';
  const wasAsking = useRef(asking);
  useEffect(() => {
    if (wasAsking.current === asking) return;
    wasAsking.current = asking;
    if (asking) cancel.current?.focus();
    else trigger.current?.focus();
  }, [asking]);

  const run = async () => {
    setState({ kind: 'running' });
    try {
      const result = await action.onRun();
      setState({ kind: 'done', ...result });
    } catch {
      setState({ kind: 'failed' });
    }
  };
  const number = (n: number) => new Intl.NumberFormat(locale).format(n);

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-4" data-testid="system-reindex">
      <div className="flex flex-col gap-3 tablet:flex-row tablet:items-center tablet:justify-between">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-sm font-semibold">{t('system.reindex.title')}</p>
          <p className="text-sm text-text-secondary">{t('system.reindex.body')}</p>
        </div>
        <div className="shrink-0">
          <Button
            ref={trigger}
            icon={DatabaseZap}
            aria-expanded={asking}
            isDisabled={!action.online || asking}
            onPress={() => setState({ kind: 'confirming' })}
          >
            {t('system.reindex.action')}
          </Button>
        </div>
      </div>
      {!action.online && <p className="text-sm text-text-muted">{t('system.reindex.offline')}</p>}
      {asking && (
        <div className="flex flex-col gap-3 rounded-md bg-bg-subtle p-4">
          <p className="text-sm text-text-secondary">{t('system.reindex.confirmBody')}</p>
          <div className="flex justify-end gap-2">
            <Button
              ref={cancel}
              variant="ghost"
              isDisabled={state.kind === 'running'}
              onPress={() => setState({ kind: 'idle' })}
            >
              {t('system.reindex.cancel')}
            </Button>
            <Button
              variant="primary"
              icon={DatabaseZap}
              isLoading={state.kind === 'running'}
              isDisabled={!action.online}
              onPress={() => void run()}
            >
              {t('system.reindex.confirm')}
            </Button>
          </div>
        </div>
      )}
      <div role="status" className="text-sm empty:hidden">
        {state.kind === 'done' &&
          t('system.reindex.done', {
            count: state.indexed,
            ms: number(state.durationMs),
          })}
      </div>
      {state.kind === 'failed' && (
        <Banner tone="danger" role="alert">
          {t('system.reindex.failed')}
        </Banner>
      )}
    </div>
  );
}

/**
 * Admin → System (08 §9, ADR 0052 §7, AC-11.5): the instance at a glance. Online-only and read
 * when the page opens; "Refresh" reads it again.
 */
export function SystemSection({
  system,
  error,
  isRefreshing = false,
  onRefresh,
  prefs,
  now,
  reindex,
  mailTest,
}: SystemSectionProps) {
  const { t } = useTranslation('admin');
  const bytes = (n: number) => formatBytes(n, prefs.locale);
  const count = (n: number) => new Intl.NumberFormat(prefs.locale).format(n);

  let body: ReactNode;
  if (!system && error) {
    body = (
      <Banner tone="danger" role="alert">
        {t('system.failed')}
      </Banner>
    );
  } else if (!system) {
    body = (
      <div className="flex flex-col gap-3" role="status" aria-label={t('system.loading')}>
        {['a', 'b', 'c', 'd', 'e'].map((key) => (
          <Skeleton key={key} className="h-row w-full" />
        ))}
      </div>
    );
  } else {
    const { storage } = system;
    body = (
      <div className="flex flex-col gap-8">
        {error && (
          <Banner tone="warning" role="alert">
            {t('system.stale')}
          </Banner>
        )}
        <dl className="flex flex-col border-t border-border">
          <Item label={t('system.version')} testId="version">
            <span className="font-medium">{system.version}</span>
            {system.gitSha && (
              <span className="font-mono text-xs text-text-muted">
                {t('system.commit', { sha: system.gitSha.slice(0, 12) })}
              </span>
            )}
          </Item>
          <Item label={t('system.started')} testId="started">
            <Instant at={system.startedAt} prefs={prefs} now={now} />
          </Item>
          <Item label={t('system.database')} testId="database">
            <span>{bytes(system.database.sizeBytes)}</span>
            <Muted>{t('system.wal', { size: bytes(system.database.walSizeBytes) })}</Muted>
          </Item>
          <Item label={t('system.lastBackup')} testId="backup">
            {system.lastBackup ? (
              <>
                <Instant at={system.lastBackup.createdAt} prefs={prefs} now={now} />
                <Muted>{bytes(system.lastBackup.sizeBytes)}</Muted>
                <span className="w-full truncate font-mono text-xs text-text-muted">
                  {system.lastBackup.name}
                </span>
              </>
            ) : (
              <Muted>{t('system.noBackup')}</Muted>
            )}
          </Item>
          <Item label={t('system.smtp')} testId="smtp">
            <Chip color={system.smtp.configured ? 'green' : 'gray'}>
              {system.smtp.configured ? t('system.configured') : t('system.notConfigured')}
            </Chip>
            {system.smtp.configured && mailTest && <MailTestControl action={mailTest} />}
          </Item>
          <Item label={t('system.push')} testId="push">
            <Chip color={system.push.keySource === 'none' ? 'gray' : 'green'}>
              {t(`system.keySource.${system.push.keySource}`)}
            </Chip>
            <Muted>{t('system.subscriptions', { count: system.push.subscriptions })}</Muted>
          </Item>
          <Item label={t('system.sse')} testId="sse">
            <span className="tabular-nums">{count(system.sse.connections)}</span>
          </Item>
          <Item label={t('system.storage')} testId="storage">
            <span>
              {t('system.storageUsed', {
                size: bytes(storage.attachmentBytes),
                count: storage.attachmentCount,
              })}
            </span>
            <Muted>{t(`system.backend.${storage.backend}`)}</Muted>
            <span className="w-full text-text-muted">
              {storage.userQuotaBytes === null
                ? t('system.noQuota')
                : t('system.quota', { size: bytes(storage.userQuotaBytes) })}
            </span>
          </Item>
          <Item label={t('system.counts')} testId="counts">
            <span>{t('system.users', { count: system.counts.users })}</span>
            <Muted>·</Muted>
            <span>{t('system.orgs', { count: system.counts.orgs })}</span>
            <Muted>·</Muted>
            <span>{t('system.tasks', { count: system.counts.tasks })}</span>
          </Item>
        </dl>
        <JobsTable jobs={system.jobs} prefs={prefs} now={now} />
        {reindex && <ReindexControl action={reindex} locale={prefs.locale} />}
      </div>
    );
  }

  return (
    <SettingsSection
      id="system"
      title={t('system.title')}
      description={t('system.description')}
      actions={
        <Button size="sm" icon={RefreshCw} isLoading={isRefreshing} onPress={onRefresh}>
          {t('system.refresh')}
        </Button>
      }
    >
      <div aria-busy={isRefreshing || !system} data-testid="system-section">
        {body}
      </div>
    </SettingsSection>
  );
}
