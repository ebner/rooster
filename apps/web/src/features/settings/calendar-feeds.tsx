import type { IcalFeed, IcalFeedCreate, IcalFeedCreated } from '@rooster/core/schemas';
import { CalendarDays, Copy, Plus } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { Input } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { type DisplayPrefs, formatDay, formatTimeAgo } from '../../lib/format';
import { Banner } from '../../ui/banner';
import { Button, buttonVariants, iconStrokeWidth } from '../../ui/button';
import { inputVariants } from '../../ui/input';
import { Select } from '../../ui/select';
import { SettingsSection } from './settings-section';

/** ADR 0049 §4.1: at most 10 feeds per user (`POST` answers 409 beyond that). */
export const icalFeedsMax = 10;

export interface FeedOrg {
  id: string;
  name: string;
}

export type CalendarFeedsMode =
  | { kind: 'idle' }
  | { kind: 'creating' }
  | { kind: 'created'; created: IcalFeedCreated }
  | { kind: 'confirming'; id: string; action: 'revoke' | 'regenerate' };

export interface CalendarFeedsSectionProps {
  /** Undefined while loading. */
  feeds: readonly IcalFeed[] | undefined;
  error?: unknown;
  /** The user's orgs, in sidebar order. */
  orgs: readonly FeedOrg[];
  prefs: DisplayPrefs;
  now: number;
  online: boolean;
  /** Resolves with the feed and its URL (shown once), or rejects (the caller reports it). */
  onCreate: (input: IcalFeedCreate) => Promise<IcalFeedCreated>;
  onRevoke: (id: string) => Promise<void>;
  /** Kitchen sink: start in a given state. */
  initialMode?: CalendarFeedsMode | undefined;
}

