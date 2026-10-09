import type { LinkedIdentity } from '@rooster/core/schemas';
import { KeyRound } from 'lucide-react';
import { type KeyboardEvent, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
}

/**
 * Settings → Security → Linked identities (FR-SET-3, ADR 0041 §7): the sign-in providers that
 * reach this account. One can be unlinked after an inline confirm (no modal, 02 §1), but never
 * the last one: without it nobody could sign in (the server answers `409 last_identity`).
 */
export function LinkedIdentitiesSection({
  identities,
  error,
  prefs,
  now,
  onUnlink,
  initialConfirmingId,
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
                  <UnlinkConfirm
                    label={label}
                    pending={pending}
                    refused={refused}
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
    </SettingsSection>
  );
}

function UnlinkConfirm({
  label,
  pending,
  refused,
  onCancel,
  onConfirm,
}: {
  label: string;
  pending: boolean;
  refused: boolean;
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
        aria-label={t('security.identities.unlinkNamed', { name: label })}
        className="flex flex-col gap-3 rounded-md bg-bg-danger-subtle px-3 py-3 tablet:flex-row tablet:items-center"
      >
        <p className="flex-1 text-sm text-text-danger" role={refused ? 'alert' : undefined}>
          {refused
            ? t('security.identities.lastRefused')
            : t('security.identities.unlinkConfirm', { name: label })}
        </p>
        <div className="flex gap-2">
          {!refused && (
            <Button
              variant="danger"
              size="sm"
              isLoading={pending}
              autoFocus
              onPress={() => void onConfirm()}
              data-testid="confirm-unlink"
            >
              {t('security.identities.unlink')}
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
