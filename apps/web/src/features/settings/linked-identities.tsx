import type { LinkedIdentity, RemovedIdentity } from '@rooster/core/schemas';
import { Ban, KeyRound } from 'lucide-react';
import { type KeyboardEvent, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import type { DisplayPrefs } from '../../lib/format';
import { Banner } from '../../ui/banner';
import { Button, iconStrokeWidth } from '../../ui/button';
import { formatGrantDate } from '../access/grant-summary';
import { SettingsSection } from './settings-section';

export type UnlinkOutcome = 'unlinked' | 'lastIdentity' | 'failed';

export interface LinkedIdentitiesSectionProps {
  /** Undefined while loading. */
  identities: readonly LinkedIdentity[] | undefined;
  error?: unknown;
  prefs: DisplayPrefs;
  now: number;
  /** Resolves with what happened; the confirm stays open unless it was unlinked. */
  onUnlink: (id: string) => Promise<UnlinkOutcome>;
  /** Kitchen sink: open the confirm for this identity. */
  initialConfirmingId?: string | undefined;
  /** Removed identities (blocked until allowed again); undefined while loading. */
  removed?: readonly RemovedIdentity[] | undefined;
  removedError?: unknown;
  /** Allows a removed identity again; resolves true when it was. */
  onAllow?: ((id: string) => Promise<boolean>) | undefined;
  /** Kitchen sink: open the "Allow again" confirm for this removed identity. */
  initialAllowingId?: string | undefined;
}

/**
 * Settings → Security → Linked identities (FR-SET-3, ADR 0041 §7): the sign-in providers that
 * reach this account. One can be unlinked after an inline confirm (no modal, 02 §1), but never
 * the last one: without it nobody could sign in (the server answers `409 last_identity`).
 * An unlinked identity is listed under "Removed sign-ins": it can't sign in (nor link again by
 * email) until the user allows it again, after another inline confirm.
 */
export function LinkedIdentitiesSection({
  identities,
  error,
  prefs,
  now,
  onUnlink,
  initialConfirmingId,
  removed,
  removedError,
  onAllow,
  initialAllowingId,
}: LinkedIdentitiesSectionProps) {
  const { t } = useTranslation('settings');
  const [confirming, setConfirming] = useState<string | null>(initialConfirmingId ?? null);
  const [pending, setPending] = useState(false);
  const [refused, setRefused] = useState(false);
  const list = [...(identities ?? [])].sort((a, b) => a.createdAt - b.createdAt);
  const onlyOne = list.length <= 1;
  const lastHintId = useId();

  return (
    <SettingsSection
      id="linked-identities"
      title={t('security.identities.title')}
      description={t('security.identities.body')}
    >
      {error ? (
        <Banner tone="danger" role="alert">
          {t('security.identities.loadFailed')}
        </Banner>
      ) : (
        <ul className="flex flex-col" data-testid="linked-identities">
          {list.map((identity) => {
            const label = identity.email
              ? t('security.identities.named', {
                  provider: identity.providerName,
                  email: identity.email,
                })
              : identity.providerName;
            const isConfirming = confirming === identity.id;
            return (
              <li
                key={identity.id}
                className="flex flex-col gap-3 border-b border-border py-3 last:border-b-0"
                data-testid={`identity-${identity.id}`}
              >
                <div className="flex items-center gap-3">
                  <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-bg-muted text-text-secondary">
                    <KeyRound className="size-4" strokeWidth={iconStrokeWidth} aria-hidden />
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{identity.providerName}</span>
                    <span className="truncate text-sm text-text-muted">
                      {[
                        identity.email,
                        t('security.identities.linked', {
                          date: formatGrantDate(identity.createdAt, prefs, now),
                        }),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </div>
                  {!isConfirming && (
                    <Button
                      variant="ghost"
                      size="sm"
                      isDisabled={onlyOne}
                      onPress={() => {
                        setRefused(false);
                        setConfirming(identity.id);
                      }}
                      aria-label={t('security.identities.unlinkNamed', { name: label })}
                      {...(onlyOne ? { 'aria-describedby': lastHintId } : {})}
                    >
                      {t('security.identities.unlink')}
                    </Button>
                  )}
                </div>
                {isConfirming && (
                  <InlineConfirm
                    label={t('security.identities.unlinkNamed', { name: label })}
                    message={
                      refused
                        ? t('security.identities.lastRefused')
                        : t('security.identities.unlinkConfirm', { name: label })
                    }
                    confirmLabel={t('security.identities.unlink')}
                    tone="danger"
                    pending={pending}
                    refused={refused}
                    testId="confirm-unlink"
                    onCancel={() => setConfirming(null)}
                    onConfirm={async () => {
                      setPending(true);
                      try {
                        const outcome = await onUnlink(identity.id);
                        if (outcome === 'unlinked') setConfirming(null);
                        else if (outcome === 'lastIdentity') setRefused(true);
                      } finally {
                        setPending(false);
                      }
                    }}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {identities && onlyOne && !error && (
        <p id={lastHintId} className="text-sm text-text-muted">
          {t('security.identities.lastHint')}
        </p>
      )}
      <RemovedIdentities
        removed={removed}
        error={removedError}
        prefs={prefs}
        now={now}
        onAllow={onAllow}
        initialAllowingId={initialAllowingId}
      />
    </SettingsSection>
  );
}

/** "Removed sign-ins": shown only when there are some (or they failed to load). */
function RemovedIdentities({
  removed,
  error,
  prefs,
  now,
  onAllow,
  initialAllowingId,
}: {
  removed: readonly RemovedIdentity[] | undefined;
  error: unknown;
  prefs: DisplayPrefs;
  now: number;
  onAllow: ((id: string) => Promise<boolean>) | undefined;
  initialAllowingId: string | undefined;
}) {
  const { t } = useTranslation('settings');
  const [allowing, setAllowing] = useState<string | null>(initialAllowingId ?? null);
  const [pending, setPending] = useState(false);
  const titleId = useId();
  if (!error && (removed === undefined || removed.length === 0)) return null;
  const list = [...(removed ?? [])].sort((a, b) => b.removedAt - a.removedAt);
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-2 pt-2">
      <div className="flex flex-col gap-1">
        <h3 id={titleId} className="text-sm font-semibold">
          {t('security.identities.removed.title')}
        </h3>
        <p className="text-sm text-text-secondary">{t('security.identities.removed.body')}</p>
      </div>
      {error ? (
        <Banner tone="danger" role="alert">
          {t('security.identities.removed.loadFailed')}
        </Banner>
      ) : (
        <ul className="flex flex-col" data-testid="removed-identities">
          {list.map((identity) => {
            const label = identity.email
              ? t('security.identities.named', {
                  provider: identity.providerName,
                  email: identity.email,
                })
              : identity.providerName;
            const isConfirming = allowing === identity.id;
            return (
              <li
                key={identity.id}
                className="flex flex-col gap-3 border-b border-border py-3 last:border-b-0"
                data-testid={`removed-identity-${identity.id}`}
              >
                <div className="flex items-center gap-3">
                  <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-bg-muted text-text-muted">
                    <Ban className="size-4" strokeWidth={iconStrokeWidth} aria-hidden />
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium text-text-secondary">
                      {identity.providerName}
                    </span>
                    <span className="truncate text-sm text-text-muted">
                      {[
                        identity.email,
                        t('security.identities.removed.removedOn', {
                          date: formatGrantDate(identity.removedAt, prefs, now),
                        }),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </div>
                  {!isConfirming && onAllow && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onPress={() => setAllowing(identity.id)}
                      aria-label={t('security.identities.removed.allowNamed', { name: label })}
                    >
                      {t('security.identities.removed.allow')}
                    </Button>
                  )}
                </div>
                {isConfirming && onAllow && (
                  <InlineConfirm
                    label={t('security.identities.removed.allowNamed', { name: label })}
                    message={t('security.identities.removed.allowConfirm', { name: label })}
                    confirmLabel={t('security.identities.removed.allow')}
                    tone="neutral"
                    pending={pending}
                    refused={false}
                    testId="confirm-allow"
                    onCancel={() => setAllowing(null)}
                    onConfirm={async () => {
                      setPending(true);
                      try {
                        if (await onAllow(identity.id)) setAllowing(null);
                      } finally {
                        setPending(false);
                      }
                    }}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** An inline confirm under a row (02 §1: no modal); Escape cancels. */
function InlineConfirm({
  label,
  message,
  confirmLabel,
  tone,
  pending,
  refused,
  testId,
  onCancel,
  onConfirm,
}: {
  label: string;
  message: string;
  confirmLabel: string;
  tone: 'danger' | 'neutral';
  pending: boolean;
  /** The action was refused: the message explains why, and only Cancel remains. */
  refused: boolean;
  testId: string;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const { t } = useTranslation('settings');
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.stopPropagation();
      onCancel();
    }
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape bubbles up from the confirm's buttons
    <div onKeyDown={onKeyDown}>
      <fieldset
        aria-label={label}
        className={cn(
          'flex flex-col gap-3 rounded-md px-3 py-3 tablet:flex-row tablet:items-center',
          tone === 'danger' ? 'bg-bg-danger-subtle' : 'bg-bg-subtle',
        )}
      >
        <p
          className={cn('flex-1 text-sm', tone === 'danger' ? 'text-text-danger' : 'text-text')}
          role={refused ? 'alert' : undefined}
        >
          {message}
        </p>
        <div className="flex gap-2">
          {!refused && (
            <Button
              variant={tone === 'danger' ? 'danger' : 'primary'}
              size="sm"
              isLoading={pending}
              autoFocus
              onPress={() => void onConfirm()}
              data-testid={testId}
            >
              {confirmLabel}
            </Button>
          )}
          <Button size="sm" onPress={onCancel} autoFocus={refused}>
            {t('access.cancel')}
          </Button>
        </div>
      </fieldset>
    </div>
  );
}