/** `webcal://` opens the system's calendar app with a subscription (FR-CAL-1). */
export function webcalUrl(url: string): string {
  return url.replace(/^https?:\/\//i, 'webcal://');
}

const allOrgs = 'all';

/**
 * Settings → Calendar feed (FR-CAL, ADR 0049 §4): the user's feeds (one org or all of them),
 * each with a secret URL shown once on creation, regenerated (`replaces`) or revoked with an
 * inline confirm. Online-only (hard rule 4).
 */
export function CalendarFeedsSection({
  feeds,
  error,
  orgs,
  prefs,
  now,
  online,
  onCreate,
  onRevoke,
  initialMode,
}: CalendarFeedsSectionProps) {
  const { t } = useTranslation('calendar');
  const [mode, setMode] = useState<CalendarFeedsMode>(initialMode ?? { kind: 'idle' });
  const idle = () => setMode({ kind: 'idle' });
  const full = (feeds?.length ?? 0) >= icalFeedsMax;
  const nameOf = (orgId: string | null) =>
    orgId === null ? t('allOrgs') : (orgs.find((org) => org.id === orgId)?.name ?? t('unknownOrg'));
  const ordered = [...(feeds ?? [])].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <SettingsSection
      title={t('title')}
      description={t('body')}
      isPageTitle
      actions={
        mode.kind !== 'creating' && (
          <Button
            icon={Plus}
            onPress={() => setMode({ kind: 'creating' })}
            isDisabled={!online || full || feeds === undefined}
            data-testid="new-feed"
          >
            {t('new')}
          </Button>
        )
      }
    >
      {!online && <Banner>{t('offline')}</Banner>}
      {full && mode.kind !== 'created' && (
        <p className="text-sm text-text-muted">{t('limit', { max: icalFeedsMax })}</p>
      )}
      {mode.kind === 'creating' && (
        <NewFeedForm
          orgs={orgs}
          onCancel={idle}
          onCreate={async (input) => setMode({ kind: 'created', created: await onCreate(input) })}
        />
      )}
      {mode.kind === 'created' && (
        <FeedReveal
          created={mode.created}
          name={nameOf(mode.created.feed.orgId)}
          onDone={idle}
          autoFocus={mode !== initialMode}
        />
      )}
      {error ? (
        <Banner tone="danger" role="alert">
          {t('loadFailed')}
        </Banner>
      ) : feeds && ordered.length === 0 ? (
        mode.kind === 'idle' && <p className="text-sm text-text-muted">{t('empty')}</p>
      ) : (
        <ul className="flex flex-col" data-testid="calendar-feeds">
          {ordered.map((feed) => (
            <FeedRow
              key={feed.id}
              feed={feed}
              name={nameOf(feed.orgId)}
              prefs={prefs}
              now={now}
              online={online}
              mode={mode}
              setMode={setMode}
              onRevoke={onRevoke}
              onRegenerate={async () => {
                const created = await onCreate({
                  ...(feed.orgId ? { orgId: feed.orgId } : {}),
                  replaces: feed.id,
                });
                setMode({ kind: 'created', created });
              }}
            />
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}

function NewFeedForm({
  orgs,
  onCancel,
  onCreate,
}: {
  orgs: readonly FeedOrg[];
  onCancel: () => void;
  onCreate: (input: IcalFeedCreate) => Promise<void>;
}) {
  const { t } = useTranslation('calendar');
  const [scope, setScope] = useState<string>(allOrgs);
  const [pending, setPending] = useState(false);
  return (
    <InlinePanel onEscape={onCancel}>
      <form
        className="flex flex-col gap-4 rounded-md border border-border bg-bg-elevated p-4"
        data-testid="new-feed-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setPending(true);
          try {
            await onCreate(scope === allOrgs ? {} : { orgId: scope });
          } catch {
            // Reported by the caller; the form stays open to retry.
          } finally {
            setPending(false);
          }
        }}
      >
        <Select
          label={t('scope')}
          options={[
            { id: allOrgs, label: t('allOrgs') },
            ...orgs.map((org) => ({ id: org.id, label: org.name })),
          ]}
          value={scope}
          onChange={setScope}
          className="max-w-pane-min"
        />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" isLoading={pending} data-testid="create-feed">
            {t('create')}
          </Button>
          <Button onPress={onCancel}>{t('cancel')}</Button>
        </div>
      </form>
    </InlinePanel>
  );
}

/** The new feed's URL, once: copy it or subscribe now; it is never shown again. */
export function FeedReveal({
  created,
  name,
  onDone,
  autoFocus = true,
}: {
  created: IcalFeedCreated;
  name: string;
  onDone: () => void;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation('calendar');
  const [copied, setCopied] = useState(false);
  const fieldRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!autoFocus) return;
    fieldRef.current?.focus();
    fieldRef.current?.select();
  }, [autoFocus]);
  return (
    <div
      className="flex flex-col gap-3 rounded-md border border-border bg-bg-elevated p-4"
      data-testid="feed-reveal"
    >
      <p className="text-sm font-medium">{t('reveal.title', { name })}</p>
      <Banner tone="warning">{t('reveal.secret')}</Banner>
      <div className="flex flex-col gap-2 tablet:flex-row">
        <Input
          ref={fieldRef}
          readOnly
          value={created.url}
          aria-label={t('reveal.label')}
          className={cn(inputVariants(), 'min-w-0 flex-1 font-mono')}
          onFocus={(event) => event.currentTarget.select()}
          data-testid="feed-url"
        />
        <Button
          icon={Copy}
          onPress={async () => {
            try {
              await navigator.clipboard.writeText(created.url);
              setCopied(true);
            } catch {
              fieldRef.current?.select();
            }
          }}
          data-testid="copy-feed"
        >
          {copied ? t('reveal.copied') : t('reveal.copy')}
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <a
          href={webcalUrl(created.url)}
          className={cn(
            buttonVariants({ variant: 'secondary' }),
            'outline-none focus-visible:outline-2 focus-visible:outline-border-focus',
          )}
          data-testid="subscribe-feed"
        >
          <CalendarDays className="size-4" strokeWidth={iconStrokeWidth} aria-hidden />
          {t('reveal.subscribe')}
        </a>
        <Button variant="primary" onPress={onDone}>
          {t('reveal.done')}
        </Button>
      </div>
    </div>
  );
}

function FeedRow({
  feed,
  name,
  prefs,
  now,
  online,
  mode,
  setMode,
  onRevoke,
  onRegenerate,
}: {
  feed: IcalFeed;
  name: string;
  prefs: DisplayPrefs;
  now: number;
  online: boolean;
  mode: CalendarFeedsMode;
  setMode: (mode: CalendarFeedsMode) => void;
  onRevoke: (id: string) => Promise<void>;
  onRegenerate: () => Promise<void>;
}) {
  const { t } = useTranslation('calendar');
  const [pending, setPending] = useState(false);
  const confirming = mode.kind === 'confirming' && mode.id === feed.id ? mode.action : null;
  const actions = useRef<HTMLDivElement>(null);
  const cancel = () => {
    setMode({ kind: 'idle' });
    requestAnimationFrame(() => actions.current?.querySelector('button')?.focus());
  };
  const meta = [
    t('created', { date: formatDay(feed.createdAt, prefs, now) }),
    feed.lastUsedAt === null
      ? t('neverUsed')
      : t('lastUsed', { when: formatTimeAgo(feed.lastUsedAt, now, prefs.locale, t('justNow')) }),
  ];
  const confirm = async () => {
    setPending(true);
    try {
      if (confirming === 'revoke') {
        await onRevoke(feed.id);
        setMode({ kind: 'idle' });
      } else {
        await onRegenerate();
      }
    } catch {
      // Reported by the caller; the confirm stays open to retry.
    } finally {
      setPending(false);
    }
  };

  return (
    <li
      className="flex flex-col gap-3 border-b border-border py-3 last:border-b-0"
      data-testid="calendar-feed"
    >
      <div className="flex flex-col gap-3 tablet:flex-row tablet:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-bg-muted text-text-secondary">
            <CalendarDays className="size-4" strokeWidth={iconStrokeWidth} aria-hidden />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-sm font-medium">{name}</span>
            <span className="text-sm text-text-muted">{meta.join(' · ')}</span>
          </div>
        </div>
        {!confirming && (
          <div ref={actions} className="flex shrink-0 gap-1">
            <Button
              variant="ghost"
              size="sm"
              isDisabled={!online}
              onPress={() => setMode({ kind: 'confirming', id: feed.id, action: 'regenerate' })}
              aria-label={t('regenerateNamed', { name })}
            >
              {t('regenerate')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              isDisabled={!online}
              onPress={() => setMode({ kind: 'confirming', id: feed.id, action: 'revoke' })}
              aria-label={t('revokeNamed', { name })}
              data-testid="revoke-feed"
            >
              {t('revoke')}
            </Button>
          </div>
        )}
      </div>
      {confirming && (
        <InlinePanel onEscape={cancel}>
          <fieldset
            aria-label={
              confirming === 'revoke' ? t('revokeNamed', { name }) : t('regenerateNamed', { name })
            }
            className={cn(
              'flex flex-col gap-3 rounded-md px-3 py-3 tablet:flex-row tablet:items-center',
              confirming === 'revoke' ? 'bg-bg-danger-subtle' : 'bg-bg-warning-subtle',
            )}
          >
            <p
              className={cn(
                'flex-1 text-sm',
                confirming === 'revoke' ? 'text-text-danger' : 'text-text-warning',
              )}
            >
              {confirming === 'revoke'
                ? t('revokeConfirm', { name })
                : t('regenerateConfirm', { name })}
            </p>
            <div className="flex gap-2">
              <Button
                variant={confirming === 'revoke' ? 'danger' : 'primary'}
                size="sm"
                isLoading={pending}
                autoFocus
                onPress={() => void confirm()}
                data-testid="confirm-feed"
              >
                {confirming === 'revoke' ? t('revoke') : t('regenerate')}
              </Button>
              <Button size="sm" onPress={cancel}>
                {t('cancel')}
              </Button>
            </div>
          </fieldset>
        </InlinePanel>
      )}
    </li>
  );
}

function InlinePanel({ children, onEscape }: { children: ReactNode; onEscape: () => void }) {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.stopPropagation();
      onEscape();
    }
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape bubbles up from the panel's controls
    <div onKeyDown={onKeyDown}>{children}</div>
  );
}
